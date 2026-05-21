import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Transcode an arbitrary audio buffer to OGG/Opus — WhatsApp's native voice-note
 * format.
 *
 * Why this exists: Chrome and Safari can only record `audio/mp4`, which Meta
 * ACCEPTS on upload (returns a wamid) but then fails to DELIVER (the status
 * webhook flips sent → failed). Firefox records `audio/ogg;codecs=opus`, which
 * delivers fine. Transcoding to ogg/opus (matching Firefox's profile) makes
 * recordings deliver on every browser. They're sent as a normal audio clip,
 * NOT flagged `voice: true` — see the messages.service send path.
 *
 * Input is written to a temp file (ffmpeg needs a seekable source to find the
 * mp4 moov atom reliably), output ogg is read from stdout, temp file removed in
 * `finally`. Throws if ffmpeg is missing (ENOENT — not installed), exits
 * non-zero, times out, or yields nothing; callers treat a throw as best-effort
 * "send the original".
 *
 * Runtime: `ffmpeg` is in the api Docker image (apps/api/Dockerfile). For local
 * dev, `sudo apt install ffmpeg` (the api runs on the host outside the container).
 */

const TRANSCODE_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export async function transcodeToOggOpus(
  input: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const dir = await mkdtemp(join(tmpdir(), "ccp-voice-"));
  const inPath = join(dir, "in");
  try {
    await writeFile(inPath, Buffer.from(input));
    return await runFfmpeg(inPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function runFfmpeg(inPath: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
    const ff = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel", "error",
        "-i", inPath,
        // Strip ALL source metadata. ffmpeg otherwise copies the input mp4's
        // container tags (major_brand=isom, compatible_brands=…mp41…,
        // handler_name, creation_time) into the ogg — and Meta's media processor
        // sniffs those mp4 brand strings inside an "ogg" file and rejects it as
        // application/octet-stream (#131053). Firefox's native ogg has none of
        // this; -map_metadata -1 makes our output match.
        "-map_metadata", "-1",
        "-vn", // drop any cover-art / video stream
        // Match the opus profile Meta accepts — what Firefox's MediaRecorder
        // produces (verified against a delivered file): standard "audio"
        // application mode (NOT voip) + stereo + 48kHz.
        "-ac", "2",
        "-ar", "48000",
        "-c:a", "libopus",
        "-b:a", "32k",
        "-f", "ogg",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const chunks: Buffer[] = [];
    let outLen = 0;
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
        reject(new Error("ffmpeg transcode timed out"));
      });
    }, TRANSCODE_TIMEOUT_MS);

    ff.on("error", (err) => finish(() => reject(err))); // ENOENT = ffmpeg not installed
    ff.stdout.on("data", (c: Buffer) => {
      outLen += c.length;
      if (outLen > MAX_OUTPUT_BYTES) {
        finish(() => {
          ff.kill("SIGKILL");
          reject(new Error("ffmpeg output exceeded size cap"));
        });
        return;
      }
      chunks.push(c);
    });
    ff.stderr.on("data", (c: Buffer) => {
      if (stderr.length < 4000) stderr += c.toString();
    });
    ff.on("close", (code) => {
      finish(() => {
        if (code === 0 && outLen > 0) {
          // Copy into a fresh ArrayBuffer-backed view so the return type is
          // Uint8Array<ArrayBuffer> (what the send path's `bytes` expects).
          const merged = Buffer.concat(chunks);
          const result = new Uint8Array(merged.byteLength);
          result.set(merged);
          resolve(result);
        } else {
          reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 500)}`));
        }
      });
    });
  });
}
