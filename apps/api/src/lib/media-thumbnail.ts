import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";

/**
 * Extract a JPEG poster frame from a video buffer. Tries the first-frame at
 * 00:00:00.1 (slight offset because frame 0 is often a black frame in many
 * containers); falls back to 00:00:01 if that returns nothing useful. Bounded
 * 10s wall-clock — a corrupt/streaming-only video shouldn't hang the inbound
 * webhook indefinitely.
 *
 * Returns the JPEG bytes on success, or null on any failure (no ffmpeg binary,
 * malformed video, timeout, output empty). Callers degrade by leaving the
 * video bubble without a poster — same end-state as today.
 *
 * Why a temp file instead of streaming bytes-in / bytes-out through ffmpeg's
 * stdin/stdout: ffmpeg needs random-access seek to extract a specific frame
 * cleanly, and stdin pipes aren't seekable. The on-disk path is ~1ms slower
 * but works across every container format Meta delivers (MP4, 3GP, MOV, WebM).
 * Tempfile is unlinked in finally; ENOENT on cleanup is silent.
 */
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

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

    await runFfmpeg(srcPath, outPath, "00:00:00.500");
    let frame = await readFile(outPath).catch(() => null);
    if (!frame || frame.length === 0) {
      // Some videos have a fully-black or null first second; retry at 1s.
      await runFfmpeg(srcPath, outPath, "00:00:01.000").catch(() => undefined);
      frame = await readFile(outPath).catch(() => null);
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

function runFfmpeg(srcPath: string, outPath: string, seek: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("ffmpeg thumbnail timeout"));
    }, THUMBNAIL_TIMEOUT_MS);
    ffmpeg(srcPath)
      .inputOptions(["-ss", seek])
      // -frames:v 1 → one frame, immediate exit.
      // -q:v 4    → high but not lossless JPEG quality (~150-300KB typical
      //              for 720p source).
      // -vf scale → cap longest side at 640px so the poster is light to
      //              fetch even on mobile data. preserveAspectRatio via -2.
      .outputOptions([
        "-frames:v",
        "1",
        "-q:v",
        "4",
        "-vf",
        "scale='min(640,iw)':-2",
      ])
      .on("end", () => {
        clearTimeout(timer);
        resolve();
      })
      .on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      })
      .save(outPath);
  });
}
