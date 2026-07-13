import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Transcode an arbitrary audio buffer to OGG/Opus — WhatsApp's native voice-note
 * format.
 *
 * Why this exists: Chrome and Safari can only record `audio/mp4`, which Meta
 * ACCEPTS on upload (returns a wamid) but then fails to DELIVER (the status
 * webhook flips sent → failed). Firefox records `audio/ogg;codecs=opus`, which
 * delivers fine. Transcoding to ogg/opus makes recordings deliver on every
 * browser. They're sent flagged `voice: true` — see the messages.service path.
 *
 * iOS-PLAYBACK GOTCHA (2026-05-26): a STEREO, `application=audio` opus clip
 * sent WITHOUT `voice: true` plays on Android + WhatsApp-Desktop/Mac but iOS
 * WhatsApp refuses it with "This audio is no longer available." iOS only plays
 * Opus when it's a genuine voice note: MONO + Opus `application=voip` + sent as
 * `voice: true`. So this transcode now produces that exact profile (was stereo
 * `application=audio` before). The voip application mode is what real WhatsApp
 * voice notes use; ffmpeg defaults libopus to it, but we set it explicitly so a
 * future ffmpeg default change can't regress iOS playback.
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

/**
 * iOS voice-note playback fix — ON by default (user's choice 2026-05-26: "set
 * it from now … I want it ready when I record"). NOT yet verified against a real
 * iPhone + Meta's upload validator — see the risk note below.
 *
 * The problem: the OLD profile (stereo, application=audio, sent WITHOUT
 * voice:true) delivers to Android + WhatsApp Desktop/Mac (they play it), but
 * iOS WhatsApp refuses it with "This audio is no longer available" — iOS only
 * plays Opus that is a genuine voice note: MONO + application=voip + voice:true.
 * That's what this profile now produces.
 *
 * The risk (why this WAS off, now accepted): a 2026-05-21 session found Meta
 * REJECTED mono+voip on upload (#131053) and that voice:true gave intermittent
 * delivery (3/5). Those tests predate the `-map_metadata -1` metadata-strip fix,
 * so mono+voip+clean-metadata may behave fine now — but it's UNVERIFIED. The
 * user wants it live anyway so it's ready the moment they record.
 *
 * ESCAPE HATCH: if voice notes start failing delivery before it can be tested,
 * set `WHATSAPP_VOICE_IOS_PROFILE=0` (api env) + restart → instantly reverts to
 * the proven stereo/audio profile (voice:true off) without a code change.
 *
 * WHEN TESTED: send a voice note to an iPhone AND an Android/Mac recipient —
 * iPhone should PLAY it; the others must STILL deliver+play. Watch journald for
 * `audio uploadMedia failed` (= Meta #131053 reject) or a status-webhook
 * delivery failure (meta.ts logs the errors[] array). If a regression shows,
 * flip the env to 0. If clean, this default can become unconditional + the flag
 * dropped. The send path reads the same flag to decide whether to set voice:true.
 */
export const VOICE_IOS_PROFILE =
  process.env.WHATSAPP_VOICE_IOS_PROFILE !== "0";

export async function transcodeToOggOpus(
  input: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  // Profile-dependent encode flags. DEFAULT now = iOS profile mono/voip
  // (plays on iPhone; UNVERIFIED against Meta's upload validator — see
  // VOICE_IOS_PROFILE doc above). WHATSAPP_VOICE_IOS_PROFILE=0 falls back to the
  // proven stereo/audio-mode profile (the escape hatch).
  const profileArgs = VOICE_IOS_PROFILE
    ? ["-ac", "1", "-ar", "48000", "-c:a", "libopus", "-application", "voip", "-b:a", "32k"]
    : ["-ac", "2", "-ar", "48000", "-c:a", "libopus", "-b:a", "32k"];
  // Strip ALL source metadata (-map_metadata -1): ffmpeg otherwise copies the
  // input mp4's brand tags into the ogg and Meta's processor rejects it as
  // application/octet-stream (#131053).
  return transcode(input, ["-map_metadata", "-1", "-vn", ...profileArgs, "-f", "ogg", "pipe:1"]);
}

/**
 * Transcode any recording to M4A — AAC in an MP4 container (audio/mp4).
 * Instagram DM's URL-fetch validator REJECTS ogg / webm AND bare ADTS `.aac`
 * with `(#100) attachment format is not supported` (subcode 2534080), but
 * reliably accepts m4a/mp4 (its documented set is aac / m4a / wav / mp4). MP4
 * needs a seekable output for the moov atom, so this writes to a temp `.m4a`
 * file (with `+faststart` so the moov leads) and reads it back, rather than
 * piping to stdout. Stereo 44.1kHz, source metadata stripped.
 */
export async function transcodeToM4a(
  input: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  return transcodeToFile(input, "out.m4a", [
    "-map_metadata", "-1",
    "-vn",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    "-movflags", "+faststart",
    "-f", "ipod",
  ]);
}

async function transcode(
  input: Uint8Array,
  outputArgs: string[],
): Promise<Uint8Array<ArrayBuffer>> {
  const dir = await mkdtemp(join(tmpdir(), "ccp-voice-"));
  const inPath = join(dir, "in");
  try {
    await writeFile(inPath, Buffer.from(input));
    return await runFfmpeg(inPath, outputArgs);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Like {@link transcode} but for a container that needs a SEEKABLE output (mp4/
 * m4a — ffmpeg must rewind to write the moov atom, which `pipe:1` can't do).
 * ffmpeg writes to a temp `<dir>/<outName>`; we read the bytes back and clean up.
 * `outputArgs` must NOT include an output target — the temp path is appended.
 */
async function transcodeToFile(
  input: Uint8Array,
  outName: string,
  outputArgs: string[],
): Promise<Uint8Array<ArrayBuffer>> {
  const dir = await mkdtemp(join(tmpdir(), "ccp-voice-"));
  const inPath = join(dir, "in");
  const outPath = join(dir, outName);
  try {
    await writeFile(inPath, Buffer.from(input));
    // Run ffmpeg to the temp file (stdout stays empty); `-y` overwrites.
    await runFfmpegToFile(inPath, [...outputArgs, "-y", outPath]);
    const buf = await readFile(outPath);
    if (buf.byteLength === 0) throw new Error("ffmpeg produced an empty file");
    const result = new Uint8Array(buf.byteLength);
    result.set(buf);
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Run ffmpeg with a FILE output target (no stdout capture). Resolves on a clean
 *  exit, rejects on ENOENT / non-zero / timeout — same contract as {@link runFfmpeg}. */
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
        reject(new Error("ffmpeg transcode timed out"));
      });
    }, TRANSCODE_TIMEOUT_MS);
    ff.on("error", (err) => finish(() => reject(err))); // ENOENT = not installed
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

function runFfmpeg(inPath: string, outputArgs: string[]): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
    const ff = spawn(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-i", inPath, ...outputArgs],
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
