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
  | "per_user_marketing_cap" // WA 131049 — Meta's per-USER marketing frequency cap (not our rate limit)
  | "marketing_opt_out"     // WA 131050 — this recipient stopped marketing messages FROM US
  | "portfolio_paced_drop"  // WA 135000 — dropped by a business-portfolio pacing review
  | "template_unavailable" // WA 132001/132007/132015/132016 — template paused/disabled/not-approved (run-fatal)
  | "auth_expired"         // 190 — access token expired
  | "recipient_unavailable" // social 551/1545041 — person can't be messaged (blocked / deactivated)
  | "message_unavailable"  // social 10900/9000001 — referenced message deleted/unavailable
  | "unsupported_message"  // 131009 — content type not supported on this account
  | "duplicate_button_title" // 131009 + "Duplicate button title" — interactive buttons reuse a title
  | "call_permission_required" // WA 138006 — customer hasn't granted calling permission
  | "provider_rejected";   // catch-all for anything else MetaSendError-shaped

/**
 * Every `MetaErrorCode`, as a runtime value.
 *
 * Exists so the campaign report's label map can be checked for completeness by a
 * test — a TYPE union can't be iterated, which is exactly how two codes reached
 * production with no label and rendered as raw snake_case in the report.
 * Keep in sync with the union above; the test fails if a label is missing, and
 * this list is the thing that makes that check possible.
 */
export const ALL_META_ERROR_CODES = [
  "outside_24h_window",
  "invalid_recipient",
  "rate_limited",
  "per_user_marketing_cap",
  "marketing_opt_out",
  "portfolio_paced_drop",
  "template_unavailable",
  "auth_expired",
  "recipient_unavailable",
  "message_unavailable",
  "unsupported_message",
  "duplicate_button_title",
  "call_permission_required",
  "provider_rejected",
] as const satisfies ReadonlyArray<MetaErrorCode>;

// `satisfies` above catches an entry that ISN'T a MetaErrorCode. This catches the
// other direction — a new union member that was never added to the list — which
// is the one that actually happens. A compile error here means: add your new
// code to ALL_META_ERROR_CODES (and the test will then tell you to label it).
type MetaErrorCodeMissingFromList = Exclude<
  MetaErrorCode,
  (typeof ALL_META_ERROR_CODES)[number]
>;
const _allMetaErrorCodesListed: MetaErrorCodeMissingFromList extends never
  ? true
  : never = true;
void _allMetaErrorCodesListed;

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
  // ── Marketing message not delivered ──────────────────────────────────────
  // WhatsApp 131049 — "This message was not delivered to maintain healthy
  // ecosystem engagement." It is NOT our account's throughput/rate limit —
  // retrying or backing off the whole broadcast does nothing — so it must NOT
  // fold into `rate_limited` (which engages the 429 streak + cross-lane pause).
  // A per-recipient permanent skip. Checked BEFORE the rate-limited family so
  // the shared body-regex can't misroute it.
  //
  // The code carries TWO distinct causes and we cannot tell them apart from the
  // response:
  //   1. The recipient is over Meta's per-USER marketing frequency cap (across
  //      all businesses, rolling window) — temporary, clears on its own.
  //   2. The recipient is in the UNITED STATES. Since 2025-04-01 marketing
  //      messages to US users are not delivered AT ALL, on every Business
  //      Messaging API including Cloud API — permanent, and no amount of
  //      retrying will ever succeed.
  // The phone prefix can't separate them either (+1 is US, Canada and the
  // Caribbean). So the message names both rather than asserting the temporary
  // one: telling an operator a US campaign is capped "right now" invites them to
  // keep retrying a send that can never land.
  if (numericCode === 131049) {
    return {
      code: "per_user_marketing_cap",
      message:
        "Meta didn't deliver this marketing message. Either the recipient is over " +
        "WhatsApp's per-user marketing frequency cap (temporary), or they're in the " +
        "United States, where marketing messages haven't been delivered since April " +
        "2025 (permanent — retrying won't help).",
      detail,
      httpStatus,
    };
  }
  // ── Recipient stopped marketing from THIS business ───────────────────────
  // WhatsApp 131050. Distinct from 131049 in the one way that matters: this is
  // a deliberate, standing choice by the recipient about US specifically, not a
  // frequency cap that clears. Every future marketing send to them will fail the
  // same way, so it is worth suppressing rather than retrying — see the ingest
  // status path, which mirrors it onto the contact's marketing opt-out.
  if (numericCode === 131050) {
    return {
      code: "marketing_opt_out",
      message:
        "This recipient has turned off marketing messages from your business in WhatsApp. " +
        "They'll still receive utility and authentication messages.",
      detail,
      httpStatus,
    };
  }
  // ── Business-portfolio pacing ────────────────────────────────────────────
  // WhatsApp 135000 — this message was HELD by portfolio pacing and then
  // DROPPED, because the feedback gathered between batches suggested suspicious
  // activity. Arrives as a `failed` status webhook, not as a send rejection: the
  // send itself succeeded and returned a wamid hours earlier.
  //
  // Deliberately its own code rather than the generic bucket, because the cause
  // and the fix are unlike every other failure here. Nothing about THIS
  // recipient is wrong — retrying them changes nothing, and the whole portfolio
  // is now blocked from sending or creating templates pending review. It is an
  // account-level event that happens to be reported per message.
  if (numericCode === 135000) {
    return {
      code: "portfolio_paced_drop",
      message:
        "WhatsApp dropped this message during a business-portfolio review. Your portfolio " +
        "is paused from sending and creating templates while Meta reviews recent activity — " +
        "check Business Suite and email for the notification, and appeal there if needed.",
      detail,
      httpStatus,
    };
  }
  // ── Calling permission ───────────────────────────────────────────────────
  // WhatsApp 138006 — the customer hasn't granted this business number
  // permission to call them. Terminal for THIS attempt and separately
  // actionable ("ask them for permission"), so it must not fold into the
  // generic `provider_rejected` bucket that renders as an unexplained failure.
  // Also tells the caller its cached grant is stale and should be dropped.
  if (numericCode === 138006) {
    return {
      code: "call_permission_required",
      message:
        "This customer hasn't allowed calls from you yet — send them a call permission request first.",
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
  // ── Template paused / disabled / not-approved — run-fatal for a broadcast ─
  // 132001 (template doesn't exist / not approved in this language), 132007
  // (paused for a policy/quality violation), 132015 (paused), 132016 (disabled).
  // Every recipient of a broadcast shares ONE template, so any of these fails
  // ALL of them identically. The broadcast runner treats this as fatal for the
  // whole run (pause + operator notice) instead of burning the audience as
  // false per-recipient failures. (Content/param codes like 132000/132005/132012
  // stay `provider_rejected` — those can be per-recipient.)
  if (
    numericCode === 132001 ||
    numericCode === 132007 ||
    numericCode === 132015 ||
    numericCode === 132016
  ) {
    return {
      code: "template_unavailable",
      message:
        "This WhatsApp template is paused, disabled, or no longer approved — the send was stopped so you can fix the template and retry.",
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

/**
 * Classify a Meta error code that arrived on an async DELIVERY-STATUS webhook
 * (`statuses[].errors[0].code`) into the same `MetaErrorCode` vocabulary the
 * send path uses. This is what lets the campaign failure report be a single
 * `GROUP BY errorCode` instead of two disjoint taxonomies stitched together in
 * the UI.
 *
 * Deliberately SEPARATE from `normalizeMetaSendError` rather than sharing an
 * extracted helper. That function classifies a THROWN `MetaSendError` and its
 * ladder depends on things a status webhook simply does not have: a response
 * body (several branches fall back to body regexes — the 24h-window match, the
 * duplicate-button-title match) and an `error_subcode` (the social-channel
 * discriminator). Its branch ORDER is also load-bearing — 131049 is checked
 * before the rate-limit family precisely so a shared body regex can't misroute
 * it. Refactoring that ladder to serve a code-only caller would mean editing
 * the billed, irreversible send path to add a reporting feature, for no
 * behavioural gain. One shared VOCABULARY, two classifiers, is the safer seam.
 *
 * Codes here mirror the numeric groupings in `normalizeMetaSendError`; keep the
 * two in sync when Meta adds a code. Unknown/absent → `provider_rejected`, the
 * same catch-all, so an unmapped code degrades gracefully instead of failing
 * the webhook write.
 */
export function classifyMetaStatusError(code: number | null | undefined): MetaErrorCode {
  if (typeof code !== "number") return "provider_rejected";
  switch (code) {
    case 131047:
    case 2534022:
      return "outside_24h_window";
    case 131026:
    case 131051:
    case 2534013:
    case 2534014:
    case 2534029:
    case 2534041:
      return "invalid_recipient";
    // Per-USER marketing frequency cap. Only ever arrives post-acceptance, so
    // the status webhook is the ONLY place it is ever observed — it is
    // invisible to the send path entirely.
    case 131049:
      return "per_user_marketing_cap";
    // The recipient used WhatsApp's own "Offers and announcements" setting to
    // STOP marketing messages from this business. Meta accepts the send and then
    // fails it, so — like 131049 — it is only ever seen on the status webhook.
    case 131050:
      return "marketing_opt_out";
    // Dropped by a business-portfolio pacing review. Like the two above, this
    // is ONLY ever a status webhook: the send returned a wamid and the message
    // sat `held` until the review dropped it.
    case 135000:
      return "portfolio_paced_drop";
    case 4:
    case 80006:
    case 80007:
    case 130429:
    case 131048:
    case 131056:
    case 613:
      return "rate_limited";
    case 190:
      return "auth_expired";
    case 132001:
    case 132007:
    case 132015:
    case 132016:
      return "template_unavailable";
    case 551:
      return "recipient_unavailable";
    case 10900:
    case 9000001:
      return "message_unavailable";
    case 131009:
      return "unsupported_message";
    default:
      return "provider_rejected";
  }
}

/**
 * Actionability buckets for the campaign failure report. Each normalized code
 * maps to what the operator can actually DO about it — this is what turns a
 * failure list into a workflow (retry these / clean these / leave these alone)
 * rather than a wall of red text.
 *
 *  - `retryable`  — transient; re-sending the same audience can succeed.
 *  - `permanent`  — the recipient address is bad. List-hygiene candidates.
 *  - `suppress`   — deliverable in principle, but Meta/user policy blocked it.
 *                   Retrying is wasteful and hurts the number's quality rating.
 */
/**
 * What the operator should DO about a failure — and the labels the report puts
 * on it, which is why the names matter more than they look:
 *
 *   retryable — "Can retry".    Transient; re-sending is expected to work.
 *   permanent — "Clean list".   Something is wrong with the RECIPIENT. This one
 *                               tells someone to REMOVE a contact, so it must
 *                               never catch a person who is perfectly reachable.
 *   suppress  — "Don't retry".  Leave them alone, and keep them: a standing
 *                               choice or a limit, not a bad number.
 *   content   — "Fix the message". Our fault, not theirs. Every recipient fails
 *                               identically until the template changes.
 */
export type FailureBucket = "retryable" | "permanent" | "suppress" | "content";

export function failureBucket(code: MetaErrorCode | string | null): FailureBucket {
  switch (code) {
    case "rate_limited":
    case "template_unavailable":
    case "auth_expired":
      return "retryable";
    // The ONLY bucket that says "delete this contact" — reserved for a number
    // that genuinely isn't reachable.
    case "invalid_recipient":
      return "permanent";
    // "Don't retry" — and, just as important, don't delete. Each of these is a
    // standing choice, a limit, or a decision Meta made; the person is a
    // perfectly good contact:
    //   marketing_opt_out      they stopped MARKETING from us and still get
    //                          utility + authentication messages. The default
    //                          bucket used to render this as "clean list",
    //                          i.e. delete a live customer over a preference.
    //   portfolio_paced_drop   Meta dropped it in a portfolio review. Nothing
    //                          about this recipient is wrong at all.
    //   call_permission_required  they just haven't granted calling permission.
    case "per_user_marketing_cap":
    case "recipient_unavailable":
    case "outside_24h_window":
    case "marketing_opt_out":
    case "portfolio_paced_drop":
    case "call_permission_required":
      return "suppress";
    // OUR content, not their number. Every recipient fails identically until
    // the template or the message changes, so pointing the operator at their
    // contact list is exactly the wrong direction.
    case "unsupported_message":
    case "duplicate_button_title":
    case "message_unavailable":
      return "content";
    default:
      // Unknown / provider_rejected. Not safely retryable in bulk, and we can't
      // claim the recipient is bad either — so it stays in the conservative
      // bucket rather than instructing anyone to change their list.
      return "suppress";
  }
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
