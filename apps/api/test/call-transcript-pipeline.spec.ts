/**
 * The composite call-transcription pipeline — retry ladder, quality gates and
 * per-speaker/mix routing — with the STT adapter mocked.
 *
 * The pure predicates (`looksLikeRepetitionLoop` etc.) have their own spec;
 * what shipped three separate incidents was the code BETWEEN them: which gate
 * runs when, what a rejection retries with, and where a failed rendering is
 * allowed to fall. Two of those decisions are pinned here because they were
 * live bugs found by the 2026-08-10 audit:
 *
 *   - the crosstalk guard used to FALL THROUGH when the mix re-transcription
 *     came back empty, storing exactly the "agent and customer each say every
 *     line" dialogue it had just rejected;
 *   - the duplicated-mono path used to return null, which sent the SAME audio
 *     through a second billed whole-file pass under loosened thresholds.
 *
 * No network: `transcribeCallChannel` is a vi.mock. ffmpeg is real for the
 * `transcribePerSpeaker` block (same lavfi synthesis as
 * call-channel-split.spec.ts) and unused for the `transcribeOneChannel` block.
 *
 *   pnpm --filter @ccp/api exec vitest run test/call-transcript-pipeline.spec.ts
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { beforeEach, describe, expect, it, vi } from "vitest";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

vi.mock("@/lib/ai/voice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/voice")>();
  return { ...actual, transcribeCallChannel: vi.fn() };
});

import { transcribeCallChannel } from "@/lib/ai/voice";
import { __testing__ } from "@/lib/media/call-recording-download";
import type { TranscriptionSegment } from "@/lib/ai/openai-client";

const { transcribeOneChannel, transcribePerSpeaker } = __testing__;
const stt = vi.mocked(transcribeCallChannel);

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

/** A whisper-quality segment that passes every gate unless overridden. */
function seg(text: string, over: Partial<TranscriptionSegment> = {}): TranscriptionSegment {
  return {
    start: 0,
    end: 2,
    text,
    no_speech_prob: 0.01,
    avg_logprob: -0.2,
    compression_ratio: 1.4,
    ...over,
  };
}

function sttResult(
  segments: TranscriptionSegment[],
  language = "arabic",
): Awaited<ReturnType<typeof transcribeCallChannel>> {
  return {
    text: segments.map((s) => s.text).join(" "),
    language,
    segments,
    model: "whisper-1",
  };
}

const POLICY = {
  supported: ["ar", "en"],
  fallback: "ar",
  prompt: "مرحبا، كيفك؟ هلق منيح.",
};

/** Channel audio stub — bytes are opaque to the mocked adapter. */
function audio(speechSeconds: number, meanVolumeDb = -25) {
  return { bytes: new Uint8Array([1, 2, 3]), meanVolumeDb, speechSeconds };
}

beforeEach(() => {
  stt.mockReset();
});

describe("transcribeOneChannel", () => {
  it("makes NO API call for a channel below the speech gate", async () => {
    const res = await transcribeOneChannel(
      { speaker: "Customer", label: "customer", audio: audio(0.2) },
      "call_gate",
      POLICY,
    );
    expect(res.segments).toEqual([]);
    expect(stt).not.toHaveBeenCalled();
  });

  it("escapes a repetition loop up the temperature ladder, pinning the fallback language", async () => {
    const loop = Array.from({ length: 25 }, () => "I want to ask you something.").join(" ");
    stt.mockResolvedValueOnce(sttResult([seg(loop)], "english"));
    stt.mockResolvedValueOnce(sttResult([seg("مرحبا، بدي اسأل عن طلبي.")]));

    const res = await transcribeOneChannel(
      { speaker: "Customer", label: "customer", audio: audio(5) },
      "call_loop",
      POLICY,
    );
    expect(res.segments).toHaveLength(1);
    expect(res.segments[0]!.text).toContain("طلبي");
    expect(stt).toHaveBeenCalledTimes(2);
    // The documented escape: re-decode hotter…
    expect(stt.mock.calls[0]![0].temperature).toBe(0);
    expect(stt.mock.calls[1]![0].temperature).toBe(0.4);
    // …and once the model's own output proved untrustworthy, pin the
    // workspace's language instead of trusting detection again.
    expect(stt.mock.calls[0]![0].language).toBeUndefined();
    expect(stt.mock.calls[1]![0].language).toBe("ar");
  });

  it("drops the PROMPT after a prompt echo instead of feeding the same bait back", async () => {
    // The worst failure class this pipeline has: the model returned our own
    // prompt as the "transcript" of a real call (e2643747). Retrying with the
    // prompt attached invites the identical echo.
    stt.mockResolvedValueOnce(sttResult([seg(POLICY.prompt)]));
    stt.mockResolvedValueOnce(sttResult([seg("الو، مين معي؟")]));

    const res = await transcribeOneChannel(
      { speaker: "Business", label: "agent", audio: audio(5) },
      "call_echo",
      POLICY,
    );
    expect(res.segments).toHaveLength(1);
    expect(stt.mock.calls[0]![0].prompt).toBe(POLICY.prompt);
    expect(stt.mock.calls[1]![0].prompt).toBeUndefined();
  });

  it("re-decodes pinned when the detected language is outside the workspace's set", async () => {
    // The Cyrillic-gibberish incident: real Lebanese stored as a language the
    // workspace does not speak, accepted because nothing checked detection.
    stt.mockResolvedValueOnce(sttResult([seg("самоһам булакиһанц")], "bashkir"));
    stt.mockResolvedValueOnce(sttResult([seg("كيف فيني ساعدك؟")]));

    const res = await transcribeOneChannel(
      { speaker: "Customer", label: "customer", audio: audio(5) },
      "call_lang",
      POLICY,
    );
    expect(res.segments[0]!.text).toContain("ساعدك");
    expect(stt.mock.calls[1]![0].language).toBe("ar");
  });

  it("trusts the waveform over the model once the gate measured solid speech", async () => {
    // A quiet-but-speaking leg measured no_speech_prob 0.9-ish. With ≥1.5s of
    // MEASURED speech the ceiling relaxes to 0.95 — deleting that speaker is
    // the costly error, not keeping a marginal segment.
    const marginal = seg("طيب، خلص، بشوفك بكرا.", {
      no_speech_prob: 0.9,
      avg_logprob: -1.8,
    });
    stt.mockResolvedValue(sttResult([marginal]));

    const solid = await transcribeOneChannel(
      { speaker: "Customer", label: "customer", audio: audio(3) },
      "call_solid",
      POLICY,
    );
    expect(solid.segments).toHaveLength(1);

    stt.mockClear();
    stt.mockResolvedValue(sttResult([marginal]));
    const thin = await transcribeOneChannel(
      { speaker: "Customer", label: "customer", audio: audio(0.6) },
      "call_thin",
      POLICY,
    );
    // Under 1.5s the strict gates hold; the same segment is rejected on every
    // rung and the channel comes back empty rather than stored on faith.
    expect(thin.segments).toEqual([]);
    expect(stt).toHaveBeenCalledTimes(3);
  });

  it("synthesizes one segment from flat text when the model returns none", async () => {
    // gpt-4o-transcribe models return {text} only. Filtering an always-empty
    // segments array silently discarded every channel — the pipeline must
    // degrade to the one unit the model does return.
    stt.mockResolvedValueOnce({
      text: "مرحبا، معك دعم المتجر.",
      language: "arabic",
      segments: [],
      model: "gpt-4o-transcribe",
    });
    const res = await transcribeOneChannel(
      { speaker: "Business", label: "agent", audio: audio(4) },
      "call_flat",
      POLICY,
    );
    expect(res.segments).toHaveLength(1);
    expect(res.segments[0]!.text).toContain("دعم");
  });

  it("returns EMPTY after the ladder runs out — nothing is stored on faith", async () => {
    const loop = Array.from({ length: 25 }, () => "so so so so.").join(" ");
    stt.mockResolvedValue(sttResult([seg(loop)], "english"));
    const res = await transcribeOneChannel(
      { speaker: "Customer", label: "customer", audio: audio(5) },
      "call_exhaust",
      POLICY,
    );
    expect(res.segments).toEqual([]);
    expect(stt).toHaveBeenCalledTimes(3);
  });
});

describe.skipIf(!hasFfmpeg)("transcribePerSpeaker", () => {
  /** Same encode as the browser recorder's server-side remux. */
  function buildStereo(leftFilter: string, rightFilter: string): Uint8Array {
    const r = spawnSync(
      "ffmpeg",
      [
        "-hide_banner", "-v", "error",
        "-f", "lavfi", "-i", leftFilter,
        "-f", "lavfi", "-i", rightFilter,
        "-filter_complex", "[0:a][1:a]amerge=inputs=2[a]",
        "-map", "[a]",
        "-map_metadata", "-1", "-ac", "2", "-ar", "48000",
        "-c:a", "libopus", "-b:a", "48k", "-f", "ogg", "pipe:1",
      ],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    expect(r.status, `ffmpeg failed: ${r.stderr.toString().slice(0, 300)}`).toBe(0);
    return new Uint8Array(r.stdout);
  }

  const DISTINCT = () =>
    buildStereo(
      "sine=frequency=300:duration=3:sample_rate=48000",
      "sine=frequency=1200:duration=3:sample_rate=48000",
    );
  const DUPLICATED = () =>
    buildStereo(
      "sine=frequency=440:duration=3:sample_rate=48000",
      "sine=frequency=440:duration=3:sample_rate=48000",
    );

  /** Route the mock by the leg encoded in the filename the pipeline builds
   *  (`call-<id>-<label>.<ext>`). */
  function mockByLeg(byLeg: {
    agent?: TranscriptionSegment[];
    customer?: TranscriptionSegment[];
    mixed?: TranscriptionSegment[];
  }) {
    stt.mockImplementation(async (opts) => {
      const label = /call-.*-(agent|customer|mixed)\./.exec(opts.filename)?.[1] as
        | "agent"
        | "customer"
        | "mixed"
        | undefined;
      return sttResult(byLeg[label ?? "mixed"] ?? []);
    });
  }

  it("labels two real legs as one Agent turn and one Customer turn, ordered by first speech", async () => {
    mockByLeg({
      agent: [seg("مرحبا، كيف فيني ساعدك؟", { start: 0.5, end: 2 })],
      customer: [seg("بدي اسأل عن طلبي.", { start: 3, end: 5 })],
    });
    const res = await transcribePerSpeaker(DISTINCT(), "call_two", POLICY);
    expect(res).not.toBeNull();
    expect(res).not.toBe("mix_ladder_exhausted");
    const ok = res as Exclude<typeof res, string | null>;
    expect(ok.segments.map((s) => s.speaker)).toEqual(["Business", "Customer"]);
    expect(ok.text).toBe("Agent: مرحبا، كيف فيني ساعدك؟\nCustomer: بدي اسأل عن طلبي.");
    // Exactly one STT call per leg — the mix is not transcribed when the
    // split stands on its own.
    expect(stt).toHaveBeenCalledTimes(2);
  }, 60_000);

  it("keeps a one-sided call as a single labelled speaker", async () => {
    mockByLeg({ agent: [seg("مرحبا؟ ما حدا عم يرد.")] });
    const res = await transcribePerSpeaker(DISTINCT(), "call_one", POLICY);
    const ok = res as Exclude<typeof res, string | null>;
    expect(ok.segments).toHaveLength(1);
    expect(ok.segments[0]!.speaker).toBe("Business");
  }, 60_000);

  it("uses the UNLABELLED mix when the two legs echo each other", async () => {
    // Both devices in one room: each leg hears both voices and the two sides
    // transcribe to the same words. Presenting that as a dialogue shows each
    // speaker saying every line.
    const echoText = "مرحبا كيفك؟ منيح الحمدلله. بدي اسأل عن طلبي اذا بتريد.";
    mockByLeg({
      agent: [seg(echoText)],
      customer: [seg(echoText + " تمام.")],
      mixed: [seg(echoText)],
    });
    const res = await transcribePerSpeaker(DISTINCT(), "call_echo2", POLICY);
    const ok = res as Exclude<typeof res, string | null>;
    expect(ok.segments, "no attribution may be invented from crosstalk").toEqual([]);
    expect(ok.text).toContain("طلبي");
  }, 60_000);

  it("NEVER stores the crosstalk split when the mix fails too (the fall-through bug)", async () => {
    // The audit's P0 finding: overlap >70% + an empty mix used to fall
    // through to the turn assembly and store the invalid labelled dialogue.
    const echoText = "مرحبا كيفك؟ منيح الحمدلله. بدي اسأل عن طلبي اذا بتريد.";
    mockByLeg({
      agent: [seg(echoText)],
      customer: [seg(echoText + " تمام.")],
      mixed: [], // empty text on every rung → the ladder rejects the mix
    });
    const res = await transcribePerSpeaker(DISTINCT(), "call_fallthrough", POLICY);
    expect(res).toBe("mix_ladder_exhausted");
  }, 60_000);

  it("routes duplicated (mono-collapsed) channels straight to the mix, once", async () => {
    mockByLeg({ mixed: [seg("مرحبا، هيدا تسجيل موحد.")] });
    const res = await transcribePerSpeaker(DUPLICATED(), "call_dup", POLICY);
    const ok = res as Exclude<typeof res, string | null>;
    expect(ok.segments).toEqual([]);
    expect(ok.text).toContain("تسجيل");
    // One decode: the legs are the same audio, transcribing them separately
    // would double the spend to learn nothing.
    expect(stt).toHaveBeenCalledTimes(1);
    expect(stt.mock.calls[0]![0].filename).toContain("mixed");
  }, 60_000);

  it("reports mix_ladder_exhausted for duplicated channels with no usable speech — no second pass", async () => {
    mockByLeg({}); // every leg empty on every rung
    const res = await transcribePerSpeaker(DUPLICATED(), "call_dup_empty", POLICY);
    expect(res).toBe("mix_ladder_exhausted");
    // The full ladder on the mix and NOTHING else — the caller must not
    // re-transcribe the same audio under loosened thresholds.
    expect(stt).toHaveBeenCalledTimes(3);
    for (const call of stt.mock.calls) {
      expect(call[0].filename).toContain("mixed");
    }
  }, 60_000);

  it("gives the mix one gated pass when BOTH legs were discarded", async () => {
    // An echo canceller can mangle each isolated leg while the mix stays
    // clean — the mix is a different signal, worth one try before giving up.
    mockByLeg({ mixed: [seg("الو؟ اي عم بسمعك هلق.")] });
    const res = await transcribePerSpeaker(DISTINCT(), "call_legs_dead", POLICY);
    const ok = res as Exclude<typeof res, string | null>;
    expect(ok.segments).toEqual([]);
    expect(ok.text).toContain("بسمعك");
  }, 60_000);

  it("returns null (split unavailable) for a mono source so the caller may fall back", async () => {
    const r = spawnSync(
      "ffmpeg",
      [
        "-hide_banner", "-v", "error",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=48000",
        "-ac", "1", "-c:a", "libopus", "-f", "ogg", "pipe:1",
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    expect(r.status).toBe(0);
    const res = await transcribePerSpeaker(new Uint8Array(r.stdout), "call_mono", POLICY);
    expect(res).toBeNull();
    expect(stt).not.toHaveBeenCalled();
  }, 60_000);
});
