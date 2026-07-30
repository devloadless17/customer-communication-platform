/**
 * Speaker attribution — who said each line.
 *
 * The design this pins: the WORDS come from the mixed audio (the most accurate
 * rendering — it holds both speakers, and it is immune to the echo damage that
 * ruins an isolated microphone leg when both devices share a room), and the
 * SPEAKER comes from comparing the two legs' loudness over each segment's time
 * window. Whoever is talking is louder on their OWN leg, and that stays true
 * even where a leg is too degraded to transcribe.
 *
 * Attribution is therefore independent of transcription quality, which is what
 * makes an accurate transcript an ORGANISED one.
 *
 *   pnpm --filter @ccp/api exec vitest run test/call-speaker-attribution.spec.ts
 */
import { describe, expect, it } from "vitest";

import { attributeSpeakers } from "@/lib/media/audio-transcode";

const RATE = 16000;

/**
 * A 16-bit mono WAV with tone bursts at the given windows — a stand-in for one
 * leg of a call. `level` is linear amplitude (1 = full scale).
 */
function wavWithSpeech(
  durationSec: number,
  bursts: Array<{ from: number; to: number; level: number }>,
): Uint8Array {
  const samples = Math.floor(durationSec * RATE);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);

  for (const b of bursts) {
    const from = Math.floor(b.from * RATE);
    const to = Math.min(samples, Math.floor(b.to * RATE));
    for (let i = from; i < to; i++) {
      const v = Math.sin((2 * Math.PI * 300 * i) / RATE) * b.level;
      view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 32767, true);
    }
  }
  return new Uint8Array(buffer);
}

describe("attributeSpeakers", () => {
  it("labels each segment with whoever was louder on their own leg", () => {
    // Agent talks 0-3s, customer answers 3-6s — an ordinary two-party call.
    const agent = wavWithSpeech(6, [{ from: 0, to: 3, level: 0.5 }]);
    const customer = wavWithSpeech(6, [{ from: 3, to: 6, level: 0.5 }]);
    const result = attributeSpeakers(
      [
        { start: 0, end: 3 },
        { start: 3, end: 6 },
      ],
      agent,
      customer,
    );
    expect(result).toEqual(["agent", "customer"]);
  });

  it("still attributes correctly when one leg is far QUIETER", () => {
    // The WebRTC remote leg arrives at a gain we don't control — measured as
    // low as -52 dBFS on a real call. Attribution compares the legs to EACH
    // OTHER per segment, so a quiet customer is still unambiguously the
    // speaker during their own turn.
    const agent = wavWithSpeech(6, [{ from: 0, to: 3, level: 0.5 }]);
    const customer = wavWithSpeech(6, [{ from: 3, to: 6, level: 0.01 }]);
    expect(
      attributeSpeakers([{ start: 0, end: 3 }, { start: 3, end: 6 }], agent, customer),
    ).toEqual(["agent", "customer"]);
  });

  it("returns null when the legs are too close to call", () => {
    // Both devices in one room: the same voice at the same level on both legs.
    // Guessing here would attach a confident wrong name to real words, so the
    // caller is told "unknown" and carries the previous speaker forward.
    const both = wavWithSpeech(3, [{ from: 0, to: 3, level: 0.4 }]);
    expect(attributeSpeakers([{ start: 0, end: 3 }], both, both)).toEqual([null]);
  });

  it("compares only the segment's own window, not the whole call", () => {
    // A speaker who dominates the call overall must not capture a segment
    // spoken by the other party.
    const agent = wavWithSpeech(10, [{ from: 0, to: 8, level: 0.6 }]);
    const customer = wavWithSpeech(10, [{ from: 8, to: 10, level: 0.6 }]);
    expect(
      attributeSpeakers([{ start: 8, end: 10 }], agent, customer),
    ).toEqual(["customer"]);
  });

  it("survives an unparseable leg instead of throwing", () => {
    // Attribution is an enhancement; losing it must never cost the transcript.
    const agent = wavWithSpeech(2, [{ from: 0, to: 2, level: 0.5 }]);
    expect(attributeSpeakers([{ start: 0, end: 2 }], agent, new Uint8Array(0))).toEqual([
      "agent",
    ]);
  });
});
