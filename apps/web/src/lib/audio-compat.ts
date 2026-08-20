/**
 * Ogg/Opus playback compatibility — the client half of
 * apps/api/src/lib/media/playable-audio.ts.
 *
 * The app's canonical audio format is OGG/Opus (WhatsApp's voice-note format;
 * also the call-recording archive format). Safari — every macOS agent, every
 * iPhone — could not decode it in an <audio> element until 18.4, and reports
 * say it is still buggy there. Rather than sniff user agents, ask the media
 * element itself: when `canPlayType` says ogg/opus won't play, audio URLs gain
 * `playable=1` and the API serves a lazily-transcoded AAC variant instead.
 * Browsers that play ogg natively keep streaming the original bytes.
 */

let cached: boolean | null = null;

export function browserPlaysOggOpus(): boolean {
  if (cached !== null) return cached;
  if (typeof document === "undefined") return true; // SSR — the client re-asks
  try {
    const el = document.createElement("audio");
    cached =
      el.canPlayType('audio/ogg; codecs="opus"') !== "" ||
      el.canPlayType("audio/ogg") !== "";
  } catch {
    cached = true;
  }
  return cached;
}

const NEEDS_VARIANT = /^(audio\/(ogg|webm)|video\/webm)/i;

/**
 * The URL to hand an <audio> element. `mimeType` is the STORED type when the
 * caller knows it; pass `"audio/ogg"` for sources known to be ogg by
 * convention (call recordings). Unknown mime = leave the URL alone.
 */
export function playableAudioUrl(url: string, mimeType: string | null | undefined): string {
  if (!mimeType || !NEEDS_VARIANT.test(mimeType)) return url;
  if (browserPlaysOggOpus()) return url;
  return `${url}${url.includes("?") ? "&" : "?"}playable=1`;
}
