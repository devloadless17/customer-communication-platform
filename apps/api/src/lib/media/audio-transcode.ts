import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FFMPEG_WAIT_OUTBOUND_MS, withFfmpegSlot } from "./ffmpeg-slots";

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

/** Ceiling for a VOICE-NOTE pass — seconds of audio, so anything slower than
 *  this is a stuck process rather than a slow encode. */
const TRANSCODE_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * Ceiling for the CALL-RECORDING passes (the full libopus re-encode, the
 * stereo split, loudnorm, and the analysis probes).
 *
 * A call is minutes to an hour of audio, not a ten-second voice note, so the
 * voice-note budget above was killing exactly the long calls — and both
 * artifacts with it: no OGG (the raw browser container survives, but only
 * because the remux failure is caught) and, worse, no transcript, from bytes
 * that exist nowhere else. Scaled by input size so a short call keeps a tight
 * ceiling, and clamped so a huge one still can't hold an ffmpeg slot forever.
 */
const CALL_TRANSCODE_MS_PER_MB = 8_000;
const CALL_TRANSCODE_MIN_MS = 60_000;
const CALL_TRANSCODE_MAX_MS = 10 * 60_000;

function callTranscodeTimeoutMs(input: Uint8Array): number {
  const scaled = (input.byteLength / (1024 * 1024)) * CALL_TRANSCODE_MS_PER_MB;
  return Math.min(CALL_TRANSCODE_MAX_MS, Math.max(CALL_TRANSCODE_MIN_MS, Math.round(scaled)));
}

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
/**
 * In-app call recordings: browser MediaRecorder output (webm/opus, or mp4/aac
 * on Safari) → OGG/OPUS for universal in-app playback and a stable archival
 * format. STEREO is load-bearing, not a quality nicety: the browser mixer
 * puts the agent on the left channel and the customer on the right, and that
 * split is what makes per-speaker transcription possible — the mono voip
 * profile above would collapse it irreversibly. NOTE the browser must actually
 * DELIVER two discrete channels; when it collapses its own mixer to mono this
 * re-encode faithfully duplicates that mono into both channels, which
 * `extractCallChannels` detects and reports as `duplicated`.
 */
export async function transcodeCallRecordingToOgg(
  input: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  return transcode(
    input,
    [
      "-map_metadata", "-1",
      "-vn",
      "-ac", "2",
      "-ar", "48000",
      "-c:a", "libopus",
      "-b:a", "48k",
      "-f", "ogg",
      "pipe:1",
    ],
    callTranscodeTimeoutMs(input),
  );
}

/** One side of the stereo call master, ready for a speech model. */
export interface CallChannelAudio {
  /** Mono 16 kHz WAV, loudness-normalised when it carries speech. */
  bytes: Uint8Array;
  /** Mean level in dBFS of the RAW channel. ≈ -91 is digital silence. */
  meanVolumeDb: number;
  /**
   * Seconds of actual SPEECH (total duration minus detected silence), measured
   * on the raw channel. The gate that decides whether this side is sent to a
   * speech model at all — mean level can't tell a quiet talker from steady
   * line noise, and asking a model to transcribe non-speech makes it invent
   * text (measured: pure silence → "人間失格").
   */
  speechSeconds: number;
}

/**
 * Split the stereo call master into its two speakers — agent (left) and
 * customer (right) — plus the summed mix, all as mono 16 kHz WAVs.
 *
 * The browser mixer records the agent's microphone on the LEFT channel and the
 * customer's leg on the RIGHT, which is what makes "who said this" answerable
 * at all. Isolating them with `pan` is load-bearing: `-ac 1` or `-map_channel`
 * would SUM the two, putting both voices back into each side.
 *
 * Three outputs because no single one is right for every recording:
 *   - the two legs are transcribed separately when they genuinely hold
 *     different speakers, which is both the cleanest audio per speaker and the
 *     only attribution that is certain rather than inferred;
 *   - the mix is used when they don't — a recording whose channels are
 *     identical (see `duplicated`) or whose legs echo each other has no
 *     separation to recover, and the sum is then the most faithful reading.
 *
 * The `speechSeconds` on each output is the gate that keeps a leg with no
 * speech from being sent to a model at all, which is the one reliable defence
 * against transcribing silence into invented words.
 */
export async function extractCallChannels(
  input: Uint8Array,
): Promise<{
  agent: CallChannelAudio;
  customer: CallChannelAudio;
  /**
   * The two legs summed — the same audio a human hears on playback.
   *
   * The fallback whenever the legs cannot be trusted to hold separate
   * speakers: `duplicated` below, or legs that transcribe to nearly the same
   * words because the two devices share a room. In those cases the sum is the
   * most faithful reading available, and it is presented WITHOUT speaker
   * labels rather than attributing words we did not separate.
   */
  mixed: CallChannelAudio;
  /**
   * The two channels carry the SAME audio, so there are no separate speakers
   * to recover — see `channelsAreIdentical`.
   */
  duplicated: boolean;
} | null> {
  const channels = await probeChannelCount(input);
  if (channels < 2) return null;
  // `pan` is what actually isolates a channel: `-map_channel`/`-ac 1` would
  // DOWNMIX (sum) the two, reproducing the very crosstalk this exists to undo.
  const [agent, customer, mixed] = await Promise.all([
    extractOneChannel(input, 0),
    extractOneChannel(input, 1),
    extractOneChannel(input, "mix"),
  ]);
  return { agent, customer, mixed, duplicated: await channelsAreIdentical(input) };
}

/**
 * True when the two channels carry the SAME audio — a mono mix duplicated
 * into a stereo container rather than one speaker per side.
 *
 * A file can be stereo by every metadata check and still be useless for
 * separation. Verified on a real production recording: left minus right
 * measured -90 dB mean (digital silence) and each leg transcribed to
 * byte-identical text, because the browser collapsed the mixer to mono before
 * recording. Detecting it is what lets the pipeline say "separation
 * unavailable" instead of silently filing the whole conversation under one
 * speaker.
 *
 * Subtracting the channels is the direct test: identical signals cancel.
 * -80 dBFS is far below any real content and far above the numerical noise of
 * a lossy round-trip.
 */
async function channelsAreIdentical(input: Uint8Array): Promise<boolean> {
  try {
    const stderr = await runFfmpegStderr(
      input,
      ["-af", "pan=mono|c0=c0-c1,volumedetect", "-f", "null", "-"],
      callTranscodeTimeoutMs(input),
    );
    const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr);
    return m ? Number(m[1]) < -80 : false;
  } catch {
    return false; // unknown ⇒ assume real stereo and let attribution decide
  }
}


async function extractOneChannel(
  input: Uint8Array,
  channel: 0 | 1 | "mix",
): Promise<CallChannelAudio> {
  // `pan=mono|c0=c0+c1` sums the legs (the playback mix); `c0=cN` isolates one.
  const pan = channel === "mix" ? "pan=mono|c0=0.5*c0+0.5*c1" : `pan=mono|c0=c${channel}`;
  const raw = await transcodeToFile(
    input,
    `ch${channel}.wav`,
    [
      "-map_metadata", "-1",
      "-vn",
      "-filter_complex", `[0:a]${pan}[a]`,
      "-map", "[a]",
      "-ar", "16000",
      "-c:a", "pcm_s16le",
      "-f", "wav",
    ],
    callTranscodeTimeoutMs(input),
  );
  const { meanVolumeDb, speechSeconds } = await analyseChannel(raw);

  // Only normalise a channel that actually carries speech. Running loudness
  // normalisation over a silent leg would amplify its noise floor to speaking
  // level and manufacture exactly the non-speech audio the gate exists to
  // reject.
  if (speechSeconds <= 0) return { bytes: raw, meanVolumeDb, speechSeconds };

  try {
    // The two legs arrive at wildly different levels — a browser mic against a
    // WebRTC remote whose gain we don't control — and a quiet leg is where
    // language detection goes wrong (the live bug: real Lebanese Arabic on the
    // customer channel came back as Cyrillic). Normalising both to the same
    // target gives the model comparable input on either side. Single-pass
    // loudnorm: the two-pass version needs a measurement round-trip for a
    // precision nothing here depends on.
    const normalised = await transcodeToFile(
      raw,
      `ch${channel}-n.wav`,
      [
        "-map_metadata", "-1",
        "-vn",
        "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
        "-ar", "16000",
        "-ac", "1",
        "-c:a", "pcm_s16le",
        "-f", "wav",
      ],
      callTranscodeTimeoutMs(raw),
    );
    return { bytes: normalised, meanVolumeDb, speechSeconds };
  } catch {
    // Normalisation is an improvement, never a requirement.
    return { bytes: raw, meanVolumeDb, speechSeconds };
  }
}

/**
 * Mean level + seconds of speech, from ONE ffmpeg pass.
 *
 * `silencedetect` reports every silent RUN; speech is what's left over. The
 * -45 dB floor sits below a quiet talker and above a line's noise floor, and
 * 0.3 s minimum keeps a pause between words from being counted as silence.
 *
 * A probe that can't be read returns zeroes, i.e. "no speech" — the caller
 * then skips the channel rather than sending unverified audio to a model that
 * will confabulate over it.
 */
async function analyseChannel(
  input: Uint8Array,
): Promise<{ meanVolumeDb: number; speechSeconds: number }> {
  try {
    const stderr = await runFfmpegStderr(
      input,
      ["-af", "volumedetect,silencedetect=noise=-45dB:d=0.3", "-f", "null", "-"],
      callTranscodeTimeoutMs(input),
    );
    const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr);
    const meanVolumeDb = mean ? Number(mean[1]) : -91;

    const dur = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(stderr);
    const totalSeconds = dur
      ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])
      : 0;
    if (!totalSeconds) return { meanVolumeDb, speechSeconds: 0 };

    let silent = 0;
    for (const m of stderr.matchAll(/silence_duration:\s*([\d.]+)/g)) {
      silent += Number(m[1]);
    }
    // A silence run still open when the file ends prints silence_start with no
    // matching duration — close it against the total so trailing silence counts.
    const starts = [...stderr.matchAll(/silence_start:\s*([\d.]+)/g)];
    const ends = [...stderr.matchAll(/silence_end:\s*([\d.]+)/g)];
    if (starts.length > ends.length) {
      const lastStart = Number(starts[starts.length - 1]![1]);
      if (lastStart < totalSeconds) silent += totalSeconds - lastStart;
    }
    return { meanVolumeDb, speechSeconds: Math.max(0, totalSeconds - silent) };
  } catch {
    return { meanVolumeDb: -91, speechSeconds: 0 };
  }
}

async function probeChannelCount(input: Uint8Array): Promise<number> {
  try {
    const stderr = await runFfmpegStderr(
      input,
      ["-f", "null", "-"],
      callTranscodeTimeoutMs(input),
    );
    // ffmpeg's stream line: "Audio: opus, 48000 Hz, stereo, fltp"
    if (/Audio:.*\bstereo\b/.test(stderr)) return 2;
    if (/Audio:.*\b(\d+) channels\b/.test(stderr)) {
      return Number(/Audio:.*\b(\d+) channels\b/.exec(stderr)![1]);
    }
    return 1;
  } catch {
    return 1;
  }
}

/** Run ffmpeg for its ANALYSIS output (stderr); the decoded audio is discarded.
 *  `timeoutMs` is per call site — a call-recording probe reads minutes of audio
 *  where a voice-note pass reads seconds. */
async function runFfmpegStderr(
  input: Uint8Array,
  args: string[],
  timeoutMs: number = TRANSCODE_TIMEOUT_MS,
): Promise<string> {
  return withFfmpegSlot(FFMPEG_WAIT_OUTBOUND_MS, async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccp-voice-"));
    const inPath = join(dir, "in");
    try {
      await writeFile(inPath, Buffer.from(input));
      return await new Promise<string>((resolve, reject) => {
        const ff = spawn(
          "ffmpeg",
          // `info` loglevel: volumedetect + the stream summary both report there.
          ["-hide_banner", "-loglevel", "info", "-i", inPath, ...args],
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
            reject(new Error("ffmpeg analysis timed out"));
          });
        }, timeoutMs);
        ff.on("error", (err) => finish(() => reject(err)));
        ff.stderr.on("data", (c: Buffer) => {
          if (stderr.length < 16_000) stderr += c.toString();
        });
        ff.on("close", () => finish(() => resolve(stderr)));
      });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

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

/**
 * Both funnels below run under the process-wide ffmpeg semaphore
 * (./ffmpeg-slots.ts) so a burst of concurrent voice notes can't spawn
 * unbounded decoders inside the api container's memory limit. They get the
 * LONGER outbound wait budget: unlike a thumbnail, skipping this transcode
 * means sending browser-native mp4, which Meta accepts and then fails to
 * deliver — so it should only degrade under sustained load, not a blip.
 * A slot timeout throws, and every caller already treats a throw as
 * "best-effort: send the original".
 */
async function transcode(
  input: Uint8Array,
  outputArgs: string[],
  timeoutMs: number = TRANSCODE_TIMEOUT_MS,
): Promise<Uint8Array<ArrayBuffer>> {
  return withFfmpegSlot(FFMPEG_WAIT_OUTBOUND_MS, async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccp-voice-"));
    const inPath = join(dir, "in");
    try {
      await writeFile(inPath, Buffer.from(input));
      return await runFfmpeg(inPath, outputArgs, timeoutMs);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
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
  timeoutMs: number = TRANSCODE_TIMEOUT_MS,
): Promise<Uint8Array<ArrayBuffer>> {
  return withFfmpegSlot(FFMPEG_WAIT_OUTBOUND_MS, async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccp-voice-"));
    const inPath = join(dir, "in");
    const outPath = join(dir, outName);
    try {
      await writeFile(inPath, Buffer.from(input));
      // Run ffmpeg to the temp file (stdout stays empty); `-y` overwrites.
      await runFfmpegToFile(inPath, [...outputArgs, "-y", outPath], timeoutMs);
      const buf = await readFile(outPath);
      if (buf.byteLength === 0) throw new Error("ffmpeg produced an empty file");
      const result = new Uint8Array(buf.byteLength);
      result.set(buf);
      return result;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

/** Run ffmpeg with a FILE output target (no stdout capture). Resolves on a clean
 *  exit, rejects on ENOENT / non-zero / timeout — same contract as {@link runFfmpeg}. */
function runFfmpegToFile(
  inPath: string,
  outputArgs: string[],
  timeoutMs: number = TRANSCODE_TIMEOUT_MS,
): Promise<void> {
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
    }, timeoutMs);
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

function runFfmpeg(
  inPath: string,
  outputArgs: string[],
  timeoutMs: number = TRANSCODE_TIMEOUT_MS,
): Promise<Uint8Array<ArrayBuffer>> {
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
    }, timeoutMs);

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
