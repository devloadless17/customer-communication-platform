/**
 * In-app call transcription — the ORCHESTRATOR and its recovery sweeper,
 * driven against the real database and blob storage with the STT adapter
 * mocked.
 *
 * What this pins, and why each is worth a test:
 *   - the whole-file fallback document (flat text, no invented speakers), the
 *     `transcriptKey` CAS, ISO-normalized `transcriptLanguage`, and the
 *     publish-only-on-CAS-win rule;
 *   - "nothing survived ⇒ store NOTHING" — an absent transcript is honest, a
 *     hallucinated one reads as fact;
 *   - the mix_ladder_exhausted sentinel: audio the ladder already rejected is
 *     never re-transcribed through a second billed whole-file pass;
 *   - the recovery classifications: a `.raw` interim on an ended call is
 *     finalized, a finalized recording with no transcript is re-transcribed,
 *     a transcription-only workspace's leftover audio is discarded — the
 *     three ways an API restart / tab crash / STT outage used to mean
 *     PERMANENT silent loss (there is no upstream copy of in-app audio);
 *   - `deriveTranscriptPending` agrees with the sweeper's horizon.
 *
 *   pnpm --filter @ccp/api exec vitest run test/call-inapp-recovery.spec.ts
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { setSharedDb } from "@/lib/db";
import { createTestPrismaClient } from "./_prisma";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

vi.mock("@/lib/ai/voice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/voice")>();
  return { ...actual, transcribeCallChannel: vi.fn() };
});

import { transcribeCallChannel } from "@/lib/ai/voice";
import {
  finalizeInAppRecording,
  transcribeInAppCallRecording,
} from "@/lib/media/call-recording-download";
import {
  deriveTranscriptPending,
  INAPP_TRANSCRIPT_RETRY_HORIZON_MS,
} from "@/lib/media/call-artifact-policy";
import {
  __testing__ as sweeper,
  resetCallRecordingSweeperStateForTests,
} from "@/lib/sweepers/call-recordings";
import { blobStorage } from "@/lib/blob-storage";

const stt = vi.mocked(transcribeCallChannel);
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

const S = `car${Date.now().toString().slice(-8)}`;

let orgId = "";
let workspaceId = "";
let conversationId = "";
let connectionId = "";
const storedKeys: string[] = [];

/** Ended long enough ago to clear the sweeper's settle grace (10 min). */
const ENDED_AT = new Date(Date.now() - 30 * 60 * 1000);

async function makeCall(tag: string): Promise<string> {
  return (
    await prisma.call.create({
      data: {
        workspaceId,
        conversationId,
        externalCallId: `${S}_${tag}`,
        direction: "out",
        status: "completed",
        ringingAt: ENDED_AT,
        answeredAt: ENDED_AT,
        endedAt: ENDED_AT,
        durationSeconds: 30,
        rawPayload: {},
      },
      select: { id: true },
    })
  ).id;
}

function whisper(text: string, language = "arabic") {
  return {
    text,
    language,
    segments: [
      {
        start: 0,
        end: 3,
        text,
        no_speech_prob: 0.01,
        avg_logprob: -0.2,
        compression_ratio: 1.4,
      },
    ],
    model: "whisper-1",
  };
}

const EMPTY_STT = { text: "", language: "arabic", segments: [], model: "whisper-1" };

async function setPolicy(policy: {
  recording: boolean;
  transcription: boolean;
}): Promise<void> {
  await prisma.channelConnection.update({
    where: { id: connectionId },
    data: {
      config: {
        callRecording: { enabled: policy.recording },
        callTranscription: { enabled: policy.transcription },
      },
    },
  });
}

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `CAR Org ${S}`, status: "active" },
  });
  orgId = org.id;
  workspaceId = (
    await prisma.workspace.create({
      data: { name: `CAR WS ${S}`, organizationId: orgId },
    })
  ).id;
  connectionId = (
    await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: `${S}_phone`,
        isDefault: true,
        config: {
          callRecording: { enabled: true },
          callTranscription: { enabled: true },
        },
      },
      select: { id: true },
    })
  ).id;
  const contact = await prisma.contact.create({
    data: {
      workspaceId,
      name: "CAR Contact",
      identityChannel: "whatsapp",
      phoneNumber: `9615${Date.now().toString().slice(-6)}`,
    },
  });
  conversationId = (
    await prisma.conversation.create({
      data: {
        workspaceId,
        contactId: contact.id,
        channel: "whatsapp",
        status: "open",
        channelConnectionId: connectionId,
      },
      select: { id: true },
    })
  ).id;
  // The orchestrator's gate: transcription runs only for a workspace whose AI
  // assistant is configured — a real row, not a mock, so the gate itself is
  // exercised.
  await prisma.aiAssistantConfig.create({
    data: {
      workspaceId,
      enabled: true,
      defaultLanguage: "ar",
      supportedLanguages: ["ar", "en"],
    },
  });
});

afterAll(async () => {
  if (storedKeys.length) await blobStorage.delete(storedKeys).catch(() => undefined);
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  stt.mockReset();
  resetCallRecordingSweeperStateForTests();
  await setPolicy({ recording: true, transcription: true });
});

describe("transcribeInAppCallRecording — the orchestrator", () => {
  it("stores the whole-file fallback as an HONEST flat document: CAS, ISO language, publish", async () => {
    const callId = await makeCall("flat");
    stt.mockResolvedValue(whisper("مرحبا، بدي اسأل عن طلبي."));

    // Non-audio bytes: the channel split fails, so this exercises the
    // whole-file fallback (split unavailable ⇒ the ladder's first look).
    const ok = await transcribeInAppCallRecording(
      callId,
      new TextEncoder().encode(`NOT_AUDIO_${S}`),
      "audio/ogg",
    );
    expect(ok).toBe(true);

    const row = await prisma.call.findUnique({
      where: { id: callId },
      select: { transcriptKey: true, transcriptLanguage: true },
    });
    expect(row?.transcriptKey).toBe(`call-transcripts/${workspaceId}/${callId}.json`);
    storedKeys.push(row!.transcriptKey!);
    // whisper answers a language NAME ("arabic"); the column promises ISO.
    expect(row?.transcriptLanguage).toBe("ar");

    const doc = JSON.parse(
      Buffer.from((await blobStorage.fetch(row!.transcriptKey!)).bytes).toString("utf8"),
    ) as {
      metadata: { source: string; channels: string; dialect_repaired: boolean };
      transcript: { text: string; language: string | null; segments: unknown[]; raw_text?: string };
    };
    expect(doc.metadata.source).toBe("inapp");
    // A mix carries no speaker knowledge — the document must say so rather
    // than filing every word under one name.
    expect(doc.metadata.channels).toBe("mixed");
    expect(doc.transcript.segments).toEqual([]);
    expect(doc.transcript.text).toContain("طلبي");
    // No repair ran (no OpenAI key in the test env) ⇒ no raw_text duplicate.
    expect(doc.metadata.dialect_repaired).toBe(false);
    expect(doc.transcript.raw_text).toBeUndefined();

    const frames = await prisma.outboundEvent.findMany({
      where: { workspaceId, type: "call.artifacts_changed" },
      select: { payload: true },
    });
    expect(
      frames.some((f) => (f.payload as { callId?: string }).callId === callId),
      "the CAS win must announce the transcript to open inboxes",
    ).toBe(true);

    // Idempotence: a re-run (the sweeper retrying a row whose transcript
    // already landed) short-circuits without a single model call.
    stt.mockClear();
    await expect(transcribeInAppCallRecording(callId)).resolves.toBe(true);
    expect(stt).not.toHaveBeenCalled();
  });

  it("stores NOTHING when no channel survives the ladder", async () => {
    const callId = await makeCall("nothing");
    stt.mockResolvedValue(EMPTY_STT);

    const ok = await transcribeInAppCallRecording(
      callId,
      new TextEncoder().encode(`NOT_AUDIO_EMPTY_${S}`),
      "audio/ogg",
    );
    expect(ok).toBe(false);
    const row = await prisma.call.findUnique({
      where: { id: callId },
      select: { transcriptKey: true, transcriptLanguage: true },
    });
    expect(row?.transcriptKey, "an empty result must not write a document").toBeNull();
    expect(row?.transcriptLanguage).toBeNull();
  });

  it("re-drives itself from the stored recording when no bytes are passed", async () => {
    // The recovery contract: after an API restart the detached .then() is
    // gone, so the sweeper re-invokes with nothing but the callId.
    const callId = await makeCall("refetch");
    const key = `call-recordings/${workspaceId}/${callId}.ogg`;
    await blobStorage.putObject({
      key,
      bytes: new TextEncoder().encode(`NOT_AUDIO_REFETCH_${S}`),
      contentType: "audio/ogg",
    });
    storedKeys.push(key);
    await prisma.call.update({
      where: { id: callId },
      data: { recordingKey: key, recordingMimeType: "audio/ogg" },
    });
    stt.mockResolvedValue(whisper("الو، مين معي؟"));

    await expect(transcribeInAppCallRecording(callId)).resolves.toBe(true);
    const row = await prisma.call.findUnique({
      where: { id: callId },
      select: { transcriptKey: true },
    });
    expect(row?.transcriptKey).not.toBeNull();
    storedKeys.push(row!.transcriptKey!);
  });

  it.skipIf(!hasFfmpeg)(
    "labels a real stereo recording per speaker in the stored document",
    async () => {
      const callId = await makeCall("speakers");
      const stereo = spawnSync(
        "ffmpeg",
        [
          "-hide_banner", "-v", "error",
          "-f", "lavfi", "-i", "sine=frequency=300:duration=3:sample_rate=48000",
          "-f", "lavfi", "-i", "sine=frequency=1200:duration=3:sample_rate=48000",
          "-filter_complex", "[0:a][1:a]amerge=inputs=2[a]",
          "-map", "[a]", "-ac", "2", "-c:a", "libopus", "-f", "ogg", "pipe:1",
        ],
        { maxBuffer: 32 * 1024 * 1024 },
      );
      expect(stereo.status).toBe(0);
      stt.mockImplementation(async (opts) =>
        opts.filename.includes("-agent.")
          ? whisper("مرحبا، كيف فيني ساعدك؟")
          : whisper("بدي اسأل عن طلبي."),
      );

      await expect(
        transcribeInAppCallRecording(callId, new Uint8Array(stereo.stdout), "audio/ogg"),
      ).resolves.toBe(true);

      const row = await prisma.call.findUnique({
        where: { id: callId },
        select: { transcriptKey: true },
      });
      storedKeys.push(row!.transcriptKey!);
      const doc = JSON.parse(
        Buffer.from((await blobStorage.fetch(row!.transcriptKey!)).bytes).toString("utf8"),
      ) as {
        metadata: { channels: string };
        transcript: { text: string; segments: Array<{ speaker: string; text: string }> };
      };
      expect(doc.metadata.channels).toBe("per-speaker");
      expect(doc.transcript.segments.map((s) => s.speaker).sort()).toEqual([
        "Business",
        "Customer",
      ]);
      expect(doc.transcript.text).toMatch(/^Agent: /m);
      expect(doc.transcript.text).toMatch(/^Customer: /m);
    },
    60_000,
  );

  it.skipIf(!hasFfmpeg)(
    "never re-bills a second pass on audio the ladder already rejected (mix_ladder_exhausted)",
    async () => {
      // Mono-collapsed stereo (both legs identical) whose mix yields nothing:
      // the OLD code fell back to a whole-file pass over the SAME audio with
      // loosened thresholds — a second paid call to store what the stricter
      // gate refused.
      const callId = await makeCall("dup");
      const dup = spawnSync(
        "ffmpeg",
        [
          "-hide_banner", "-v", "error",
          "-f", "lavfi", "-i", "sine=frequency=440:duration=3:sample_rate=48000",
          "-f", "lavfi", "-i", "sine=frequency=440:duration=3:sample_rate=48000",
          "-filter_complex", "[0:a][1:a]amerge=inputs=2[a]",
          "-map", "[a]", "-ac", "2", "-c:a", "libopus", "-f", "ogg", "pipe:1",
        ],
        { maxBuffer: 32 * 1024 * 1024 },
      );
      expect(dup.status).toBe(0);
      stt.mockResolvedValue(EMPTY_STT);

      await expect(
        transcribeInAppCallRecording(callId, new Uint8Array(dup.stdout), "audio/ogg"),
      ).resolves.toBe(false);
      // The full ladder on the extracted mix (3 rungs) and NOT one call more.
      expect(stt).toHaveBeenCalledTimes(3);
      for (const call of stt.mock.calls) {
        expect(call[0].filename).toContain("mixed");
      }
    },
    60_000,
  );
});

describe("recovery sweeper — in-app rows", () => {
  it("classifies the three stuck states and leaves settled/live rows alone", async () => {
    const stuckRaw = await makeCall("selraw");
    const missingTranscript = await makeCall("seltr");
    const retentionLeak = await makeCall("seldis");
    const tooFresh = await makeCall("selfresh");
    const healthy = await makeCall("selok");

    const raw = `call-recordings/${workspaceId}/`;
    // Explicit backdated updatedAt on every fixture write: the selection has
    // an in-flight grace (a row touched moments ago may still have its own
    // detached transcription running), and these updates would otherwise
    // stamp `now` and hide the fixtures from the very query under test.
    const settled = new Date(Date.now() - 20 * 60 * 1000);
    await prisma.call.update({
      where: { id: stuckRaw },
      data: {
        recordingKey: `${raw}${stuckRaw}.raw`,
        recordingMimeType: "audio/webm",
        updatedAt: settled,
      },
    });
    await prisma.call.update({
      where: { id: missingTranscript },
      data: {
        recordingKey: `${raw}${missingTranscript}.ogg`,
        recordingMimeType: "audio/ogg",
        updatedAt: settled,
      },
    });
    await prisma.call.update({
      where: { id: retentionLeak },
      data: {
        recordingKey: `${raw}${retentionLeak}.ogg`,
        recordingMimeType: "audio/ogg",
        transcriptKey: `call-transcripts/${workspaceId}/${retentionLeak}.json`,
        updatedAt: settled,
      },
    });
    // Ended seconds ago: the browser's own final upload may still be running.
    await prisma.call.update({
      where: { id: tooFresh },
      data: {
        endedAt: new Date(),
        recordingKey: `${raw}${tooFresh}.raw`,
        recordingMimeType: "audio/webm",
        updatedAt: settled,
      },
    });
    // `healthy` has no recording at all — never a candidate.

    // Widened slice (test seam): the production tick takes 5 rows, and on a
    // shared dev database foreign candidates could evict this spec's fixtures
    // from a 5-row batch — the CLASSIFICATION is what's under test, not the
    // budget.
    const batch = await sweeper.selectRetriable(50);
    const mine = new Map(
      batch.inApp
        .filter((r) =>
          [stuckRaw, missingTranscript, retentionLeak, tooFresh, healthy].includes(r.id),
        )
        .map((r) => [r.id, r.kind]),
    );
    expect(mine.get(stuckRaw)).toBe("finalize");
    expect(mine.get(missingTranscript)).toBe("transcribe");
    expect(mine.get(retentionLeak)).toBe("discard");
    expect(mine.has(tooFresh), "a just-ended call is still settling").toBe(false);
    expect(mine.has(healthy)).toBe(false);

    // The account resolution rides the THREAD (Call has no account column).
    const row = batch.inApp.find((r) => r.id === stuckRaw);
    expect(row?.channelConnectionId).toBe(connectionId);

    // Tidy: these synthetic keys never had bytes; null them so later tests'
    // selections don't re-see them.
    await prisma.call.updateMany({
      where: { id: { in: [stuckRaw, missingTranscript, retentionLeak, tooFresh] } },
      data: { recordingKey: null, recordingMimeType: null, transcriptKey: null },
    });
  });

  it.skipIf(!hasFfmpeg)(
    "finalizes a stuck interim: remux → playable → transcribed — the tab-crash rescue",
    async () => {
      const callId = await makeCall("fin");
      const rawKey = `call-recordings/${workspaceId}/${callId}.raw`;
      const src = spawnSync(
        "ffmpeg",
        ["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ac", "2",
         "-c:a", "libopus", "-f", "ogg", "pipe:1"],
        { maxBuffer: 32 * 1024 * 1024 },
      );
      expect(src.status).toBe(0);
      await blobStorage.putObject({
        key: rawKey,
        bytes: new Uint8Array(src.stdout),
        contentType: "audio/ogg",
      });
      storedKeys.push(rawKey);
      await prisma.call.update({
        where: { id: callId },
        data: { recordingKey: rawKey, recordingMimeType: "audio/ogg" },
      });
      stt.mockResolvedValue(whisper("الو؟ انقطع الخط قبل شوي."));

      await sweeper.processInAppRow({
        id: callId,
        kind: "finalize",
        workspaceId,
        channel: "whatsapp",
        channelConnectionId: connectionId,
      });
      // Transcription is detached from the finalize path (same code as a
      // browser final upload) — give it a beat.
      await vi.waitFor(async () => {
        const row = await prisma.call.findUnique({
          where: { id: callId },
          select: { transcriptKey: true },
        });
        expect(row?.transcriptKey).not.toBeNull();
      }, { timeout: 10_000 });

      const row = await prisma.call.findUnique({
        where: { id: callId },
        select: { recordingKey: true, recordingMimeType: true, transcriptKey: true },
      });
      expect(row?.recordingKey, "the interim must become a playable .ogg").toBe(
        `call-recordings/${workspaceId}/${callId}.ogg`,
      );
      expect(row?.recordingMimeType).toBe("audio/ogg");
      storedKeys.push(row!.recordingKey!, row!.transcriptKey!);
    },
    60_000,
  );

  it("re-transcribes a finalized recording whose transcript was lost, honoring transcription-only retention", async () => {
    // Policy says: transcribe, do NOT keep audio. The API died after the
    // final upload — recording stored, transcript never written, audio
    // retained against the workspace's wish. One sweep must fix BOTH.
    await setPolicy({ recording: false, transcription: true });
    const callId = await makeCall("retr");
    const key = `call-recordings/${workspaceId}/${callId}.ogg`;
    await blobStorage.putObject({
      key,
      bytes: new TextEncoder().encode(`NOT_AUDIO_RETR_${S}`),
      contentType: "audio/ogg",
    });
    storedKeys.push(key);
    await prisma.call.update({
      where: { id: callId },
      data: { recordingKey: key, recordingMimeType: "audio/ogg" },
    });
    stt.mockResolvedValue(whisper("مرحبا، هيدا الاتصال المفقود."));

    await sweeper.processInAppRow({
      id: callId,
      kind: "transcribe",
      workspaceId,
      channel: "whatsapp",
      channelConnectionId: connectionId,
    });

    const row = await prisma.call.findUnique({
      where: { id: callId },
      select: { recordingKey: true, transcriptKey: true },
    });
    expect(row?.transcriptKey, "the lost transcript must be recovered").not.toBeNull();
    storedKeys.push(row!.transcriptKey!);
    expect(
      row?.recordingKey,
      "transcription-only policy: the audio must be discarded once the transcript exists",
    ).toBeNull();
  });

  it("spends no STT on a workspace whose transcription policy is off", async () => {
    await setPolicy({ recording: true, transcription: false });
    const callId = await makeCall("off");
    const key = `call-recordings/${workspaceId}/${callId}.ogg`;
    await prisma.call.update({
      where: { id: callId },
      data: { recordingKey: key, recordingMimeType: "audio/ogg" },
    });

    await sweeper.processInAppRow({
      id: callId,
      kind: "transcribe",
      workspaceId,
      channel: "whatsapp",
      channelConnectionId: connectionId,
    });
    expect(stt).not.toHaveBeenCalled();
    const row = await prisma.call.findUnique({
      where: { id: callId },
      select: { transcriptKey: true, recordingKey: true },
    });
    expect(row?.transcriptKey).toBeNull();
    expect(row?.recordingKey, "a recording-only workspace keeps its audio").toBe(key);
    await prisma.call.update({
      where: { id: callId },
      data: { recordingKey: null, recordingMimeType: null },
    });
  });

  it("discards retention-leaked audio only when the policy is transcription-only", async () => {
    await setPolicy({ recording: false, transcription: true });
    const callId = await makeCall("leak");
    const key = `call-recordings/${workspaceId}/${callId}.ogg`;
    await blobStorage.putObject({
      key,
      bytes: new TextEncoder().encode(`NOT_AUDIO_LEAK_${S}`),
      contentType: "audio/ogg",
    });
    storedKeys.push(key);
    const transcriptKey = `call-transcripts/${workspaceId}/${callId}.json`;
    await prisma.call.update({
      where: { id: callId },
      data: {
        recordingKey: key,
        recordingMimeType: "audio/ogg",
        transcriptKey,
      },
    });

    await sweeper.processInAppRow({
      id: callId,
      kind: "discard",
      workspaceId,
      channel: "whatsapp",
      channelConnectionId: connectionId,
    });
    const row = await prisma.call.findUnique({
      where: { id: callId },
      select: { recordingKey: true, transcriptKey: true },
    });
    expect(row?.recordingKey, "the workspace said don't record calls").toBeNull();
    expect(row?.transcriptKey).toBe(transcriptKey);
  });
});

describe("deriveTranscriptPending — the hydrated 'Transcribing…' state", () => {
  const cfg = { callTranscription: { enabled: true } };
  const base = {
    recordingKey: "call-recordings/w/c.ogg",
    transcriptKey: null,
    endedAt: new Date(Date.now() - 60_000),
    channelConnectionConfig: cfg,
  };

  it("is true exactly while the sweeper still owes a transcript", () => {
    expect(deriveTranscriptPending(base)).toBe(true);
    expect(deriveTranscriptPending({ ...base, transcriptKey: "k" })).toBe(false);
    expect(deriveTranscriptPending({ ...base, recordingKey: null })).toBe(false);
    expect(deriveTranscriptPending({ ...base, endedAt: null })).toBe(false);
    expect(
      deriveTranscriptPending({
        ...base,
        channelConnectionConfig: { callTranscription: { enabled: false } },
      }),
    ).toBe(false);
    expect(deriveTranscriptPending({ ...base, channelConnectionConfig: null })).toBe(false);
  });

  it("goes false past the sweeper's retry horizon — a chip nobody will resolve is a lie", () => {
    expect(
      deriveTranscriptPending({
        ...base,
        endedAt: new Date(Date.now() - INAPP_TRANSCRIPT_RETRY_HORIZON_MS - 60_000),
      }),
    ).toBe(false);
  });
});
