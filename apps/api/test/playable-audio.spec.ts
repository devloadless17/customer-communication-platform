/**
 * Safari playback compat — the lazily-materialized AAC shadow of stored
 * ogg/opus audio (lib/media/playable-audio.ts).
 *
 * Safari (macOS + every iPhone) could not decode ogg/opus in an <audio>
 * element before 18.4, so every WhatsApp voice note and call recording — the
 * app's canonical audio format — rendered as "audio unavailable" on Macs.
 * `?playable=1` routes through `resolvePlayableAudio`, which transcodes the
 * ogg to AAC/M4A once (real ffmpeg, same binary the api image ships) and
 * caches the variant at `<key>.m4a`.
 *
 * Runs against an in-memory blob stub + REAL ffmpeg; skipped when ffmpeg is
 * not installed (mirrors video-transcode.spec.ts).
 *
 *   pnpm --filter @ccp/api exec vitest run test/playable-audio.spec.ts
 */
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

const store = new Map<string, { bytes: Uint8Array; contentType: string }>();
let puts = 0;

vi.mock("@/lib/blob-storage", () => ({
  blobStorage: {
    name: "stub",
    getObject: async (key: string, opts?: { range?: string }) => {
      const hit = store.get(key);
      if (!hit) throw new Error(`missing ${key}`);
      const bytes = opts?.range ? hit.bytes.slice(0, 1) : hit.bytes;
      return {
        body: Readable.from([Buffer.from(bytes)]),
        contentType: hit.contentType,
        acceptRanges: "bytes",
        statusCode: opts?.range ? 206 : 200,
      };
    },
    putObject: async (input: { key: string; bytes: Uint8Array; contentType: string }) => {
      puts += 1;
      store.set(input.key, { bytes: input.bytes, contentType: input.contentType });
      return { key: input.key };
    },
  },
}));

function ffmpegAvailable(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function makeOggOpus(): Uint8Array {
  // 1s sine → ogg/opus, entirely in-memory via stdout.
  const out = execFileSync("ffmpeg", [
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:a", "libopus", "-b:a", "32k", "-f", "ogg", "pipe:1",
  ]);
  return new Uint8Array(out);
}

describe.skipIf(!ffmpegAvailable())("resolvePlayableAudio", () => {
  it("materializes an AAC/M4A variant for ogg once, then serves the cache", async () => {
    const { resolvePlayableAudio, PLAYABLE_AUDIO_SUFFIX } = await import(
      "@/lib/media/playable-audio"
    );
    const key = "media/ws1/voice-abc.ogg";
    store.set(key, { bytes: makeOggOpus(), contentType: "audio/ogg" });

    const first = await resolvePlayableAudio(key, "audio/ogg");
    expect(first).toBe(`${key}${PLAYABLE_AUDIO_SUFFIX}`);
    const variant = store.get(first);
    expect(variant?.contentType).toBe("audio/mp4");
    // ftyp box near the start = a real MP4 container, not the ogg passed through.
    const head = Buffer.from(variant!.bytes.slice(0, 16)).toString("latin1");
    expect(head).toContain("ftyp");
    expect(puts).toBe(1);

    // Second play: the probe finds the cached variant — no second transcode.
    const second = await resolvePlayableAudio(key, "audio/ogg");
    expect(second).toBe(first);
    expect(puts).toBe(1);
  });

  it("passes non-ogg audio through untouched", async () => {
    const { resolvePlayableAudio } = await import("@/lib/media/playable-audio");
    const key = "media/ws1/note.m4a";
    store.set(key, { bytes: new Uint8Array([1, 2, 3]), contentType: "audio/mp4" });
    expect(await resolvePlayableAudio(key, "audio/mp4")).toBe(key);
    expect(await resolvePlayableAudio(key, null)).toBe(key);
  });

  it("falls back to the original when the source is missing", async () => {
    const { resolvePlayableAudio } = await import("@/lib/media/playable-audio");
    expect(await resolvePlayableAudio("media/ws1/gone.ogg", "audio/ogg")).toBe(
      "media/ws1/gone.ogg",
    );
  });
});
