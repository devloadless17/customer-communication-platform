/**
 * Meta send-error classification — shared by the WhatsApp provider (meta.ts) and
 * the social providers (Messenger / Instagram, via meta-graph.ts). Lives in its
 * own module so meta-graph.ts can throw `MetaSendError` without importing the
 * WhatsApp send path (and without a cycle). meta.ts re-exports these for
 * back-compat with every existing `@/lib/providers/meta` import.
 *
 * The `code` is the only thing UI / workflows / broadcast pacing branch on — a
 * social send that used to throw a bare `Error` (so `normalizeMetaSendError`
 * returned null → treated as an ambiguous transport error everywhere) now
 * classifies the same way a WhatsApp send does: rate-limit backoff engages,
 * the failed bubble shows a real reason, and the idempotency ledger stops
 * guessing. Message copy is provider-neutral so it reads correctly on all three
 * channels.
 *
 * Meta error references:
 *   WhatsApp — https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 *   Messenger/IG — https://developers.facebook.com/docs/messenger-platform/error-codes
 */

/** Thrown by every Meta send (WhatsApp `metaFetch` + social `graphPostJson`). */
export class MetaSendError extends Error {
  readonly httpStatus: number;
  readonly body: string;
  constructor(message: string, httpStatus: number, body: string) {
    super(message);
    this.name = "MetaSendError";
    this.httpStatus = httpStatus;
    this.body = body;
  }
}

/**
 * Stable error code surfaced to the UI / external API consumers. Substring-
 * matching Meta's free-form `body` string in every callsite was both fragile
 * (one wording change from Meta breaks the match) and inconsistent (only the
 * forward route did it). One translator, used everywhere.
 *
 * `code` is the only thing UI / n8n flows should branch on. `message` is a
 * one-liner safe to show as the toast. `detail` is the raw Meta body for the
 * dev console.
 */
export type MetaErrorCode =
  | "outside_24h_window"   // WA 131047 · social 10/2018278 · 2534022 — messaging window closed
  | "invalid_recipient"    // WA 131026/131051 · IG linkage 2534013/14/29/41 — recipient invalid/unreachable
  | "rate_limited"         // WA 4/80007/130429/131048/131056 · social 613/80006 — rate/throughput limit
  | "auth_expired"         // 190 — access token expired
  | "recipient_unavailable" // social 551/1545041 — person can't be messaged (blocked / deactivated)
  | "message_unavailable"  // social 10900/9000001 — referenced message deleted/unavailable
  | "unsupported_message"  // 131009 — content type not supported on this account
  | "duplicate_button_title" // 131009 + "Duplicate button title" — interactive buttons reuse a title
  | "provider_rejected";   // catch-all for anything else MetaSendError-shaped

export interface NormalizedSendError {
  code: MetaErrorCode;
  /** UI-safe one-liner. */
  message: string;
  /** Raw Meta body (truncated). For logs / dev console. */
  detail: string;
  /** Original HTTP status from Meta. */
  httpStatus: number;
}

/**
 * Translate a thrown `MetaSendError` into the normalized shape above. Detection
 * uses Meta's numeric error code + subcode first, then a few well-known
 * substring fallbacks for cases where the body shape varies. Order matters: the
 * first match wins. Handles both the WhatsApp code space and the Messenger/
 * Instagram code space (they don't overlap, so one function covers all three).
 *
 * Returns `null` for non-Meta errors so callers can keep their own catch-all
 * 502 path.
 */
export function normalizeMetaSendError(err: unknown): NormalizedSendError | null {
  if (!(err instanceof MetaSendError)) return null;
  const body = err.body;
  const httpStatus = err.httpStatus;
  const detail = body.slice(0, 500);

  // Body is usually JSON like `{"error":{"code":131047,"error_subcode":...}}`.
  // We read code + subcode (social channels put the discriminator in subcode).
  const { code: numericCode, subcode } = extractMetaError(body);

  // ── Messaging window closed ──────────────────────────────────────────────
  // WhatsApp 131047 (re-engagement); Messenger/IG code 10 + subcode 2018278,
  // and the 2534022 "message sent outside allowed window" variant.
  if (
    numericCode === 131047 ||
    subcode === 2018278 ||
    numericCode === 2534022 ||
    /re-engagement|outside.*(allowed|24).*(window|hours)|24 hours/i.test(body)
  ) {
    return {
      code: "outside_24h_window",
      message: "The messaging window has closed — you can't send a free-form message right now.",
      detail,
      httpStatus,
    };
  }
  // ── Recipient invalid / not reachable on this channel ────────────────────
  // WhatsApp 131026/131051; Instagram linkage errors (page not linked to the
  // IG account, or the recipient can't be resolved).
  if (
    numericCode === 131026 ||
    numericCode === 131051 ||
    numericCode === 2534013 ||
    numericCode === 2534014 ||
    numericCode === 2534029 ||
    numericCode === 2534041
  ) {
    return {
      code: "invalid_recipient",
      message: "The recipient isn't valid or can't be reached on this channel.",
      detail,
      httpStatus,
    };
  }
  // ── Rate / throughput / messaging-limit family ───────────────────────────
  // WhatsApp 4/80007/130429/131048/131056; social 613 ("Calls to this API
  // exceeded the rate limit") + 80006. All normalize to `rate_limited` so the
  // retry machinery engages: send-worker retry, broadcast 429 streak backoff +
  // cross-lane pause, forward-loop break.
  if (
    numericCode === 4 ||
    numericCode === 80007 ||
    numericCode === 80006 ||
    numericCode === 130429 ||
    numericCode === 131048 ||
    numericCode === 131056 ||
    numericCode === 613
  ) {
    return {
      code: "rate_limited",
      message: "Meta is rate-limiting this account — slow down or wait.",
      detail,
      httpStatus,
    };
  }
  if (numericCode === 190) {
    return {
      code: "auth_expired",
      message: "The Meta access token expired — reconnect the channel in Settings.",
      detail,
      httpStatus,
    };
  }
  // ── Recipient can't be messaged (blocked / deactivated) — social ─────────
  if (numericCode === 551 || subcode === 1545041) {
    return {
      code: "recipient_unavailable",
      message: "This person can't be messaged right now (they may have blocked the account or deactivated).",
      detail,
      httpStatus,
    };
  }
  // ── Referenced message deleted / unavailable — social ────────────────────
  if (numericCode === 10900 || numericCode === 9000001) {
    return {
      code: "message_unavailable",
      message: "The message this refers to is no longer available.",
      detail,
      httpStatus,
    };
  }
  if (numericCode === 131009) {
    // 131009 is a catch-all "Parameter value is not valid". Meta puts the
    // specific reason in error_data.details. Interactive button sends with
    // repeated titles surface as "Duplicate button title" — map that to an
    // actionable message instead of the generic "unsupported" copy.
    if (/duplicate\s+button\s+title/i.test(body)) {
      return {
        code: "duplicate_button_title",
        message: "Each button needs a unique title — WhatsApp rejects duplicates.",
        detail,
        httpStatus,
      };
    }
    return {
      code: "unsupported_message",
      message: "This message type isn't supported on this account.",
      detail,
      httpStatus,
    };
  }
  return {
    code: "provider_rejected",
    message: `Meta rejected the send: ${detail.slice(0, 160)}`,
    detail,
    httpStatus,
  };
}

/** Pull Meta's numeric `error.code` + `error.error_subcode` from a body string. */
function extractMetaError(body: string): { code: number | null; subcode: number | null } {
  try {
    const json = JSON.parse(body) as {
      error?: { code?: unknown; error_subcode?: unknown };
    };
    const code = typeof json.error?.code === "number" ? json.error.code : null;
    const subcode =
      typeof json.error?.error_subcode === "number" ? json.error.error_subcode : null;
    if (code !== null || subcode !== null) return { code, subcode };
  } catch {
    // Not JSON — fall through to regex.
  }
  const codeMatch = body.match(/"code"\s*:\s*(\d+)/);
  const subMatch = body.match(/"error_subcode"\s*:\s*(\d+)/);
  return {
    code: codeMatch ? Number(codeMatch[1]) : null,
    subcode: subMatch ? Number(subMatch[1]) : null,
  };
}
