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
  | "invalid_recipient"    // WA 131026 · IG linkage 2534013/14/29/41 — recipient invalid/unreachable
  | "rate_limited"         // WA 4/80007/130429/131048/131056 · social 613/80006 — rate/throughput limit
  | "per_user_marketing_cap" // WA 131049 — Meta's per-USER marketing frequency cap (not our rate limit)
  | "marketing_opt_out"     // WA 131050 — this recipient stopped marketing messages FROM US
  | "duplicate_person"      // OURS, not Meta's — customer-mode: this contact merged
                            // into a person the campaign had already reached
  | "portfolio_paced_drop"  // WA 135000 on a STATUS WEBHOOK only — dropped by a portfolio pacing review
                            // (the SAME code on a synchronous response is Meta's "Generic user error")
  | "template_unavailable" // WA 132001/132007/132015/132016 — template paused/disabled/not-approved (run-fatal)
  | "auth_expired"         // 190 — access token expired
  | "recipient_unavailable" // social 551/1545041 — person can't be messaged (blocked / deactivated)
  | "message_unavailable"  // social 10900/9000001 — referenced message deleted/unavailable
  | "unsupported_message"  // 131009/131051 — message TYPE/content not supported (not a bad recipient)
  | "duplicate_button_title" // 131009 + "Duplicate button title" — interactive buttons reuse a title
  | "call_permission_required" // WA 138006 — customer hasn't granted calling permission
  | "account_restricted"   // WA 368/131031 — WABA restricted/disabled/locked by policy enforcement
  | "contact_blocked"      // WA 130403 — WE blocked this person (Block Users API); unblock to resume
  | "country_not_allowed"  // WA 130497 — business category can't message this recipient's country
  | "billing_issue"        // WA 131042 — payment method / credit line problem on the WABA
  | "number_not_registered" // WA 131045/133010 — number not registered with Cloud API
  | "marketing_disabled"   // WA 131063 — marketing templates disabled on Cloud API (WhatsApp Manager flag)
  | "bsuid_needs_phone"    // WA 131062 — this message type needs a PHONE, not a BSUID address
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
  "duplicate_person",
  "portfolio_paced_drop",
  "template_unavailable",
  "auth_expired",
  "recipient_unavailable",
  "message_unavailable",
  "unsupported_message",
  "bsuid_needs_phone",
  "duplicate_button_title",
  "call_permission_required",
  "account_restricted",
  "contact_blocked",
  "country_not_allowed",
  "billing_issue",
  "number_not_registered",
  "marketing_disabled",
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
  // WhatsApp 131026; Instagram linkage errors (page not linked to the
  // IG account, or the recipient can't be resolved).
  if (
    numericCode === 131026 ||
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
  // ── 135000 is NOT handled here, on purpose ───────────────────────────────
  //
  // The code means two different things depending on where it arrives, and this
  // function only ever sees one of them:
  //
  //   - On a STATUS WEBHOOK it is a business-portfolio pacing DROP — the send
  //     succeeded and returned a wamid, the message sat `held`, and a review then
  //     dropped it. That reading lives in `classifyMetaStatusError`, which is the
  //     only path a webhook code travels.
  //   - On a SYNCHRONOUS send response it is Meta's "Generic user error" (error
  //     codes reference, HTTP 400): "Message failed to send because of an unknown
  //     error with your request parameters."
  //
  // This function is called only on send EXCEPTIONS, so mapping it to the pacing
  // reading here told an operator with a malformed request that their portfolio
  // was "paused from sending and creating templates pending Meta review" and sent
  // them to Business Suite to appeal an enforcement that never happened — while
  // the actual bad parameter went undiagnosed. It now falls through to
  // `provider_rejected`, which surfaces Meta's own `details` text.
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
  // cross-lane pause, forward-loop break. Two try-again-later cousins ride the
  // same family (error-codes reference): 131057 (account briefly in
  // maintenance mode, e.g. a throughput upgrade) and 131064 (messaging limited
  // over template-classification violations — lifts automatically after the
  // enforcement period). Each keeps its own message so an agent isn't sent
  // hunting for a rate problem that doesn't exist.
  if (
    numericCode === 4 ||
    numericCode === 80007 ||
    numericCode === 80006 ||
    numericCode === 130429 ||
    numericCode === 131048 ||
    numericCode === 131056 ||
    numericCode === 131057 ||
    numericCode === 131064 ||
    numericCode === 613
  ) {
    return {
      code: "rate_limited",
      // 131056 is the (business number, recipient) PAIR limit — the account is
      // fine; THIS person was messaged too fast (1 msg/6s sustained, ~45-msg
      // burst). The family message ("slow down the account") would send an
      // agent hunting for an account problem that doesn't exist.
      message:
        numericCode === 131056
          ? "WhatsApp limits how quickly you can message the same person — wait a few seconds and try again."
          : numericCode === 131057
            ? "The WhatsApp Business Account is briefly in maintenance (often a throughput upgrade) — try again shortly."
            : numericCode === 131064
              ? "Meta has limited this account's messaging over template-classification violations — the limit lifts automatically after the enforcement period."
              : "Meta is rate-limiting this account — slow down or wait.",
      detail,
      httpStatus,
    };
  }
  // Code 0 = "unable to authenticate the app user" — the token is expired or
  // invalidated (error-codes reference), same operator action as 190.
  if (numericCode === 190 || numericCode === 0) {
    return {
      code: "auth_expired",
      message: "The Meta access token expired — reconnect the channel in Settings.",
      detail,
      httpStatus,
    };
  }
  // ── Account-level enforcement / configuration — run-fatal family ─────────
  // 368 + 131031: the WABA is restricted, disabled, or locked by policy
  // enforcement (integrity errors). Fails every send identically; the health
  // panel's restriction banner (account_update webhooks) explains why.
  if (numericCode === 368 || numericCode === 131031) {
    return {
      code: "account_restricted",
      message:
        "Meta has restricted or locked this WhatsApp Business Account — check Business Support Home for the violation and any appeal.",
      detail,
      httpStatus,
    };
  }
  // 130403: WE blocked this recipient (Block Users API). Never retry —
  // unblock from the conversation menu to resume.
  if (numericCode === 130403) {
    return {
      code: "contact_blocked",
      message: "You've blocked this contact — unblock them to resume messaging.",
      detail,
      httpStatus,
    };
  }
  // 130497: the WABA's business category may not message this recipient's
  // country (Business Messaging Policy). Nothing wrong with the contact.
  if (numericCode === 130497) {
    return {
      code: "country_not_allowed",
      message:
        "Meta doesn't allow your business category to message people in this recipient's country.",
      detail,
      httpStatus,
    };
  }
  // 131042: payment method / credit line problem on the WABA.
  if (numericCode === 131042) {
    return {
      code: "billing_issue",
      message:
        "There's a problem with this account's WhatsApp billing (payment method / credit line) — fix it in Meta Business Suite, then retry.",
      detail,
      httpStatus,
    };
  }
  // 131045 (send failed: registration error) + 133010 (number not registered).
  if (numericCode === 131045 || numericCode === 133010) {
    return {
      code: "number_not_registered",
      message:
        "This WhatsApp number isn't registered with the Cloud API — register it in Settings → WhatsApp, then retry.",
      detail,
      httpStatus,
    };
  }
  // 131063: the WABA has `disable_marketing_messages_on_cloud_api` set, so
  // MARKETING templates are refused on Cloud API (a WhatsApp Manager setting;
  // utility/auth templates still send).
  if (numericCode === 131063) {
    return {
      code: "marketing_disabled",
      message:
        "Marketing templates are disabled for this account's Cloud API configuration — re-enable them in WhatsApp Manager, or use a utility template.",
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
  // 131062 — the ADDRESS shape is wrong for this message type, not the person.
  // "You can only send authentication messages to recipients' phone numbers, not
  // their business-scoped user IDs." Also returned when a marketing template
  // carries `bid_spec` and the recipient is a BSUID. The remedy is specific
  // enough to deserve its own code: get a phone for this contact.
  if (numericCode === 131062) {
    return {
      code: "bsuid_needs_phone",
      message:
        "This message type needs the contact's phone number — we only have their WhatsApp username.",
      detail,
      httpStatus,
    };
  }
  // 131051 is documented as "Unsupported message type" — the MESSAGE is wrong,
  // not the customer. It used to sit in `invalid_recipient`, the one bucket that
  // means "delete this contact", so a perfectly reachable customer was reported
  // as list-cleaning material because we sent them a type their client or the
  // account can't render.
  if (numericCode === 131009 || numericCode === 131051) {
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
    // Try-again-later cousins: maintenance mode + classification-violation
    // messaging limit (see the sync ladder's rate-limit family).
    case 131057:
    case 131064:
    case 613:
      return "rate_limited";
    case 190:
    case 0:
      return "auth_expired";
    // Account-level enforcement / configuration (error-codes reference) —
    // mirrors the sync ladder's run-fatal family.
    case 368:
    case 131031:
      return "account_restricted";
    // WE blocked this recipient (Block Users API). Also the drift signal that
    // the number was blocked out-of-band (WhatsApp Manager) — ingest reconciles
    // Contact.blockedAt off this classification.
    case 130403:
      return "contact_blocked";
    case 130497:
      return "country_not_allowed";
    case 131042:
      return "billing_issue";
    case 131045:
    case 133010:
      return "number_not_registered";
    case 131063:
      return "marketing_disabled";
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
    case 131062:
      return "bsuid_needs_phone";
    case 131009:
    // 131051 "Unsupported message type" — moved out of `invalid_recipient`,
    // which is the only bucket that tells the operator to delete the contact.
    // The recipient is fine; the message type is not supported.
    case 131051:
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
    // Fix-then-retry classes: once the operator repairs the account (billing,
    // registration, or the restriction lapses/appeal succeeds), re-sending the
    // same audience is expected to work.
    case "account_restricted":
    case "billing_issue":
    case "number_not_registered":
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
    //   contact_blocked        WE blocked them — a standing workspace choice.
    //                          Unblocking, not list-cleaning, is the fix.
    //   country_not_allowed    Meta's per-category country policy. The contact
    //                          is fine; the BUSINESS may not message there.
    case "contact_blocked":
    case "country_not_allowed":
      return "suppress";
    // OUR content, not their number. Every recipient fails identically until
    // the template or the message changes, so pointing the operator at their
    // contact list is exactly the wrong direction.
    case "unsupported_message":
    case "duplicate_button_title":
    case "message_unavailable":
    // 131062 — the message type needs a phone and we addressed a BSUID. Every
    // BSUID-only recipient fails identically until the template changes or we
    // obtain a phone, so it is content, not a bad contact.
    case "bsuid_needs_phone":
    // A WhatsApp Manager configuration refusing MARKETING templates — every
    // recipient fails identically until the flag or the template changes.
    case "marketing_disabled":
      return "content";
    case "duplicate_person":
      // Deliberately suppressed, never retryable: the person DID receive this
      // campaign — on their other contact. Retrying is the double-send the
      // skip exists to prevent, and the contact is not "bad" either.
      return "suppress";
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

/**
 * THE "was this send provably NOT delivered?" rule — the one classification
 * every idempotency ledger must agree on, because it decides whether a claim
 * is RELEASED (the partner/agent may safely retry the same key) or RETAINED
 * (Meta may have accepted; a retry would double-send a billed message).
 *
 * Provably-not-sent = Meta refused before accepting:
 *   - a Meta 4xx (definitive rejection), OR
 *   - `rate_limited` at ANY status — Meta never processed it, and this is what
 *     makes a throttled send actually retryable instead of dying as
 *     `send_in_progress_or_lost`.
 * Everything else — 5xx, transport error, timeout, null normalization — is
 * AMBIGUOUS and must retain.
 *
 * Extracted 2026-07-27: the worker carried the `rate_limited` carve-out while
 * the three /v1 sites checked `httpStatus < 500` only, so a rate-limit signalled
 * with a ≥500 status stranded a partner's key on a message that was never sent.
 */
export function isProvablyNotSent(normalized: NormalizedSendError | null): boolean {
  if (!normalized) return false; // transport error / timeout → ambiguous
  return normalized.httpStatus < 500 || normalized.code === "rate_limited";
}

/**
 * WhatsApp 131056 — the (business number, recipient) PAIR rate limit: 1 msg
 * per 6s sustained to the same person, with a ~45-message burst allowance that
 * borrows from future quota (a drained burst can need minutes to repay).
 *
 * It shares the `rate_limited` family (retry machinery must engage) but its
 * SCOPE is one recipient, not the number — so callers that react to
 * `rate_limited` with number-wide measures (the broadcast 429 streak, the
 * cross-lane pause, the whole-run park) must carve this code out and handle
 * the single recipient instead. These helpers are the one place that decision
 * can be read from a thrown error / error body.
 */
export function isPairRateLimitBody(body: string | null | undefined): boolean {
  if (!body) return false;
  return extractMetaError(body).code === 131056;
}

export function isPairRateLimitError(err: unknown): boolean {
  return err instanceof MetaSendError && isPairRateLimitBody(err.body);
}
