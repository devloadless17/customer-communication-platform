/**
 * Azure Speech TTS — the ONLY TTS path that sounds authentically Lebanese
 * (ar-LB neural voices Layla/Rami). OpenAI's voices are English-first and can't
 * do a real Lebanese accent, so voice-out routes here whenever the configured
 * voice is an Azure voice (see `isAzureVoice`). Called over the plain REST API
 * (no SDK dependency); returns mp3 bytes in the SAME shape as the OpenAI
 * `speak()` facade so `voice.ts` swaps providers transparently — the downstream
 * ogg/opus transcode, delivery, and text-fallback are all unchanged.
 *
 * Provider stays OpenAI for STT + the text brain; only synthesis moves here.
 */

function azureKey(): string | null {
  return process.env.AZURE_SPEECH_KEY || null;
}
function azureRegion(): string {
  return (process.env.AZURE_SPEECH_REGION || "").trim();
}

/** Whether Azure TTS can be used at all (key + region present). */
export function azureTtsConfigured(): boolean {
  return !!azureKey() && !!azureRegion();
}

/**
 * Azure neural voice names are locale-prefixed and end in "Neural"
 * (e.g. `ar-LB-LaylaNeural`). That naming is how we tell an Azure voice apart
 * from an OpenAI voice (`alloy`, `nova`, …) without a separate provider field.
 */
export function isAzureVoice(voiceId: string | null | undefined): boolean {
  return !!voiceId && /^[a-z]{2}-[A-Z]{2}-.+Neural$/.test(voiceId.trim());
}

function localeFromVoice(voiceId: string): string {
  return voiceId.match(/^([a-z]{2}-[A-Z]{2})-/)?.[1] ?? "ar-LB";
}

function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === "'" ? "&apos;" : "&quot;",
  );
}

/**
 * Synthesize `text` with an Azure neural voice. Returns mp3 bytes (24kHz mono),
 * matching the OpenAI `speak()` output shape. `speed` maps to SSML prosody rate
 * (1.0 → 0%, 0.9 → -10%, 1.25 → +25%). Throws on any failure so the caller falls
 * back to a text reply (same contract as OpenAI TTS).
 */
export async function speakAzure(opts: {
  voice: string;
  text: string;
  speed?: number;
}): Promise<{ bytes: Uint8Array; contentType: string }> {
  const key = azureKey();
  const region = azureRegion();
  if (!key || !region) throw new Error("azure_tts_not_configured");

  const locale = localeFromVoice(opts.voice);
  const rate =
    typeof opts.speed === "number" && opts.speed !== 1
      ? `${Math.round((opts.speed - 1) * 100)}%`
      : "0%";
  const ssml =
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}">` +
    `<voice name="${xmlEscape(opts.voice)}"><prosody rate="${rate}">${xmlEscape(opts.text)}</prosody></voice>` +
    `</speak>`;

  const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/ssml+xml",
      // mp3 out; send-media-internal transcodes to ogg/opus for WhatsApp, same
      // as the OpenAI path — so nothing downstream changes.
      "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
      "User-Agent": "ccp-ai-assistant",
    },
    body: ssml,
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`azure_tts_failed ${res.status} ${detail}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length) throw new Error("azure_tts_empty");
  return { bytes, contentType: "audio/mpeg" };
}
