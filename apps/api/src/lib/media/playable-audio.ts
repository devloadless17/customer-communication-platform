import { blobStorage } from "@/lib/blob-storage";
import { transcodeToM4a } from "./audio-transcode";

/**
 * Safari-playable variants of stored OGG/WEBM audio.
 *
 * The app's canonical audio format is OGG/Opus — WhatsApp's own voice-note
 * format, what inbound voice notes arrive as, what outbound recordings are
 * transcoded to, and what call recordings are archived as. Chrome, Firefox and
 * Edge all play it in an <audio> element. Safari does NOT: ogg-container
 * playback shipped only in Safari 18.4 (macOS Sequoia 15.4, March 2026-era
 * installs) and is still reported buggy — so on the Macs and iPhones most
 * customers actually run, every voice note and call recording rendered as
 * "audio unavailable". The customer-facing half is worse than the agent half:
 * webchat visitors get the agent's ogg voice note on iOS Safari.
 *
 * The fix is a lazily-materialized AAC/M4A shadow of the stored object:
 *   - `?playable=1` on the audio-serving routes calls `resolvePlayableAudio`.
 *   - Non-ogg/webm audio streams as-is (the param is a no-op — clients send it
 *     whenever their own `canPlayType` says ogg won't play, without needing to
 *     know what the server stored).
 *   - For ogg/webm, the variant lives at `<key>.m4a`; first play transcodes
 *     (bounded by the process-wide ffmpeg slots) and uploads it, every later
 *     play streams the cached copy — WITH range support, since it is a real
 *     stored object.
 *   - Any failure (ffmpeg missing, object too large, upload hiccup) falls back
 *     to streaming the ORIGINAL: a browser that can play ogg after all gets
 *     sound, one that can't is no worse off than before.
 *
 * BLOB-ORPHAN CONTRACT (§18): `<key>.m4a` is a derived CACHE, referenced by no
 * DB column on purpose — persisting a column for a cache would make every
 * producer of audio rows care about playback compatibility. Instead the orphan
 * sweeper treats `<base><PLAYABLE_AUDIO_SUFFIX>` as live exactly while its base
 * key is live (see blob-orphan.ts, same commit as this file). If the sweeper
 * ever deletes one anyway the only cost is a re-transcode on next play.
 */
export const PLAYABLE_AUDIO_SUFFIX = ".m4a";

/** Container types Safari can't decode in <audio>; everything else passes through. */
export function needsPlayableVariant(mime: string | null | undefined): boolean {
  if (!mime) return false;
  const m = mime.toLowerCase();
  return m.startsWith("audio/ogg") || m.startsWith("audio/webm") || m.startsWith("video/webm");
}

/** Refuse to buffer arbitrarily large originals into heap for a playback nicety.
 *  32 MB ≈ a two-hour call at the archival opus bitrate — everything real fits. */
const MAX_TRANSCODE_INPUT_BYTES = 32 * 1024 * 1024;

/** Concurrent first-plays of the SAME object dedupe onto one transcode. */
const inflight = new Map<string, Promise<string>>();

/**
 * Returns the key to stream for a playback-compat request: the cached/known
 * `<key>.m4a` variant when one is warranted and materializable, else the
 * original key.
 */
export async function resolvePlayableAudio(
  key: string,
  mime: string | null | undefined,
): Promise<string> {
  if (!needsPlayableVariant(mime)) return key;
  const variantKey = `${key}${PLAYABLE_AUDIO_SUFFIX}`;

  try {
    const head = await blobStorage.getObject(variantKey, { range: "bytes=0-0" });
    head.body.destroy();
    return variantKey;
  } catch {
    // Not materialized yet — fall through to build it.
  }

  const existing = inflight.get(variantKey);
  if (existing) return existing;

  const build = (async (): Promise<string> => {
    const obj = await blobStorage.getObject(key);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of obj.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.byteLength;
      if (total > MAX_TRANSCODE_INPUT_BYTES) {
        obj.body.destroy();
        throw new Error("playable_audio_input_too_large");
      }
      chunks.push(buf);
    }
    const m4a = await transcodeToM4a(new Uint8Array(Buffer.concat(chunks)));
    await blobStorage.putObject({ key: variantKey, bytes: m4a, contentType: "audio/mp4" });
    return variantKey;
  })()
    .catch(() => key) // best-effort: stream the original rather than 500 a play button
    .finally(() => inflight.delete(variantKey));

  inflight.set(variantKey, build);
  return build;
}
