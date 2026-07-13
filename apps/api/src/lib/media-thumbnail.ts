import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

/**
 * Extract a JPEG poster frame from a video buffer. Tries the first-frame at
 * 00:00:00.5 (slight offset because frame 0 is often a black frame in many
 * containers); falls back to 00:00:01 if that returns nothing useful. Bounded
 * 10s wall-clock — a corrupt/streaming-only video shouldn't hang the inbound
 * webhook indefinitely.
 *
 * Returns the JPEG bytes on success, or null on any failure (no ffmpeg binary,
 * malformed video, timeout, output empty). Callers degrade by leaving the
 * video bubble without a poster — same end-state as today.
 *
 * Runtime: spawns the system `ffmpeg` binary (NOT a bundled one). The api
 * Dockerfile installs ffmpeg; for local dev `sudo apt install ffmpeg`. This
 * matches `lib/media/audio-transcode.ts` — both ffmpeg call sites share
 * the same binary so an ARM deploy doesn't silently fall through (the
 * earlier `@ffmpeg-installer/ffmpeg` package ships an x86_64-only static
 * binary that no-ops on ARM, leaving every inbound video bubble with a
 * black rectangle and no operator signal).
 *
 * Why a temp file instead of streaming bytes-in / bytes-out through ffmpeg's
 * stdin/stdout: ffmpeg needs random-access seek to extract a specific frame
 * cleanly, and stdin pipes aren't seekable. The on-disk path is ~1ms slower
 * but works across every container format Meta delivers (MP4, 3GP, MOV, WebM).
 * Tempfile is unlinked in finally; ENOENT on cleanup is silent.
 */

const THUMBNAIL_TIMEOUT_MS = 10_000;

export async function extractVideoPosterFrame(
  bytes: Uint8Array,
): Promise<Uint8Array | null> {
  let workDir: string | null = null;
  try {
    workDir = await mkdtemp(join(tmpdir(), "ccp-thumb-"));
    const srcPath = join(workDir, `src-${randomUUID()}`);
    const outPath = join(workDir, `out-${randomUUID()}.jpg`);
    await writeFile(srcPath, bytes);

    // Attempt 1: fast input seek to 0.5s (keyframe-aligned). For most
    // short MP4s/3GP/WebM clips with a keyframe at 0, this lands on
    // frame 0 — fine for most videos, but commonly black for
    // fade-in-from-black recordings.
    await runFfmpeg(srcPath, outPath, "00:00:00.500", "before-input");
    let frame = await safeReadOutput(outPath);
    if (!frame || frame.length === 0) {
      // Attempt 2: SLOW output-side seek at 1s — frame-accurate, decodes
      // through to the requested timestamp instead of snapping to the
      // prior keyframe. Costs ~1s of decode work in worst case but is
      // bounded by THUMBNAIL_TIMEOUT_MS. Worth it because the entire
      // reason we retry is "attempt 1 landed on a black frame".
      await runFfmpeg(srcPath, outPath, "00:00:01.000", "after-input").catch(() => undefined);
      frame = await safeReadOutput(outPath);
    }
    if (!frame || frame.length === 0) return null;
    return new Uint8Array(frame);
  } catch {
    return null;
  } finally {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/**
 * Downscale an image buffer to a ~512px-wide JPEG thumbnail, or null on any
 * failure. Inbound images can be up to 5 MB but render in a ~320px bubble slot,
 * so serving a small thumbnail (with the full image behind a tap) saves large
 * downloads + decode on every thread open. Reuses the same ffmpeg binary the
 * video poster path relies on. Best-effort + bounded 10s.
 */
export async function extractImageThumbnail(bytes: Uint8Array): Promise<Uint8Array | null> {
  let workDir: string | null = null;
  try {
    workDir = await mkdtemp(join(tmpdir(), "ccp-imgthumb-"));
    const srcPath = join(workDir, `src-${randomUUID()}`);
    const outPath = join(workDir, `out-${randomUUID()}.jpg`);
    await writeFile(srcPath, bytes);
    await runFfmpegImageThumb(srcPath, outPath);
    const out = await safeReadOutput(outPath);
    if (!out || out.length === 0) return null;
    // A thumbnail bigger than the source is pointless — signal "no thumb" so the
    // bubble serves the original.
    if (out.length >= bytes.length) return null;
    return new Uint8Array(out);
  } catch {
    return null;
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runFfmpegImageThumb(srcPath: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = "";
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        ff.kill("SIGKILL");
        reject(new Error("ffmpeg image thumbnail timeout"));
      });
    }, 10_000);
    // Scale to at most 512px wide (never upscale), height auto (`-2` keeps it
    // even for the JPEG encoder); one frame; quality ~q:v 4 (visually clean,
    // small). Never upscales a small image because `min(512,iw)`.
    const ff = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-i",
        srcPath,
        "-vf",
        "scale='min(512,iw)':-2",
        "-frames:v",
        "1",
        "-q:v",
        "4",
        "-y",
        outPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    ff.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });
    ff.on("error", (err) => finish(() => reject(err)));
    ff.on("close", (code) =>
      finish(() =>
        code === 0 ? resolve() : reject(new Error(`ffmpeg image thumb exit ${code}: ${stderr.slice(0, 300)}`)),
      ),
    );
  });
}

/**
 * Probe a media buffer's duration in milliseconds via ffmpeg, or null on any
 * failure (no ffmpeg, unreadable bytes, no duration line). Used for inbound
 * WhatsApp voice notes / audio, whose webhook carries no duration — real
 * WhatsApp shows the length (e.g. 0:07) up front, so we probe it once during the
 * async media download and stamp it on the row + the media_ready frame. Runs
 * `ffmpeg -i <file>` (no output file — ffmpeg prints "Duration: HH:MM:SS.ss" to
 * stderr then exits non-zero, which we ignore) so it needs only the same ffmpeg
 * binary the poster path already relies on. Bounded 10s.
 */
export async function probeMediaDurationMs(bytes: Uint8Array): Promise<number | null> {
  let workDir: string | null = null;
  try {
    workDir = await mkdtemp(join(tmpdir(), "ccp-dur-"));
    const srcPath = join(workDir, `src-${randomUUID()}`);
    await writeFile(srcPath, bytes);
    const stderr = await runFfmpegProbe(srcPath);
    // "  Duration: 00:00:07.42, start: 0.000000, bitrate: 33 kb/s"
    const m = stderr.match(/Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d{1,3})/);
    if (!m) return null;
    const hh = Number(m[1] ?? "0");
    const mm = Number(m[2] ?? "0");
    const ss = Number(m[3] ?? "0");
    const frac = Number((m[4] ?? "0").padEnd(3, "0"));
    const ms = (hh * 3600 + mm * 60 + ss) * 1000 + frac;
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  } catch {
    return null;
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runFfmpegProbe(srcPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = "";
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        ff.kill("SIGKILL");
        reject(new Error("ffmpeg duration probe timeout"));
      });
    }, 10_000);
    // `-i` with no output makes ffmpeg emit the format header (incl. Duration)
    // then exit 1 ("At least one output file must be specified") — expected.
    const ff = spawn("ffmpeg", ["-hide_banner", "-i", srcPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    ff.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });
    ff.on("error", (err) => finish(() => reject(err)));
    ff.on("close", () => finish(() => resolve(stderr)));
  });
}

/**
 * Read the ffmpeg output file. Returns null on ENOENT (legitimate "no
 * frame produced"), null + warning log on any other error (ENOSPC, EACCES,
 * EIO — operational issues we want visible). Without this distinction
 * a full `/tmp` silently turns every video thumbnail into a black bubble
 * with no signal in the logs.
 */
async function safeReadOutput(outPath: string): Promise<Buffer | null> {
  try {
    return await readFile(outPath);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return null;
    console.warn(
      `[media-thumbnail] readFile failed (${code ?? "unknown"}): ${
        err instanceof Error ? err.message : err
      }`,
    );
    return null;
  }
}

function runFfmpeg(
  srcPath: string,
  outPath: string,
  seek: string,
  seekMode: "before-input" | "after-input",
): Promise<void> {
  return new Promise((resolve, reject) => {
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
        reject(new Error("ffmpeg thumbnail timeout"));
      });
    }, THUMBNAIL_TIMEOUT_MS);

    // -ss BEFORE -i = fast keyframe-aligned seek (snaps to prior keyframe).
    // -ss AFTER  -i = slow frame-accurate seek (decodes through, lands at
    //                 exactly the requested timestamp).
    // The faster shape can land on a black frame for fade-in recordings;
    // the slower shape is the retry path so we degrade quality of the
    // POSTER (still a JPEG, just decoded a beat later) rather than the
    // BLACK-frame risk.
    const args = ["-hide_banner", "-loglevel", "error"];
    if (seekMode === "before-input") {
      args.push("-ss", seek, "-i", srcPath);
    } else {
      args.push("-i", srcPath, "-ss", seek);
    }
    args.push(
      // -frames:v 1 → one frame, immediate exit.
      // -q:v 4    → high but not lossless JPEG quality (~150-300KB typical
      //              for 720p source).
      // -vf scale → cap longest side at 640px so the poster is light to
      //              fetch even on mobile data. preserveAspectRatio via -2.
      "-frames:v", "1",
      "-q:v", "4",
      "-vf", "scale='min(640,iw)':-2",
      "-y", // overwrite if outPath exists (second-attempt retry path)
      outPath,
    );

    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });

    let stderr = "";
    ff.stderr.on("data", (c: Buffer) => {
      if (stderr.length < 4000) stderr += c.toString();
    });
    ff.on("error", (err) => finish(() => reject(err))); // ENOENT = ffmpeg not installed
    ff.on("close", (code) => {
      finish(() => {
        if (code === 0) return resolve();
        reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 500)}`));
      });
    });
  });
}
