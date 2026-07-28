import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FFMPEG_WAIT_OUTBOUND_MS, withFfmpegSlot } from "./ffmpeg-slots";

/**
 * WhatsApp outbound video conformance (video-messages doc).
 *
 * The mime gate (`WHATSAPP_VIDEO_MIME`) can only see the CONTAINER. Meta's
 * actual constraints are codec-level: **H.264 video + AAC (or no) audio,
 * single audio stream** — and, per the doc, H.264 "High" profile with
 * B-frames is NOT playable on Android WhatsApp clients even though Meta
 * accepts the upload and returns a wamid. That combination is the worst
 * failure class we know: the send "succeeds" and a large share of recipients
 * silently get an unplayable file. An HEVC-encoded `.mp4` (iPhone exports,
 * modern screen captures) fails the same way. Same accepted-but-broken class
 * the audio path already transcodes around (Chrome's audio/mp4 recordings).
 *
 * So the WhatsApp video send path runs this funnel on `.mp4` inputs:
 *
 *   1. ffprobe (fast, ~100ms). Undecodable / ffprobe missing → send the
 *      original (fail open — Meta's own validation is the backstop, and we
 *      can't tell a broken tool from a broken file).
 *   2. CONFORMING (h264 not-High-with-B-frames + ≤1 AAC-or-no audio) →
 *      remux `-c copy -movflags +faststart` (seconds, no re-encode) so the
 *      moov box leads the file, the doc's explicit compatibility
 *      recommendation. Remux failure → send the original (it was already
 *      conforming; faststart is an optimization).
 *   3. NON-conforming → ONE bounded re-encode to the doc's recommended
 *      profile: H.264 Main without B-frames, yuv420p, AAC, faststart,
 *      long-edge capped at 1280 so a 4k input can't eat the VPS. Runs under
 *      the shared ffmpeg semaphore; 90s timeout (video is heavier than the
 *      20s audio budget).
 *   4. Re-encode fails / times out / exceeds Meta's 16 MB video cap → the
 *      caller REJECTS with an actionable error naming what was found.
 *      Knowingly shipping an Android-unplayable video would be worse than an
 *      honest "re-export this" message.
 *
 * `.3gp` inputs pass through untouched: the format is in Meta's own supported
 * table, rare in practice, and probing legacy 3GPP profiles buys nothing.
 */

const PROBE_TIMEOUT_MS = 15_000;
const VIDEO_TRANSCODE_TIMEOUT_MS = 90_000;
/** Meta's video ceiling (media-caps.ts) — a re-encode that lands over it would
 *  just be rejected downstream, so it counts as a failed conversion here. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface VideoProbe {
  videoCodec: string | null;
  /** e.g. "High", "Main", "Constrained Baseline" — as ffprobe reports it. */
  profile: string | null;
  hasBFrames: boolean;
  audioCodecs: string[];
}

export type EnsureVideoResult =
  | { ok: true; bytes: Uint8Array<ArrayBuffer>; changed: boolean }
  | { ok: false; reason: string };

/** ffprobe the streams. Throws on ENOENT / non-zero / timeout / unparseable. */
async function probeVideo(inPath: string): Promise<VideoProbe> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const fp = spawn(
      "ffprobe",
      [
        "-hide_banner",
        "-loglevel", "error",
        "-print_format", "json",
        "-show_streams",
        inPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        fp.kill("SIGKILL");
        reject(new Error("ffprobe timed out"));
      });
    }, PROBE_TIMEOUT_MS);
    fp.on("error", (e) => finish(() => reject(e)));
    fp.stdout.on("data", (c: Buffer) => {
      if (out.length < 1_000_000) out += c.toString();
    });
    fp.stderr.on("data", (c: Buffer) => {
      if (err.length < 2000) err += c.toString();
    });
    fp.on("close", (code) => {
      finish(() =>
        code === 0 ? resolve(out) : reject(new Error(`ffprobe exited ${code}: ${err.slice(0, 300)}`)),
      );
    });
  });

  const parsed = JSON.parse(stdout) as {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      profile?: string;
      has_b_frames?: number;
    }>;
  };
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  if (!video) throw new Error("no video stream found");
  return {
    videoCodec: video.codec_name ?? null,
    profile: video.profile ?? null,
    hasBFrames: (video.has_b_frames ?? 0) > 0,
    audioCodecs: streams
      .filter((s) => s.codec_type === "audio")
      .map((s) => s.codec_name ?? "unknown"),
  };
}

/** The doc's playability rule. Exported for the spec. */
export function isWhatsappPlayable(probe: VideoProbe): boolean {
  if (probe.videoCodec !== "h264") return false;
  // "High profile AND B-frames" is the documented Android-unplayable combo.
  // Main/Baseline (with or without B-frames) and High WITHOUT B-frames pass.
  if ((probe.profile ?? "").toLowerCase().includes("high") && probe.hasBFrames) return false;
  if (probe.audioCodecs.length > 1) return false;
  if (probe.audioCodecs.length === 1 && probe.audioCodecs[0] !== "aac") return false;
  return true;
}

/** One human line describing why the probe failed the rule — for the 422 detail. */
function nonconformanceReason(probe: VideoProbe): string {
  if (probe.videoCodec !== "h264") {
    return `its video codec is ${probe.videoCodec ?? "unknown"} (WhatsApp requires H.264)`;
  }
  if ((probe.profile ?? "").toLowerCase().includes("high") && probe.hasBFrames) {
    return "it uses the H.264 High profile with B-frames, which Android WhatsApp can't play";
  }
  if (probe.audioCodecs.length > 1) {
    return `it has ${probe.audioCodecs.length} audio tracks (WhatsApp allows at most one)`;
  }
  return `its audio codec is ${probe.audioCodecs[0] ?? "unknown"} (WhatsApp requires AAC)`;
}

function runFfmpegToFile(inPath: string, outputArgs: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ff = spawn(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-i", inPath, ...outputArgs],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        ff.kill("SIGKILL");
        reject(new Error("ffmpeg video transcode timed out"));
      });
    }, VIDEO_TRANSCODE_TIMEOUT_MS);
    ff.on("error", (e) => finish(() => reject(e)));
    ff.stderr.on("data", (c: Buffer) => {
      if (stderr.length < 4000) stderr += c.toString();
    });
    ff.on("close", (code) => {
      finish(() =>
        code === 0
          ? resolve()
          : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 500)}`)),
      );
    });
  });
}

/**
 * Run the conformance funnel on an outbound WhatsApp `.mp4`. Never throws —
 * every outcome is a value so the send path's control flow stays flat.
 */
export async function ensureWhatsappPlayableVideo(
  input: Uint8Array<ArrayBuffer>,
): Promise<EnsureVideoResult> {
  return withFfmpegSlot(FFMPEG_WAIT_OUTBOUND_MS, async (): Promise<EnsureVideoResult> => {
    const dir = await mkdtemp(join(tmpdir(), "ccp-video-"));
    const inPath = join(dir, "in.mp4");
    const outPath = join(dir, "out.mp4");
    try {
      await writeFile(inPath, Buffer.from(input));

      let probe: VideoProbe;
      try {
        probe = await probeVideo(inPath);
      } catch (err) {
        // Fail OPEN: ffprobe missing or an undecodable container. Meta's own
        // validation is the backstop; blocking every video because a tool is
        // absent would be worse than the occasional late rejection.
        console.warn(
          `[video-transcode] probe failed; sending original: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { ok: true, bytes: input, changed: false };
      }

      if (isWhatsappPlayable(probe)) {
        // Already conforming — remux only, so the moov box leads (the doc's
        // faststart recommendation). Stream copy: seconds, no quality change.
        try {
          await runFfmpegToFile(inPath, [
            "-map", "0:v:0",
            "-map", "0:a:0?",
            "-c", "copy",
            "-movflags", "+faststart",
            "-f", "mp4",
            "-y", outPath,
          ]);
          const out = await readFile(outPath);
          if (out.byteLength === 0) throw new Error("empty remux output");
          const bytes = new Uint8Array(out.byteLength);
          bytes.set(out);
          return { ok: true, bytes, changed: true };
        } catch (err) {
          // Remux is an optimization on an already-conforming file.
          console.warn(
            `[video-transcode] faststart remux failed; sending original: ${err instanceof Error ? err.message : String(err)}`,
          );
          return { ok: true, bytes: input, changed: false };
        }
      }

      // Non-conforming — one bounded re-encode to the doc's recommended
      // profile. Metadata stripped (the audio path learned Meta's processor
      // chokes on carried-over brand tags).
      const reason = nonconformanceReason(probe);
      try {
        await runFfmpegToFile(inPath, [
          "-map", "0:v:0",
          "-map", "0:a:0?",
          "-map_metadata", "-1",
          "-c:v", "libx264",
          "-profile:v", "main",
          "-bf", "0",
          "-pix_fmt", "yuv420p",
          "-crf", "23",
          "-preset", "veryfast",
          // Cap the long edge at 1280 (even dims for yuv420p) so a 4k input
          // can't monopolize the VPS for minutes or balloon past the 16 MB cap.
          "-vf", "scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))'",
          "-c:a", "aac",
          "-b:a", "128k",
          "-ac", "2",
          "-movflags", "+faststart",
          "-f", "mp4",
          "-y", outPath,
        ]);
        const out = await readFile(outPath);
        if (out.byteLength === 0) throw new Error("empty transcode output");
        if (out.byteLength > MAX_OUTPUT_BYTES) {
          return {
            ok: false,
            reason: `${reason}, and converting it produced a file over WhatsApp's 16 MB limit`,
          };
        }
        const bytes = new Uint8Array(out.byteLength);
        bytes.set(out);
        console.warn(`[video-transcode] re-encoded outbound video: ${reason}`);
        return { ok: true, bytes, changed: true };
      } catch (err) {
        console.warn(
          `[video-transcode] re-encode failed (${reason}): ${err instanceof Error ? err.message : String(err)}`,
        );
        return { ok: false, reason };
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
}
