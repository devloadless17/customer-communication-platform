/**
 * WhatsApp outbound video conformance (video-messages doc).
 *
 * Meta's constraints are codec-level — H.264 + AAC (≤1 audio stream), and
 * H.264 High-profile-with-B-frames uploads fine but Android WhatsApp can't
 * play it. The funnel: probe → conforming files remuxed `+faststart` →
 * non-conforming re-encoded to H.264 Main / no B-frames / AAC → honest
 * rejection only when the re-encode itself fails.
 *
 * The playability RULE is tested as a pure function; the funnel is tested
 * against real ffmpeg-synthesized videos (lavfi testsrc), since the whole
 * point is what ffprobe/ffmpeg actually produce. Skips if ffmpeg is missing.
 *
 *   pnpm --filter @ccp/api exec vitest run test/video-transcode.spec.ts
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  ensureWhatsappPlayableVideo,
  isWhatsappPlayable,
} from "@/lib/media/video-transcode";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

const dir = mkdtempSync(join(tmpdir(), "ccp-video-spec-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Synthesize a 1s test video with the given codec args. Returns the bytes. */
function makeVideo(name: string, args: string[]): Uint8Array {
  const out = join(dir, name);
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=15",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-shortest",
    ...args,
    "-y", out,
  ]);
  return new Uint8Array(readFileSync(out));
}

function probeOf(bytes: Uint8Array, name: string): { codec: string; profile: string } {
  const p = join(dir, `probe-${name}`);
  execFileSync("sh", ["-c", `cat > ${JSON.stringify(p)}`], { input: Buffer.from(bytes) });
  const json = JSON.parse(
    execFileSync("ffprobe", [
      "-hide_banner", "-loglevel", "error",
      "-print_format", "json", "-show_streams", p,
    ]).toString(),
  ) as { streams: Array<{ codec_type: string; codec_name: string; profile?: string }> };
  const v = json.streams.find((s) => s.codec_type === "video")!;
  return { codec: v.codec_name, profile: v.profile ?? "" };
}

describe("isWhatsappPlayable (the doc's rule, pure)", () => {
  const base = { videoCodec: "h264", profile: "Main", hasBFrames: false, audioCodecs: ["aac"] };
  it("accepts H.264 Main + AAC", () => {
    expect(isWhatsappPlayable(base)).toBe(true);
  });
  it("accepts video-only (no audio stream) and High WITHOUT B-frames", () => {
    expect(isWhatsappPlayable({ ...base, audioCodecs: [] })).toBe(true);
    expect(isWhatsappPlayable({ ...base, profile: "High", hasBFrames: false })).toBe(true);
  });
  it("rejects the documented Android-unplayable combo: High + B-frames", () => {
    expect(isWhatsappPlayable({ ...base, profile: "High", hasBFrames: true })).toBe(false);
  });
  it("rejects non-H.264, non-AAC audio, and multiple audio streams", () => {
    expect(isWhatsappPlayable({ ...base, videoCodec: "hevc" })).toBe(false);
    expect(isWhatsappPlayable({ ...base, audioCodecs: ["mp3"] })).toBe(false);
    expect(isWhatsappPlayable({ ...base, audioCodecs: ["aac", "aac"] })).toBe(false);
  });
});

describe.skipIf(!hasFfmpeg)("ensureWhatsappPlayableVideo (real ffmpeg)", () => {
  it("remuxes an already-conforming H.264/AAC mp4 (stream copy, +faststart)", async () => {
    const input = makeVideo("main.mp4", [
      "-c:v", "libx264", "-profile:v", "main", "-bf", "0", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-f", "mp4",
    ]);
    const res = await ensureWhatsappPlayableVideo(input);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.changed).toBe(true); // remuxed for faststart
      // Still H.264 — stream copy, not a re-encode.
      expect(probeOf(res.bytes, "main-out.mp4").codec).toBe("h264");
    }
  }, 60_000);

  it("re-encodes a High+B-frames mp4 down to a playable profile", async () => {
    const input = makeVideo("high-bf.mp4", [
      "-c:v", "libx264", "-profile:v", "high", "-bf", "2", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-f", "mp4",
    ]);
    const res = await ensureWhatsappPlayableVideo(input);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.changed).toBe(true);
      const probe = probeOf(res.bytes, "high-out.mp4");
      expect(probe.codec).toBe("h264");
      expect(probe.profile.toLowerCase()).not.toContain("high");
    }
  }, 120_000);

  it("re-encodes an mp3-audio mp4 to AAC", async () => {
    const input = makeVideo("mp3-audio.mp4", [
      "-c:v", "libx264", "-profile:v", "main", "-bf", "0", "-pix_fmt", "yuv420p",
      "-c:a", "libmp3lame", "-f", "mp4",
    ]);
    const res = await ensureWhatsappPlayableVideo(input);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.changed).toBe(true);
  }, 120_000);

  it("fails open (original bytes, unchanged) on junk that isn't a video at all", async () => {
    const res = await ensureWhatsappPlayableVideo(new Uint8Array([1, 2, 3, 4, 5]));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.changed).toBe(false);
  }, 30_000);
});
