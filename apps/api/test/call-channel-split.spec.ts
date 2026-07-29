/**
 * Per-speaker call transcription — the channel split it stands on.
 *
 * THE BUG (2026-07-29, reported from a live call): the agent said "hello, test
 * test" and the stored transcript read only "Hello?". Transcribing the MIXED
 * stereo master loses a whole speaker — measured against `gpt-4o-transcribe`
 * with the two legs bleeding into each other at a realistic -30 dB, the mix
 * transcribed the agent's line and dropped the customer's entirely, while the
 * same audio split per channel transcribed both correctly. The browser mixer
 * already puts the agent on the LEFT and the customer on the RIGHT precisely so
 * this separation is possible.
 *
 * These tests pin the split, not the model: real ffmpeg, synthesised audio with
 * KNOWN different content per channel, asserting that
 *   - each channel is ISOLATED (`pan`), never downmixed — a sum would put both
 *     speakers back into both sides and reinstate the bug;
 *   - an empty far end is DETECTED as silence so it is never sent to a speech
 *     model (which would invent text for it);
 *   - a mono source returns null so the caller falls back to a whole-file pass.
 *
 *   pnpm --filter @ccp/api exec vitest run test/call-channel-split.spec.ts
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

import { extractCallChannels } from "@/lib/media/audio-transcode";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

/** Build stereo OGG/Opus through the SAME encode the call pipeline uses. */
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

/** Rough pitch of a mono 16 kHz WAV by zero-crossing rate. Enough to prove
 *  WHICH tone survived in a channel — the only way to tell isolation from a
 *  downmix without a real spectral analyser. */
function dominantHz(wav: Uint8Array): number {
  // 16-bit mono PCM: skip the 44-byte header and count sign changes.
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let crossings = 0;
  let prev = 0;
  const start = 44;
  const samples = Math.floor((wav.byteLength - start) / 2);
  for (let i = 0; i < samples; i++) {
    const s = view.getInt16(start + i * 2, true);
    if (prev !== 0 && Math.sign(s) !== Math.sign(prev) && Math.abs(s) > 500) crossings++;
    if (Math.abs(s) > 500) prev = s;
  }
  const seconds = samples / 16000;
  return crossings / 2 / seconds;
}

describe.skipIf(!hasFfmpeg)("extractCallChannels", () => {
  it("ISOLATES each channel instead of downmixing them", async () => {
    // Agent leg = 300 Hz, customer leg = 1200 Hz. A downmix (`-ac 1`) would
    // leave BOTH tones in both outputs — which is exactly the crosstalk that
    // makes the transcription model drop a speaker.
    const stereo = buildStereo(
      "sine=frequency=300:duration=2:sample_rate=48000",
      "sine=frequency=1200:duration=2:sample_rate=48000",
    );
    const ch = await extractCallChannels(stereo);
    expect(ch, "stereo input must split").not.toBeNull();

    const agentHz = dominantHz(ch!.agent.bytes);
    const customerHz = dominantHz(ch!.customer.bytes);
    // Generous windows — Opus at 48k then resampled to 16k, measured by zero
    // crossings. The POINT is that each side carries its OWN tone and not the
    // other's, not the precision of the estimate.
    expect(agentHz, `agent channel measured ${agentHz.toFixed(0)} Hz`).toBeLessThan(700);
    expect(customerHz, `customer channel measured ${customerHz.toFixed(0)} Hz`).toBeGreaterThan(700);
  }, 60_000);

  it("reports a silent far end as silence so it is never transcribed", async () => {
    const stereo = buildStereo(
      "sine=frequency=440:duration=2:sample_rate=48000",
      "anullsrc=channel_layout=mono:sample_rate=48000:duration=2",
    );
    const ch = await extractCallChannels(stereo);
    expect(ch).not.toBeNull();
    // The speaking leg is loud; the empty one is at digital silence. The
    // caller's threshold (-60 dBFS) must sit between them with room to spare.
    expect(ch!.agent.meanVolumeDb).toBeGreaterThan(-45);
    expect(ch!.customer.meanVolumeDb).toBeLessThan(-80);
  }, 60_000);

  it("measures SPEECH seconds, not just level — the gate that stops hallucination", async () => {
    // A model handed non-speech does not return nothing, it returns confident
    // nonsense: measured, `gpt-4o-transcribe` answered pure silence with
    // "人間失格" and line noise with "Horecaonderneming", and whisper-1 scored
    // the same clips at no_speech_prob 0.94 / 0.89. The live bug was a
    // customer channel rendering as Cyrillic gibberish. So a channel with no
    // detected speech must never reach a speech model at all.
    //
    // Level alone cannot decide that — noise can be louder than a quiet
    // talker — which is why the gate counts SPEECH seconds.
    const noisy = buildStereo(
      "sine=frequency=440:duration=3:sample_rate=48000",
      // Steady broadband noise, clearly audible in level terms, zero speech.
      "anoisesrc=r=48000:a=0.0008:duration=3",
    );
    const ch = await extractCallChannels(noisy);
    expect(ch).not.toBeNull();
    // A continuous tone reads as speech-like energy; noise at this level does not.
    expect(ch!.agent.speechSeconds).toBeGreaterThan(0.4);
    expect(
      ch!.customer.speechSeconds,
      "a noise-only leg must measure no speech, or it gets transcribed into invented words",
    ).toBeLessThan(0.4);
  }, 60_000);

  it("reports zero speech for a digitally silent leg", async () => {
    const stereo = buildStereo(
      "sine=frequency=440:duration=3:sample_rate=48000",
      "anullsrc=channel_layout=mono:sample_rate=48000:duration=3",
    );
    const ch = await extractCallChannels(stereo);
    expect(ch!.customer.speechSeconds).toBe(0);
    expect(ch!.customer.meanVolumeDb).toBeLessThan(-80);
  }, 60_000);

  it("returns null for a MONO source so the caller transcribes the file whole", async () => {
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
    await expect(extractCallChannels(new Uint8Array(r.stdout))).resolves.toBeNull();
  }, 60_000);
});
