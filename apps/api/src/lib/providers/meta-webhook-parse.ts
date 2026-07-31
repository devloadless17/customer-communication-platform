import { mapTemplateCategory, mapTemplateStatus } from "./meta-template-parse";
import type { BlockUserOutcome, BlockUsersResult, NormalizedCallEvent, NormalizedChannelHealth, NormalizedTemplateStatusUpdate } from "@ccp/shared/providers/types";
import type { MessageStatus } from "@ccp/shared/types";

/**
 * WhatsApp WEBHOOK parsing — stage 2 of the meta.ts split (2026-07-31).
 * The pure envelope→NormalizedEvent family: message/status/call/template/
 * account-health parsers and their micro-mappers, plus the wire interfaces
 * they read. No transport lives here. meta.ts imports these and re-exports
 * the public names (its facade role).
 */

export interface MetaContact {
  /**
   * `username` lives INSIDE `profile`, alongside `name` — verified 2026-07-30
   * against Meta's business-scoped-user-ids reference, which shows
   * `"profile": { "name": …, "username": "<USERNAME>" }`. It was previously
   * declared as a sibling of `wa_id`, so `contact.username` was always
   * undefined and the @username — the only human-readable handle a phone-less
   * BSUID contact has — never reached the inbox.
   */
  profile?: { name?: string; username?: string; country_code?: string };
  /** The customer's phone. CONDITIONAL since the 2026 BSUID rollout: Meta omits
   *  it unless we've messaged/called that number in the last 30 days. */
  wa_id?: string;
  /** The business-scoped user id (BSUID), e.g. "LB.946402411360800". Present on
   *  inbound webhooks since the April-2026 rollout, whether or not the customer
   *  enabled a username. Also stamped on `messages[]` as `from_user_id`. */
  user_id?: string;
  /** Kept for wire tolerance only — the documented location is `profile.username`
   *  above. Read as a fallback so a Meta-side move can't silently blank it. */
  username?: string;
  /** Parent portfolio BSUID ("US.ENT.…") for multi-portfolio businesses. */
  parent_user_id?: string;
}

export interface MetaInteractivePayload {
  /**
   * We consume `button_reply` / `list_reply`; Meta also sends `nfm_reply` (a
   * submitted WhatsApp Flow) and adds new subtypes over time. Typed as an open
   * string so the parser is forced to handle the unknown case rather than having
   * the compiler assure us it can't happen — it can, and it did.
   */
  type?:
    | "button_reply"
    | "list_reply"
    | "call_permission_reply"
    | (string & {});
  button_reply?: { id?: string; title?: string };
  list_reply?: { id?: string; title?: string; description?: string };
  /**
   * A Native Flow Message submission — a WhatsApp Flow, or an address-message
   * form (interactive `address_message`, India). `response_json` is the field
   * data (retained via rawPayload); `body` is the HUMAN-READABLE summary the
   * customer sees in their own chat (for an address form: the address itself),
   * which is what the inbox bubble should show. `name` discriminates the form
   * kind (`address_message`, a Flow's name, …).
   */
  nfm_reply?: { response_json?: string; name?: string; body?: string };
  /**
   * The customer's answer to a call-permission request — this is how WhatsApp
   * delivers permission grants and revocations. It is NOT a calling webhook,
   * which is easy to get wrong and expensive when you do: treating it as an
   * ordinary interactive reply means permission is never recorded and the
   * customer's decision renders as a junk bubble in the thread.
   */
  call_permission_reply?: {
    response?: "accept" | "reject" | (string & {});
    /** True ⇒ the grant never expires. */
    is_permanent?: boolean;
    /** Epoch seconds; present only on a temporary grant. */
    expiration_timestamp?: string | number;
    /** `automatic` = Meta acted (callback grant, or revoke after unanswered calls). */
    response_source?: "user_action" | "automatic" | (string & {});
  };
}

export /**
 * A row under `value.statuses[]`. Meta reuses this array for TWO unrelated
 * things, discriminated by `type`:
 *
 *   - absent/other → a MESSAGE delivery status (sent/delivered/read/failed)
 *   - "call"       → a CALL progress status (RINGING / ACCEPTED / REJECTED)
 *
 * The call variant is the authoritative live signal for a business-initiated
 * call: `ACCEPTED` is the moment the customer actually picked up. Routing the
 * whole array into the message-status handler silently discarded it, which is
 * why a browser-side audio heuristic was once used to guess at pickup.
 */
interface MetaStatus {
  id?: string;
  status?: string;
  timestamp?: string;
  recipient_id?: string;
  /** "call" marks this as a call-progress status rather than a message status. */
  type?: string;
  /**
   * The recipient's BSUID. On CALL statuses since May 2026; on MESSAGE
   * statuses the BSUID page documents it unconditionally once the rollout
   * reaches the account — even for plain phone sends — making delivery
   * statuses the primary BSUID-learning channel for active threads.
   */
  recipient_user_id?: string;
  /** Parent BSUID ("US.ENT.…"), when the business is enrolled. */
  recipient_parent_user_id?: string;
  /** Echoed from the `biz_opaque_callback_data` we sent when placing the call. */
  biz_opaque_callback_data?: string;
  /**
   * Billing metadata Meta attaches to a status (usually `sent`). Carries the
   * conversation CATEGORY and whether it is billable — never a price, because
   * rates are per-country cards that change quarterly. The campaign report
   * counts billable conversations by category and lets the operator apply their
   * own rate card; storing a computed amount would freeze a wrong number into
   * the audit trail.
   */
  pricing?: {
    billable?: boolean;
    pricing_model?: string;
    category?: string;
    /**
     * "regular" | "free_customer_service" | "free_entry_point". Meta is
     * deprecating `billable` in a future Graph version in favour of
     * type+category — the parser derives billable from this when the boolean
     * is absent, so campaign billing counts survive the deprecation.
     */
    type?: string;
  };
  /**
   * Omitted entirely on v24.0+ (except free-entry-point windows). Typed for
   * wire completeness; deliberately never consumed — the 24h customer-service
   * window is tracked from our own lastInboundAt, not Meta's
   * expiration_timestamp, so the v24 omission costs nothing.
   */
  conversation?: {
    id?: string;
    origin?: { type?: string };
  };
  /** "group" when the message was sent to a group; recipient_id is then the
   *  GROUP id (which can be purely numeric — never treat it as a phone). */
  recipient_type?: string;
  /** The participant's phone number on group statuses. */
  recipient_participant_id?: string;
  /** Present on `status: "failed"` — the actual delivery-rejection reason. */
  errors?: Array<{
    code?: number;
    title?: string;
    message?: string;
    error_data?: { details?: string };
  }>;
}

export /**
 * One call row inside a `field: "calls"` webhook, under `value.calls[]`.
 * Field names mirror Meta's wire format; the parser maps `event` to our finer
 * `NormalizedCallEvent.phase`.
 *
 * NOTE: this array is NOT the whole calling webhook. Business-initiated call
 * PROGRESS (ringing / accepted / rejected) arrives under `value.statuses[]`
 * with `type: "call"` — see MetaStatus. And permission grants don't come
 * through the calls webhook at all; they are interactive MESSAGES
 * (`call_permission_reply`). Missing both of those was why outbound calling
 * had no live pickup signal and no working permission flow.
 */
interface MetaCall {
  id?: string;
  from?: string;
  to?: string;
  /** BSUIDs, present since the 2026 rollout. The `from`/`to` phone fields are
   *  omitted for customers who adopted a username, so these can be the ONLY
   *  identity on the row. */
  from_user_id?: string;
  to_user_id?: string;
  from_parent_user_id?: string;
  to_parent_user_id?: string;
  timestamp?: string;
  /**
   * Documented `calls[]` event values:
   *   "connect"      → inbound: customer rang us; outbound: media setup (NOT pickup)
   *   "terminate"    → call ended (see `status` for the reason)
   *   "call_created" → SIP-mode only; we never enable SIP, so it isn't handled
   * Recording/transcription artifacts add more (see the unhandled-event log in
   * mapMetaCallPhase, which exists so a new event is visible rather than lost).
   */
  event?: string;
  /** UPPER_CASE in real payloads ("USER_INITIATED" / "BUSINESS_INITIATED"). */
  direction?: string;
  /**
   * Terminate-only status. Meta documents exactly two values, "COMPLETED" and
   * "FAILED" — note that an UNANSWERED business-initiated call also terminates
   * as COMPLETED, so this field alone cannot tell you whether anyone picked up.
   * The timing fields below are the discriminator.
   */
  status?: string;
  /** SDP payload for setup. */
  session?: { sdp_type?: string; sdp?: string };
  /** Second documented home for the connect ANSWER on business-initiated
   *  calls (business-initiated-calls doc, Part 3) — the sample carries the
   *  SDP in BOTH `session` and here. Read as a fallback only. */
  connection?: { webrtc?: { sdp?: string } };
  /**
   * Terminal-only timing, documented as present "only when the call was picked
   * up by the other party":
   *   start_time — epoch seconds of REAL customer pickup
   *   end_time   — epoch seconds the call ended
   *   duration   — connected talk-time in seconds
   * Their PRESENCE is therefore the authoritative "was this answered?" signal.
   * This is doc-confirmed, not a heuristic — do not "simplify" it to read
   * `status` instead.
   */
  duration?: number;
  start_time?: string | number;
  end_time?: string | number;
  /** Echoed back from the `biz_opaque_callback_data` we send on connect/accept. */
  biz_opaque_callback_data?: string;
  /** Opaque attribution string from a call BUTTON the customer tapped. */
  cta_payload?: string;
  /** Opaque attribution string from a `wa.me/call/...?biz_payload=` deep link. */
  deeplink_payload?: string;
  /** `call_recording_available` payload: the finished recording's media asset.
   *  The `url` is a 5-minute signed link; the durable handle is `audio.id`
   *  (re-fetchable via the Media API for 7 days). */
  call_recording?: {
    type?: string;
    audio?: {
      id?: string;
      sha256?: string;
      mime_type?: string;
      url?: string;
    };
  };
  /**
   * Transcript-available payload — same media semantics as call_recording, but
   * the asset is a JSON transcript document.
   *
   * ONE field spelling, confirmed 2026-07-30 against the call-transcription
   * doc: the artifact key is `call_transcript.document`. A second
   * `call_transcription` object used to be typed and read as a fallback; it
   * matches no documented shape and could never fire, so it read as unresolved
   * uncertainty about the artifact key when there is none. Removed.
   *
   * The EVENT name genuinely has two observed spellings and both are still
   * accepted at the mapping site — see `mapMetaCallPhase`. That hedge is about
   * the event, not this field.
   */
  call_transcript?: {
    document?: {
      id?: string;
      sha256?: string;
      mime_type?: string;
      url?: string;
    };
  };
}

export interface MetaChangeValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: MetaContact[];
  messages?: MetaMessage[];
  statuses?: MetaStatus[];
  /**
   * Calling webhook payload. Meta groups calls under the same `messages`
   * field as text/media — they're discriminated by presence of `calls[]`
   * rather than a separate `field` name. (Empirically verified against
   * dev-mode webhooks; partner docs corroborate this layout.) The shape is
   * parallel to `messages[]`: per-call rows carry their own id, from,
   * status, and (when applicable) sdp + ice candidates.
   *
   * Call PROGRESS does not arrive here — it comes through `statuses[]` with
   * `type: "call"`.
   */
  calls?: MetaCall[];
  // `message_template_status_update` webhook fields. Meta sends these under a
  // distinct `change.field` (not `messages`), keyed differently from messages/
  // statuses — flat on `value`, not in an array.
  message_template_id?: string | number;
  message_template_name?: string;
  message_template_language?: string;
  /** UPPERCASE lifecycle: APPROVED | PAUSED | DISABLED | REJECTED | PENDING. */
  event?: string;
  /** Human reason Meta attaches on PAUSED/REJECTED (quality, policy, etc.). */
  reason?: string;
  /** INVALID_FORMAT rejections: Meta's detailed explanation + fix advice. */
  rejection_info?: { reason?: string; recommendation?: string };
  /** Pause/unpause lock events: title (FIRST_PAUSE | SECOND_PAUSE |
   *  RATE_LIMITING_PAUSE | UNPAUSE | DISABLED) + human description. */
  other_info?: { title?: string; description?: string };
  /** DISABLED events: when the disable happened (unix seconds). */
  disable_info?: { disable_date?: string | number };
  // `template_category_update` webhook fields. Meta sends this for TWO moments:
  // ADVANCE NOTICE carries `correct_category` (the future category) with
  // `new_category` meaning the CURRENT one; ACTION TAKEN carries
  // `new_category` (now the new one) + `previous_category` and no
  // `correct_category`. UPPERCASE (MARKETING | UTILITY | AUTHENTICATION).
  correct_category?: string;
  new_category?: string;
  previous_category?: string;
  // `message_template_quality_update` webhook fields — quality band changed
  // (GREEN | YELLOW | RED | UNKNOWN). Informational; a RED band that triggers a
  // pause arrives separately as a `message_template_status_update` (PAUSED).
  new_quality_score?: string;
  previous_quality_score?: string;
  // Number messaging-health webhook fields:
  //   phone_number_quality_update → `event` (ONBOARDING|FLAGGED|UPGRADE|…) +
  //     `current_limit` (the messaging-limit TIER, e.g. "TIER_1K").
  //   business_capability_update → `max_daily_conversation_per_phone` (the tier
  //     cap as a number).
  //   account_alerts → generic alert envelope (no reliable tier — we re-poll).
  current_limit?: string;
  /**
   * `phone_number_quality_update` also carries the number's NEW quality band
   * (GREEN | YELLOW | RED). Without reading it, the quality a broadcast gate
   * warns on only refreshes via the periodic Graph poll — hours stale for the
   * one signal that means "stop sending before Meta downgrades you".
   * (The webhook's `event` — FLAGGED/UNFLAGGED — is NOT read as a band: Meta
   * retired the FLAGGED state; `current_quality_rating` is authoritative.)
   */
  current_quality_rating?: string;
  /**
   * Per-NUMBER account webhooks (`phone_number_quality_update`,
   * `phone_number_name_update`) name their subject here, flat on `value` —
   * distinct from `metadata.display_phone_number`, which only message
   * webhooks carry. This is how an account-level signal gets attributed to the
   * right number in a multi-number workspace.
   */
  display_phone_number?: string;
  // `business_username_updates` webhook fields — the number's @username was
  // adopted / changed / deleted / transferred. Documented value shape:
  // `{display_phone_number, username, status}` with status
  // approved | reserved | deleted (`status` is declared once below, shared
  // with other webhook kinds); `username` is OMITTED when status is
  // `deleted`. `business_username` is wire tolerance for an undocumented
  // sibling spelling; anything unrecognized is warn-logged raw by
  // parseWebhook rather than guessed at.
  username?: string;
  business_username?: string;
  /** `business_username_updates` status: approved | reserved | deleted. */
  status?: string;
  // `phone_number_name_update` webhook fields — a display-name review
  // concluded. An unapproved name voids the number's certificate (blocks
  // registration), so this is readiness state, not cosmetics.
  decision?: string;
  requested_verified_name?: string;
  rejection_reason?: string | null;
  // `security` webhook (security reference doc): who asked to turn off
  // two-step verification. Reset requests only.
  requester?: string;
  // `account_alerts` webhook fields (account-alerts reference doc): the alert
  // envelope. `entity_type` says WHAT the alert is about — "PHONE_NUMBER"
  // makes `entity_id` the number's own id (= our externalAccountId, the
  // strongest attribution key); "BUSINESS" scopes it to the portfolio.
  entity_type?: string;
  entity_id?: string;
  alert_info?: {
    /** CRITICAL (rejection/denial) | WARNING (action may be needed) | INFORMATIONAL. */
    alert_severity?: string;
    /** ACTIVE | NONE. */
    alert_status?: string;
    /** OBA_APPROVED, OBA_REJECTED, PROFILE_PICTURE_LOST,
     *  INCREASED_CAPABILITIES_ELIGIBILITY_{DEFERRED,FAILED,NEED_MORE_INFO}, … */
    alert_type?: string;
    /** The human sentence — what the operator should actually read. */
    alert_description?: string;
  };
  // `account_update` webhook fields — account-level enforcement. `event` above
  // discriminates: ACCOUNT_VIOLATION is an early quality warning,
  // ACCOUNT_RESTRICTION is an active pause with an expiry.
  restriction_info?: Array<{
    restriction_type?: string;
    /**
     * The documented human-readable field ("<REMEDIATION_STEPS>") — what the
     * operator has to DO to lift the restriction. `reason` is not a documented
     * key on `restriction_info`; it is retained below only as a tolerated alias.
     */
    remediation?: string;
    reason?: string;
    /** Epoch seconds the restriction lifts. */
    expiration?: number;
  }>;
  violation_info?: { violation_type?: string };
  /**
   * WHY the customer disconnected. Added 2026-04-03 with `reason` ∈
   * BUSINESS_DOWNGRADE | PRIMARY_INACTIVITY | COMPANION_INACTIVITY and
   * `initiated_by` ∈ USER | SYSTEM; 2026-04-20 added ACCOUNT_DISCONNECTED
   * (enforcement, or the client deleted their WhatsApp account), CHANGE_NUMBER and
   * USER_RE_REGISTERED. Both changelogs note a GRADUAL rollout, so absence today is
   * not evidence the field is gone. Read verbatim, never mapped — a reason Meta adds
   * later still has to reach the operator.
   */
  disconnection_info?: { reason?: string; initiated_by?: string };
  // `account_update` → DISABLED_UPDATE: the account-lock / disable leg of the
  // policy-enforcement ladder. `waba_ban_state` is SCHEDULE_FOR_DISABLE |
  // DISABLE | REINSTATE; `waba_ban_date` is Meta's display date, kept verbatim
  // in the alert detail (never parsed — its format is not contractual).
  ban_info?: { waba_ban_state?: string; waba_ban_date?: string };
  // `user_preferences` webhook: Meta reports a WhatsApp user's marketing
  // messaging preference. `value` is "stop" | "resume"; `category` has been
  // observed as both "marketing" and "marketing_messages" (the reference doc
  // renamed it) — the parser prefix-matches. This is the ONLY signal allowed
  // to CLEAR an opt-out.
  user_preferences?: Array<{
    wa_id?: string;
    detail?: string;
    category?: string;
    value?: string;
    timestamp?: string;
  }>;
  max_daily_conversation_per_phone?: number | string;
  /**
   * The business PORTFOLIO's messaging limit (2000 | 10000 | 100000 |
   * UNLIMITED). Present on BOTH `business_capability_update` and
   * `phone_number_quality_update` since the 2025-10-07 move to portfolio-scoped
   * limits, and it is the replacement for the two legacy fields below it:
   * `max_daily_conversation_per_phone` and (for the limit meaning)
   * `current_limit` were both removed in February 2026.
   */
  max_daily_conversations_per_business?: number | string;
  /**
   * The portfolio's phone-number allowance. The current
   * `business_capability_update` reference spells it
   * `max_phone_numbers_per_business_portfolio` (with a per-WABA sibling,
   * `max_phone_numbers_per_waba`); `max_phone_numbers_per_business` is the
   * legacy spelling kept for tolerance. Feeds
   * `WhatsappPortfolio.maxPhoneNumbers`.
   */
  max_phone_numbers_per_business_portfolio?: number | string;
  max_phone_numbers_per_waba?: number | string;
  max_phone_numbers_per_business?: number | string;
  // WhatsApp Coexistence webhook fields (one number on both the Business App +
  // Cloud API). Each arrives under its own `change.field`, keyed as its own
  // array on `value` — parallel to `messages[]`.
  //   smb_message_echoes → message_echoes[]: a message the owner sent from the
  //                        phone app (from=business, to=customer). Outbound.
  //   history            → history[]: the past-180d backfill, chunked in phases.
  //   smb_app_state_sync → state_sync[]: the owner's phone address-book changes.
  message_echoes?: MetaMessage[];
  history?: MetaHistoryEntry[];
  state_sync?: MetaStateSyncEntry[];
  // Value-level errors, used by three unrelated signals:
  //   - the history-declined code 2593109 ("History sync is turned off by the
  //     business from the WhatsApp Business App"), which can surface here or
  //     per history entry — we check both;
  //   - the calling error on a FAILED call terminate, sitting alongside
  //     `calls[]`, which is the only place Meta says WHY a call failed;
  //   - standalone system/app/account-level errors (no messages/calls/statuses
  //     beside it) — traced in parseWebhook so they don't vanish as a bare
  //     `{ingested: 0}`.
  errors?: MetaStatus["errors"];
}

export interface MetaHistoryEntry {
  metadata?: { phase?: number; chunk_order?: number; progress?: number };
  threads?: Array<{ id?: string; messages?: MetaMessage[] }>;
  errors?: Array<{ code?: number; title?: string; message?: string }>;
}

export interface MetaMessage {
  from?: string;
  /**
   * GROUPS API: present ONLY on a group message, and the sole marker separating
   * one from a 1:1 inbound — `from` and `contacts[].wa_id` are both the sending
   * PARTICIPANT either way. Group posts arrive on the same `messages` field as
   * direct messages, so the parser must gate on this or it invents a direct
   * conversation with someone who never messaged the business.
   */
  group_id?: string;
  /**
   * The customer's BSUID, stamped directly on the message row.
   *
   * Corrected 2026-07-30 against Meta's business-scoped-user-ids reference,
   * which marks both of these ADDED on `messages[]` and marks `wa_id` as
   * carrying a "New empty value". The previous note here claimed the opposite —
   * that BSUIDs live only on `contacts[]` and that `from` becomes the BSUID for
   * a cold contact. Both halves were wrong, and that comment was the stated
   * reason the message path read only `from`: for a username-adopting customer
   * Meta EMPTIES/omits `from` and `contacts[].wa_id`, so keying off `from` alone
   * dropped the inbound outright. The call path already carries the correct
   * fallback chain (see `parseMetaCall`) after the identical bug made inbound
   * callers invisible; the message path was never given it.
   */
  from_user_id?: string;
  /** Parent portfolio BSUID ("US.ENT.…") for multi-portfolio businesses. */
  from_parent_user_id?: string;
  // Present on Coexistence echo/history rows the BUSINESS sent: the CUSTOMER's
  // number. Absent on ordinary inbound `messages[]` (where `from` is already
  // the customer).
  to?: string;
  // History-backfill rows only (history webhook reference): the message's most
  // recent delivery state at sync time — SENT | DELIVERED | READ | PLAYED |
  // PENDING | ERROR (uppercase, unlike live status webhooks).
  history_context?: { status?: string };
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: MetaMediaPayload;
  video?: MetaMediaPayload;
  audio?: MetaMediaPayload;
  document?: MetaMediaPayload;
  sticker?: MetaMediaPayload;
  interactive?: MetaInteractivePayload;
  // A tap on a TEMPLATE quick-reply button. Distinct from `interactive` (which
  // is a tap on a free-form interactive message): a quick-reply button inside an
  // approved template arrives as `type:"button"` with `button:{ payload, text }`,
  // where `payload` is the author-assigned id set at template-send time.
  button?: { payload?: string; text?: string };
  // Click-to-WhatsApp ad attribution — present on the FIRST inbound when the
  // customer arrived by tapping a Facebook/Instagram ad (or a post CTA). Drives
  // the "from your ad" chip. `source_type`: "ad" | "post".
  referral?: {
    source_url?: string;
    source_id?: string;
    source_type?: string;
    headline?: string;
    body?: string;
    ctwa_clid?: string;
    // The creative the customer was looking at, plus the greeting Meta showed
    // them before they typed. All documented on the CTWA referral and all
    // previously discarded.
    media_type?: string;
    image_url?: string;
    video_url?: string;
    thumbnail_url?: string;
    welcome_message?: { text?: string };
  };
  reaction?: { message_id?: string; emoji?: string };
  // Customer EDITED (`type:"edit"`) or UNSENT/revoked (`type:"revoke"`) a prior
  // message. Both reference the ORIGINAL by its wamid (`original_message_id`) —
  // an exact match, so we correct precisely that message. `edit` carries the new
  // content nested; a text edit is `edit.message.text.body`, a media caption
  // edit is `edit.message.<kind>.caption`. Delivery is best-effort on the Cloud
  // API — honoured when it arrives (mirrors the Messenger/IG `is_deleted` path).
  edit?: {
    original_message_id?: string;
    message?: {
      text?: { body?: string };
      image?: { caption?: string };
      video?: { caption?: string };
      document?: { caption?: string };
    };
  };
  revoke?: { original_message_id?: string };
  context?: MetaContextRef;
  // Non-media customer content with no dedicated bubble yet — ingested as a
  // typed text placeholder (see placeholderForUnhandledType) so unread / window
  // / list-preview stay correct instead of the message vanishing silently.
  location?: MetaLocationPayload;
  contacts?: MetaContactsPayload[];
  order?: {
    catalog_id?: string;
    text?: string;
    product_items?: Array<{
      product_retailer_id?: string;
      quantity?: number | string;
      item_price?: number | string;
      currency?: string;
    }>;
  };
  // Present on `type: "unsupported"` inbound (and some others): Meta's reason
  // the Cloud API can't represent the message — e.g. a template/interactive
  // message received BY a business number from another business. The content
  // is NOT included, so this is the only context we can surface.
  errors?: Array<{
    code?: number;
    title?: string;
    message?: string;
    error_data?: { details?: string };
  }>;
  // `type:"system"` — a customer changed their WhatsApp number. `system.wa_id`
  // is the NEW number; `messages[].from` is the OLD one.
  system?: { body?: string; wa_id?: string; type?: string };
  // `type:"unsupported"` only: names WHAT the customer sent that the Cloud API
  // can't represent (poll_creation, pin, group_invite, edit, gif, …) — the one
  // piece of renderable context besides `errors[]`.
  unsupported?: { type?: string };
}

export interface MetaStateSyncEntry {
  type?: string; // "contact"
  contact?: { full_name?: string; first_name?: string; phone_number?: string };
  action?: string; // "add" (added/edited) | "remove"
  metadata?: { timestamp?: string };
}

export interface MetaContactsPayload {
  name?: {
    formatted_name?: string;
    prefix?: string;
    first_name?: string;
    middle_name?: string;
    last_name?: string;
    suffix?: string;
  };
  phones?: Array<{ phone?: string; wa_id?: string; type?: string }>;
  emails?: Array<{ email?: string; type?: string }>;
  addresses?: Array<{
    street?: string;
    city?: string;
    state?: string;
    zip?: string;
    country?: string;
    country_code?: string;
    type?: string;
  }>;
  org?: { company?: string; title?: string; department?: string };
  urls?: Array<{ url?: string; type?: string }>;
  /**
   * BSUID rollout: "contact_request" = reply to our REQUEST_CONTACT_INFO
   * button (user shared their own number; `vcard` absent); "other" = an
   * ordinary manually-shared vCard (`vcard` present).
   */
  origin?: string;
  vcard?: string;
}

export interface MetaContextRef {
  // Wamid of the message this one is replying to.
  id?: string;
  // The wa_id of the original sender (kept for debugging only).
  from?: string;
  // FORWARDED message: `context` carries one of these booleans and NO `id`
  // (so it never false-threads as a reply — `replyToExternalId` reads `id`
  // only). `frequently_forwarded` = forwarded more than 5 times. Deliberately
  // not surfaced in the inbox today; recoverable from rawPayload if a
  // "Forwarded" chip is ever wanted.
  forwarded?: boolean;
  frequently_forwarded?: boolean;
  // Catalog "Message business" button: the customer asked about a product
  // from the business's WhatsApp catalog (set up in Commerce Manager, outside
  // this platform). `context.id` is then a SYNTHETIC product-inquiry wamid
  // matching no real message — reply resolution misses and drops the quote
  // link, which is the correct fail-soft. Not surfaced today (no catalog
  // model here); if catalog commerce ever lands, this is the field to render
  // as a product chip so "Is this still available?" has its referent.
  referred_product?: { catalog_id?: string; product_retailer_id?: string };
}

export interface MetaLocationPayload {
  latitude?: number;
  longitude?: number;
  name?: string;
  address?: string;
  // "Usually only included for business locations" (a shared POI's website).
  // Deliberately not lifted into the structured pin — the bubble's map link
  // comes from lat/lon; recoverable from rawPayload if ever wanted.
  url?: string;
}

export interface MetaMediaPayload {
  id?: string;
  mime_type?: string;
  caption?: string;
  filename?: string;
  // audio voice notes carry voice=true; we treat both as "audio"
  voice?: boolean;
  // not all media types include a duration but some do
  duration?: number;
  // stickers only. Deliberately not captured: an animated sticker is an
  // animated WebP and the browser animates it natively in <img> — the bytes
  // carry the behavior, so no renderer flag is needed.
  animated?: boolean;
}

export function digitsOnly(v: string | undefined): string | undefined {
  const d = v ? v.replace(/\D/g, "") : "";
  return d.length > 0 ? d : undefined;
}

export function tsFromMeta(timestamp: string | undefined): Date {
  const secs = timestamp ? Number(timestamp) : NaN;
  return Number.isFinite(secs) ? new Date(secs * 1000) : new Date();
}

/** History-declined sentinel: the owner turned off sharing in the Business App. */
export const HISTORY_DECLINED_CODE = 2593109;

/**
 * Map a history row's `history_context.status` (UPPERCASE, per the history
 * webhook reference) onto our MessageStatus ladder, so a backfilled echo
 * shows the ticks it had earned instead of defaulting to a lone "sent".
 * PLAYED collapses to read (same rule as the live `played` status); PENDING
 * stays "sent" (it left the device); ERROR → failed. Unknown → null, caller
 * keeps its default.
 */
export function mapHistoryStatus(s: string | undefined): MessageStatus | null {
  switch (s?.trim().toUpperCase()) {
    case "SENT":
    case "PENDING":
      return "sent";
    case "DELIVERED":
      return "delivered";
    case "READ":
    case "PLAYED":
      return "read";
    case "ERROR":
      return "failed";
    default:
      return null;
  }
}

export function mapMetaStatus(s: string | undefined): MessageStatus | null {
  switch (s) {
    case "sent":
      return "sent";
    case "delivered":
      return "delivered";
    // A voice note being PLAYED implies it was read (blue mic) — map both to
    // "read" so a played-but-not-separately-read voice note still reaches its
    // final state instead of being dropped.
    case "read":
    case "played":
      return "read";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

/**
 * Meta sometimes delivers SDP ANSWERS with `a=setup:actpass`, which
 * RTCPeerConnection rejects on `setRemoteDescription` when applied to
 * the offerer side. Rewriting once in the parser keeps every downstream
 * consumer free of this gotcha.
 */
export function rewriteSdpForBrowser(sdp: string): string {
  // Meta's guidance is that WE act as the DTLS client, i.e. Meta is the DTLS
  // server. `a=setup:passive` in Meta's answer is what tells the browser to be
  // the client. (Meta's real answers already pin a concrete role, so this only
  // fires on the malformed case this rewrite exists for.)
  //
  // `\r?` matters: RFC 8866 SDP lines end \r\n, and JS `$` under /m matches
  // before \n only — without tolerating the \r, this safety net silently
  // no-ops on exactly the spec-compliant malformed answer it exists for.
  return sdp.replace(/^a=setup:actpass\r?$/gm, (line) =>
    line.endsWith("\r") ? "a=setup:passive\r" : "a=setup:passive",
  );
}

/**
 * Translate Meta's call lifecycle vocabulary into our NormalizedCallEvent
 * phase. Direction is needed because `event: "connect"` means different
 * things in each leg (incoming-ring on inbound, media setup on outbound).
 *
 * Unrecognized `event` returns null — the caller drops the row rather than
 * fabricating a phase — but it is LOGGED first. A silent null here is how a
 * whole feature goes missing: enabling call recording on the Meta side starts
 * delivering `call_recording_available`, and without the log it would vanish
 * with no trace that anything was ever sent.
 */
export function mapMetaCallPhase(
  event: string | undefined,
  direction: "in" | "out",
  status: string | undefined,
  /** True when the terminate webhook carried start_time/duration → the call
   *  actually connected. Meta documents those fields as present "only when the
   *  call was picked up", and reports UNANSWERED business-initiated calls as
   *  status:COMPLETED — so this, not `status`, is the answered discriminator. */
  hasConnectedSignal: boolean,
): NormalizedCallEvent["phase"] | null {
  switch (event) {
    case "connect":
      // Inbound: the customer is ringing us → "incoming".
      // Outbound: this is the Cloud-API media-server SDP answer establishing
      // our media leg — it arrives ~1s after we place the call, BEFORE the
      // human picks up. So it's "connecting", NOT answered: the browser uses
      // the SDP to negotiate media, but the call stays ringing until the
      // `ACCEPTED` call status lands (see parseMetaCallStatus).
      return direction === "in" ? "incoming" : "connecting";
    case "terminate":
      // Meta documents exactly two terminate statuses: COMPLETED and FAILED.
      switch (status?.toUpperCase()) {
        case "FAILED":
          return "failed";
        default:
          // COMPLETED covers BOTH a real conversation and a call nobody
          // answered, so the status string cannot tell them apart. The presence
          // of connected timing is the documented discriminator: present ⇒
          // "completed", absent ⇒ "missed". Ingest further corrects via the
          // row's own answeredAt, so an answered call with missing timing still
          // resolves correctly. This is doc-confirmed — don't "simplify" it.
          return hasConnectedSignal ? "completed" : "missed";
      }
    case "call_created":
      // SIP-mode only (sent when the number has SIP enabled WITH
      // `webhook_delivery: ENABLED` — informational, no SDP). We deliberately
      // never enable SIP: it disables the Graph calling endpoints this whole
      // module is built on. Reaching here means someone flipped SIP on
      // out-of-band — log it rather than blackholing the call; the readiness
      // checklist names the same state from the settings read.
      console.warn(
        "[meta] calls webhook: received SIP-only `call_created` — SIP appears " +
          "to be enabled on this number, which disables the Graph calling API",
      );
      return null;
    case "call_recording_available":
      // Post-call artifact for a call we opted into recording. The media id
      // expires provider-side after 7 days — ingest downloads to R2 promptly.
      return "recording_available";
    case "call_transcription_available":
    case "call_transcript_available":
      // Post-call transcript document (same 7-day media retention). TWO names
      // accepted: the call-transcription doc says `call_transcription_available`
      // but the wire actually delivers `call_transcript_available` (observed
      // live 2026-07-28 — the unhandled-event log below caught it). Keep both:
      // Meta may converge on the documented name later.
      return "transcript_available";
    default:
      console.warn(
        `[meta] calls webhook: unhandled call event ${JSON.stringify(event)} — dropping row`,
      );
      return null;
  }
}

/**
 * Parse a call-progress row from `value.statuses[]` (`type: "call"`).
 *
 * This is the authoritative live signal for a business-initiated call:
 * `ACCEPTED` is the moment the customer actually picked up. Meta gives no
 * other real-time pickup indication — the `connect` webhook is media setup
 * that fires before anyone answers, and the timing fields only arrive at
 * terminate. Anything else (watching for inbound audio in the browser, say)
 * is a guess that ringback tone can trip.
 *
 * Returns null for statuses that add nothing: RINGING duplicates the state the
 * row already has from placeCall.
 */
export function parseMetaCallStatus(
  s: MetaStatus,
  rawPayload: Record<string, unknown>,
): NormalizedCallEvent | null {
  const externalCallId = s.id;
  if (!externalCallId) return null;
  const phase = ((): NormalizedCallEvent["phase"] | null => {
    switch (s.status?.toUpperCase()) {
      case "ACCEPTED":
        return "answered";
      case "REJECTED":
        return "rejected";
      case "RINGING":
        // No new information — we created the row as `ringing` when we placed
        // the call, and re-asserting it risks downgrading a row that has since
        // legitimately advanced.
        return null;
      default:
        console.warn(
          `[meta] calls webhook: unhandled call status ${JSON.stringify(s.status)}`,
        );
        return null;
    }
  })();
  if (!phase) return null;

  const tsSecs = s.timestamp ? Number(s.timestamp) : NaN;
  const ts = Number.isFinite(tsSecs) ? new Date(tsSecs * 1000) : new Date();
  const recipient = s.recipient_id?.trim();
  const identityIsPhone = recipient ? !/\D/.test(recipient) : false;

  return {
    kind: "call",
    externalCallId,
    ...(recipient && identityIsPhone ? { contactPhone: recipient } : {}),
    ...(s.recipient_user_id
      ? { bsuid: s.recipient_user_id }
      : recipient && !identityIsPhone
        ? { bsuid: recipient }
        : {}),
    contactName: null,
    // Only business-initiated calls produce these statuses.
    direction: "out",
    phase,
    // `ACCEPTED` is real pickup, so it carries the connected time. This is what
    // makes a later hangup resolve to `completed` rather than `missed`, and
    // keeps connected-call accounting honest.
    ...(phase === "answered" ? { connectedAt: ts } : {}),
    ...(s.biz_opaque_callback_data
      ? { correlationId: s.biz_opaque_callback_data }
      : {}),
    timestamp: ts,
    rawPayload,
  };
}

/**
 * Parse one Meta call webhook row into a NormalizedCallEvent. Returns null
 * on rows the parser can't make sense of (missing id, missing from, unknown
 * event) so the caller can keep iterating without throwing on a partial
 * batch.
 */
export function parseMetaCall(
  c: MetaCall,
  rawPayload: Record<string, unknown>,
  /** `value.contacts[]` — carries the customer's display name and BSUID. */
  contacts: MetaContact[] = [],
  /** `value.errors[]` — present only on a FAILED terminate. */
  errors: MetaStatus["errors"] = undefined,
): NormalizedCallEvent | null {
  const externalCallId = c.id;
  if (!externalCallId) return null;

  // Direction. Live payloads use "USER_INITIATED" / "BUSINESS_INITIATED";
  // older partner docs reference "incoming"/"outgoing". Handle both.
  const dirRaw = (c.direction ?? "").toString().toUpperCase();
  const direction: "in" | "out" =
    dirRaw === "OUTGOING" || dirRaw === "BUSINESS_INITIATED"
      ? "out"
      : "in";

  // Pick the CUSTOMER's identity based on direction. For outbound calls `from`
  // is the BUSINESS number; using it blindly creates phantom contacts.
  //
  // As on the message path, the identity is a phone ONLY when it is all digits.
  // Meta omits `wa_id` for contacts not messaged in 30 days, so a cold caller is
  // identified by a business-scoped user id ("LB.946402411360800"). Digit-
  // stripping that would mint the phantom phone contact "946402411360800" —
  // a fabricated identity, detached from the person's real thread.
  const rawIdentity = (direction === "in" ? c.from : c.to)?.trim();
  const identityIsPhone = rawIdentity ? !/\D/.test(rawIdentity) : false;
  const phone = identityIsPhone ? rawIdentity : undefined;
  // A customer who adopted a WhatsApp username has NO phone on the row at all,
  // so `from`/`to` alone is not a sufficient identity — fall back to the
  // dedicated BSUID fields and then to `contacts[]`. Reading only `from` here
  // dropped those calls entirely, making the caller invisible.
  const contact = contacts[0];
  // EMPTY-string guard, same idiom as the message path: the BSUID docs say
  // `from` "will be set to an empty string" when the phone isn't shareable,
  // and `"" ?? x` never falls through (?? skips only null/undefined) — so an
  // empty `from` used to freeze bsuid at "" and drop the call even when
  // `from_user_id` carried the real identity.
  const bsuid =
    (identityIsPhone || !rawIdentity ? undefined : rawIdentity) ||
    (direction === "in" ? c.from_user_id : c.to_user_id)?.trim() ||
    contact?.user_id?.trim() ||
    undefined;
  const parentBsuid =
    (direction === "in" ? c.from_parent_user_id : c.to_parent_user_id)?.trim() ||
    contact?.parent_user_id?.trim() ||
    undefined;
  if (!phone && !bsuid && !parentBsuid) return null;

  // Meta supplies the customer's display name on inbound calls; without this we
  // name a brand-new contact after their raw phone number.
  const contactName = contact?.profile?.name?.trim() || null;

  // Failure detail. Every failed call otherwise collapses to one opaque reason.
  const firstError = errors?.[0];

  // Connected-call evidence. Meta puts `start_time` (epoch s, REAL pickup) +
  // `duration` (talk seconds) on the terminate webhook ONLY for calls that
  // actually connected — they're absent on a decline / no-answer. This is the
  // channel-agnostic "was answered" signal carried through as connectedAt /
  // durationSeconds. (Both `start_time` and `end_time` arrive as numeric
  // strings; `duration` as a number.)
  const startSecs = c.start_time != null ? Number(c.start_time) : NaN;
  const connectedAt = Number.isFinite(startSecs)
    ? new Date(startSecs * 1000)
    : undefined;
  const durationSeconds =
    typeof c.duration === "number" && Number.isFinite(c.duration)
      ? c.duration
      : undefined;
  const hasConnectedSignal = connectedAt !== undefined || durationSeconds !== undefined;

  const phase = mapMetaCallPhase(c.event, direction, c.status, hasConnectedSignal);
  if (!phase) return null;

  const tsSecs = c.timestamp ? Number(c.timestamp) : NaN;
  const ts = Number.isFinite(tsSecs) ? new Date(tsSecs * 1000) : new Date();

  // SDP. Rewrite `a=setup:actpass` → `setup:passive` ONLY on answers
  // (Meta is the DTLS server — see rewriteSdpForBrowser) —
  // RTCPeerConnection.setRemoteDescription rejects answer SDPs with
  // `actpass`. Offers are passed through unchanged; the browser commits
  // to a concrete role in its generated answer.
  let sdp: { type: "offer" | "answer"; sdp: string } | undefined;
  if (
    c.session?.sdp &&
    (c.session.sdp_type === "offer" || c.session.sdp_type === "answer")
  ) {
    const type: "offer" | "answer" = c.session.sdp_type;
    sdp = {
      type,
      sdp: type === "answer" ? rewriteSdpForBrowser(c.session.sdp) : c.session.sdp,
    };
  } else if (c.connection?.webrtc?.sdp && phase === "connecting") {
    // Fallback: the business-initiated connect sample carries the answer in
    // `connection.webrtc.sdp` alongside `session` — if a payload ever arrives
    // with only that shape, losing it strands the outbound call in silence.
    // `phase === "connecting"` pins this to the outbound connect, where the
    // SDP is by definition the provider's ANSWER (actpass → passive rewrite
    // applied like the session path).
    sdp = { type: "answer", sdp: rewriteSdpForBrowser(c.connection.webrtc.sdp) };
  }

  return {
    kind: "call",
    externalCallId,
    ...(phone ? { contactPhone: phone } : {}),
    ...(bsuid ? { bsuid } : {}),
    ...(parentBsuid ? { parentBsuid } : {}),
    contactName,
    direction,
    phase,
    ...(sdp ? { sdp } : {}),
    ...(connectedAt !== undefined ? { connectedAt } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(phase === "failed" && firstError
      ? {
          ...(typeof firstError.code === "number"
            ? { errorCode: firstError.code }
            : {}),
          // Calling terminate errors carry the label in `message` (docs'
          // 138019-138023 payloads), message-status errors in `title` — read
          // both or a calling failure persists a bare code with no label.
          ...(firstError.title ?? firstError.message
            ? { errorTitle: firstError.title ?? firstError.message }
            : {}),
          ...(firstError.error_data?.details ?? firstError.message
            ? {
                errorDetail:
                  firstError.error_data?.details ?? firstError.message ?? "",
              }
            : {}),
        }
      : {}),
    // Attribution for user-initiated calls: which button or link produced this.
    ...(c.cta_payload ? { ctaPayload: c.cta_payload } : {}),
    ...(c.deeplink_payload ? { deeplinkPayload: c.deeplink_payload } : {}),
    ...(c.biz_opaque_callback_data
      ? { correlationId: c.biz_opaque_callback_data }
      : {}),
    // The finished recording's durable handle. The webhook also carries a
    // 5-minute signed `url`, deliberately NOT forwarded: by the time a retry
    // needs it it's dead, and the media id re-fetches through the Media API
    // for the full 7-day retention window.
    ...(phase === "recording_available" && c.call_recording?.audio?.id
      ? {
          recordingMedia: {
            mediaId: c.call_recording.audio.id,
            mimeType: c.call_recording.audio.mime_type ?? null,
            sha256: c.call_recording.audio.sha256 ?? null,
          },
        }
      : {}),
    ...(() => {
      if (phase !== "transcript_available") return {};
      // Field name read under both spellings — see the MetaCall comment.
      const doc = c.call_transcript?.document;
      return doc?.id
        ? {
            transcriptMedia: {
              mediaId: doc.id,
              mimeType: doc.mime_type ?? null,
              sha256: doc.sha256 ?? null,
            },
          }
        : {};
    })(),
    timestamp: ts,
    rawPayload,
  };
}

/**
 * Parse a `call_permission_reply` interactive message into a permission event.
 *
 * Permission decisions arrive as MESSAGES, not as calling webhooks — an earlier
 * version of this file waited for `permission_granted` rows inside `calls[]`,
 * which Meta never sends, so no grant was ever recorded and every out-of-window
 * call was refused. It also meant the customer's "Allow" showed up in the inbox
 * as a meaningless generic interactive-reply bubble.
 *
 * Covers both the customer acting and Meta acting on their behalf: a grant is
 * automatic when they call us (with callback permission enabled), and a
 * revocation is automatic after too many unanswered calls.
 */
export function parseMetaCallPermissionReply(
  reply: NonNullable<MetaInteractivePayload["call_permission_reply"]>,
  identity: { contactPhone?: string; bsuid?: string },
  contactName: string | null,
  /** `context.id` — the permission-request message this answers, if any. */
  requestExternalId: string | undefined,
  timestamp: Date,
  rawPayload: Record<string, unknown>,
): NormalizedCallEvent | null {
  const granted = reply.response === "accept";
  if (!granted && reply.response !== "reject") return null;

  const expSecs =
    reply.expiration_timestamp != null
      ? Number(reply.expiration_timestamp)
      : NaN;

  return {
    kind: "call",
    // Permission events aren't tied to a call, but the shared shape requires an
    // id. Derive a stable one from the reply so at-least-once redelivery
    // dedupes rather than double-applying.
    externalCallId: `perm:${requestExternalId ?? timestamp.getTime()}`,
    ...identity,
    contactName,
    // Permission is about calls WE place.
    direction: "out",
    phase: granted ? "permission_granted" : "permission_revoked",
    ...(granted && reply.is_permanent ? { permanentPermission: true } : {}),
    // Meta's own expiry, used verbatim. Never recompute this — Meta sends no
    // webhook when a temporary permission lapses, so a locally-guessed duration
    // silently discards days of a valid grant.
    ...(granted && !reply.is_permanent && Number.isFinite(expSecs)
      ? { permissionExpiresAt: new Date(expSecs * 1000) }
      : {}),
    ...(requestExternalId
      ? { permissionRequestExternalId: requestExternalId }
      : {}),
    ...(reply.response_source === "automatic"
      ? { permissionAutomatic: true }
      : {}),
    timestamp,
    rawPayload,
  };
}

/**
 * Parse a `message_template_status_update` webhook value into a normalized
 * template-status event. Returns null when there's no usable identity to match
 * the local row on (neither an id nor a name). Forward-compatible: an `event`
 * value that doesn't map to a known TemplateStatus yields `status: null`, which
 * ingest treats as a no-op flip (it only writes a mapped status).
 */
export function parseTemplateStatusUpdate(
  value: MetaChangeValue,
  rawPayload: Record<string, unknown>,
): NormalizedTemplateStatusUpdate | null {
  const externalId =
    value.message_template_id != null
      ? String(value.message_template_id)
      : undefined;
  const name = value.message_template_name;
  if (!externalId && !name) return null;

  // The rich sub-objects the coarse `reason` string can't carry: the
  // INVALID_FORMAT explanation + fix recommendation, the pause-instance title
  // (FIRST_PAUSE/SECOND_PAUSE self-lift; RATE_LIMITING_PAUSE is pacing and
  // needs the manual unpause), and the disable timestamp. All optional and all
  // verbatim — these are Meta's words to the operator, not state we interpret.
  const disableSecs =
    value.disable_info?.disable_date != null
      ? Number(value.disable_info.disable_date)
      : NaN;
  const statusDetail = {
    ...(value.other_info?.title ? { title: value.other_info.title } : {}),
    ...(value.other_info?.description
      ? { description: value.other_info.description }
      : {}),
    ...(value.rejection_info?.reason
      ? { rejectionReason: value.rejection_info.reason }
      : {}),
    ...(value.rejection_info?.recommendation
      ? { recommendation: value.rejection_info.recommendation }
      : {}),
    ...(Number.isFinite(disableSecs)
      ? { disabledAt: new Date(disableSecs * 1000).toISOString() }
      : {}),
  };

  return {
    kind: "template_status",
    ...(externalId ? { externalId } : {}),
    ...(name ? { name } : {}),
    ...(value.message_template_language
      ? { language: normalizeTemplateLanguage(value.message_template_language) }
      : {}),
    status: mapTemplateStatus(value.event),
    // UNARCHIVED restores "the previous status" — which this webhook doesn't
    // carry, so it can't be a blind status write. Ingest clears the deletion
    // countdown and refetches the catalog to learn the real status.
    ...((value.event ?? "").toUpperCase() === "UNARCHIVED"
      ? { unarchived: true }
      : {}),
    ...(value.reason ? { reason: value.reason } : {}),
    ...(Object.keys(statusDetail).length > 0 ? { statusDetail } : {}),
    rawPayload,
  };
}

/**
 * Meta's own webhook examples mix `en-US` and `en_US` for the SAME field
 * across references, while the catalog list (what our rows store) uses the
 * underscore form — so a dash-form webhook would silently miss the
 * (name, language) fallback match. Normalized at the parser, the one place
 * every template webhook flows through.
 */
export function normalizeTemplateLanguage(language: string): string {
  return language.replace("-", "_");
}

/**
 * Parse a `template_category_update` webhook. Status stays null — this webhook
 * never changes review status.
 *
 * Meta sends this field for TWO different moments and they must not be merged:
 *
 *   - ADVANCE NOTICE — carries `correct_category`, the category the template
 *     WILL be moved to (~24h later per the template-category-update reference;
 *     `category_update_timestamp` names the scheduled instant). Nothing has
 *     changed yet, so this maps to `pendingCategory`. NOTE the trap: this shape
 *     ALSO carries `new_category`, but there it means the CURRENT category —
 *     which is why this parser treats `new_category` as always-safe current
 *     truth rather than discriminating on its presence.
 *   - ACTION TAKEN — carries `new_category` (plus `previous_category`). The move
 *     has happened, so this maps to `category`.
 *
 * Preferring `correct_category` — as this parser used to — applied the future
 * category immediately, relabelling and mispricing a UTILITY template as
 * MARKETING for up to a month before Meta actually moved it.
 */
export function parseTemplateCategoryUpdate(
  value: MetaChangeValue,
  rawPayload: Record<string, unknown>,
): NormalizedTemplateStatusUpdate | null {
  const externalId =
    value.message_template_id != null
      ? String(value.message_template_id)
      : undefined;
  const name = value.message_template_name;
  if (!externalId && !name) return null;
  const applied = mapTemplateCategory(value.new_category);
  const pending = mapTemplateCategory(value.correct_category);
  if (!applied && !pending) return null;
  return {
    kind: "template_status",
    ...(externalId ? { externalId } : {}),
    ...(name ? { name } : {}),
    ...(value.message_template_language
      ? { language: normalizeTemplateLanguage(value.message_template_language) }
      : {}),
    status: null,
    ...(applied ? { category: applied } : {}),
    // An applied move settles the question: clear any prior pending notice by
    // reporting the landed category as the pending one too. Ingest turns an
    // equal pair into "not impacted".
    ...(pending ? { pendingCategory: pending } : applied ? { pendingCategory: applied } : {}),
    rawPayload,
  };
}

/**
 * Parse a `message_template_quality_update` webhook into the same
 * `template_status` shape a status/category update uses — the identity keys and
 * the local match are identical, and only the field written differs.
 *
 * `status: null` is deliberate: this webhook says nothing about approval, and
 * ingest only writes the fields that are actually present. Meta's band is
 * carried VERBATIM, uppercased for a stable comparison but never mapped to an
 * enum — an unrecognized future band is informational and must still be
 * storable.
 */
export function parseTemplateQualityUpdate(
  value: MetaChangeValue,
  rawPayload: Record<string, unknown>,
): NormalizedTemplateStatusUpdate | null {
  const externalId =
    value.message_template_id != null
      ? String(value.message_template_id)
      : undefined;
  const name = value.message_template_name;
  if (!externalId && !name) return null;
  const score = value.new_quality_score?.trim();
  if (!score) return null;
  return {
    kind: "template_status",
    ...(externalId ? { externalId } : {}),
    ...(name ? { name } : {}),
    ...(value.message_template_language
      ? { language: normalizeTemplateLanguage(value.message_template_language) }
      : {}),
    status: null,
    qualityScore: score.toUpperCase(),
    rawPayload,
  };
}


/**
 * An `account_update` we recognise the topic of but not the event.
 *
 * Deliberately `console.warn` with the RAW payload: this is an account-level
 * channel (enforcement, partner removal, account-model changes), so the volume
 * is trivial and the value of seeing an unknown shape once is high.
 */
export function logUnhandledAccountUpdate(
  value: MetaChangeValue,
  rawPayload: Record<string, unknown>,
): void {
  console.warn(
    JSON.stringify({
      event: "meta.account_update_unhandled",
      severity: "warn",
      metaEvent: value.event ?? null,
      // Truncated: an account payload is small, but a log line is not a place
      // to page in something unbounded.
      payload: JSON.stringify(rawPayload).slice(0, 2000),
    }),
  );
}

/**
 * Parse a number-health webhook (`phone_number_quality_update`,
 * `business_capability_update`, `account_update`, `account_alerts`, or
 * `account_review_update`) into a NormalizedChannelHealth
 * carrying whichever of tier/quality/throughput the payload actually contains.
 * Ingest merges the partial onto the WhatsApp ChannelConnection. Returns null
 * when nothing usable is present (e.g. a generic account_alerts envelope), so a
 * pure alert doesn't blank a stored snapshot. Field mapping:
 *   - either webhook: `max_daily_conversations_per_business` → the PORTFOLIO's
 *     messaging limit. This is the current field on both, and the only one that
 *     survives: Meta removed `max_daily_conversation_per_phone` and the
 *     limit-meaning of `current_limit` in February 2026.
 *   - legacy fallbacks, kept because a workspace pinned to an older webhook
 *     version still receives them and reading them costs nothing:
 *     `phone_number_quality_update.current_limit` (which now carries EITHER the
 *     portfolio limit or the number's throughput level — `normalizeMessagingTier`
 *     returns null for a throughput string, so a throughput value can't be
 *     mistaken for a tier), and
 *     `business_capability_update.max_daily_conversation_per_phone`.
 */
export function parseChannelHealthUpdate(
  field: string,
  value: MetaChangeValue,
  rawPayload: Record<string, unknown>,
): NormalizedChannelHealth | null {
  // `account_update` carries calling enforcement: a WARNING that call quality
  // is trending badly, or an actual RESTRICTION pausing calling for ~7 days.
  // Both matter — during a restriction every call and every permission request
  // fails, and without ingesting this the tenant just sees a week of
  // unexplained errors.
  if (field === "account_update") {
    if (value.event === "ACCOUNT_RESTRICTION") {
      // Template-categorization enforcement rides ACCOUNT_RESTRICTION too.
      // The recovery events (*_UNBAN / *_RECOVERY) arrive with NO
      // restriction_info — the violation_type is the whole signal — so they
      // are checked first and CLEAR the stored state.
      const violation = value.violation_info?.violation_type ?? "";
      if (
        violation === "UTILITY_TEMPLATE_ABUSE_UNBAN" ||
        violation === "UTILITY_TEMPLATE_ABUSE_RATE_LIMIT_RECOVERY"
      ) {
        return {
          kind: "channel_health",
          utilityRestrictionType: null,
          utilityRestrictedUntil: null,
          rawPayload,
        };
      }
      // One webhook can list SEVERAL restrictions — a 5/7/30-day spam block
      // arrives as BIZ_INITIATED + CUSTOMER_INITIATED + ADD_PHONE entries in
      // one `restriction_info` (policy-enforcement guide) — so every entry is
      // routed into its slot on ONE health update. First-match-wins here would
      // silently drop the other half of a full messaging block.
      const info = value.restriction_info ?? [];
      const expiry = (r: (typeof info)[number]) =>
        r.expiration ? new Date(r.expiration * 1000) : null;
      const health: NormalizedChannelHealth = { kind: "channel_health", rawPayload };
      let matched = false;
      const utility = info.find((r) => r.restriction_type?.includes("UTILITY"));
      if (utility) {
        // RATE_LIMITED_UTILITY_TEMPLATE_MESSAGING: utility sends over the
        // rolling-24h cap are REJECTED — the composer must warn before an
        // operator fires a utility campaign into it.
        // RESTRICTED_UTILITY_TEMPLATES: utility templates recategorized,
        // new utility creation + category reviews disabled.
        matched = true;
        health.utilityRestrictionType = utility.restriction_type ?? null;
        health.utilityRestrictedUntil = expiry(utility);
      }
      const callingRestrictions = info.filter((r) =>
        r.restriction_type?.includes("CALLING"),
      );
      // Meta can pause each direction independently and may list both in one
      // webhook. Prefer the entry that gates OUR outbound calls, because
      // RESTRICTED_USER_INITIATED_CALLING (and the low-pickup
      // _CALL_BUTTON_HIDDEN variant) only pause inbound + the call icon — see
      // the placeCall gate, which lets outbound proceed for those.
      //
      // BEWARE: Meta's own enum mixes prefixes. The combined restriction is
      // spelled `RESTRICTED_BIZ_INITIATED_AND_USER_INITIATED_CALLING` ("Business
      // cannot make or receive calls") while the outbound-only one is
      // `RESTRICTED_BUSINESS_INITIATED_CALLING` ("Business cannot initiate
      // outbound calls"). Matching only "BUSINESS_INITIATED" therefore MISSED the
      // strongest restriction of the two, so when it arrived alongside the
      // user-initiated entry the arbitrary `[0]` could pick the inbound-only one
      // and outbound calls were left ungated — a week of unexplained hard call
      // failures behind a banner that said inbound-only. Check the combined form
      // first, then either outbound spelling.
      const isBothDirections = (t: string) =>
        t.includes("BIZ_INITIATED_AND_USER_INITIATED") ||
        t.includes("BUSINESS_INITIATED_AND_USER_INITIATED");
      const isOutbound = (t: string) =>
        t.includes("BIZ_INITIATED") || t.includes("BUSINESS_INITIATED");
      const calling =
        callingRestrictions.find((r) => isBothDirections(r.restriction_type ?? "")) ??
        callingRestrictions.find((r) => isOutbound(r.restriction_type ?? "")) ??
        callingRestrictions[0];
      if (calling) {
        matched = true;
        health.callingRestrictedUntil = expiry(calling);
        health.callingRestrictionType = calling.restriction_type ?? null;
        // The documented human field is `remediation` ("<REMEDIATION_STEPS>"),
        // not `reason` — reading only `reason` left this ALWAYS null, dropping the
        // one field that tells the operator how to get calling back. `reason` is
        // kept as an alias so an older pinned version still populates it.
        health.callingRestrictionReason = calling.remediation ?? calling.reason ?? null;
      }
      // Policy/spam MESSAGING enforcement (the escalation ladder in the
      // policy-enforcement guide). Matched by substring, not exact name, so a
      // future variant Meta adds still lands in the right slot — and matched
      // AFTER utility/calling, whose types also end in ...MESSAGING/...CALLING.
      const customerMessaging = info.find((r) => {
        const t = r.restriction_type ?? "";
        return t.includes("MESSAGING") && !t.includes("UTILITY") && t.includes("CUSTOMER");
      });
      if (customerMessaging) {
        matched = true;
        health.customerMessagingRestrictionType =
          customerMessaging.restriction_type ?? null;
        health.customerMessagingRestrictedUntil = expiry(customerMessaging);
      }
      const bizMessaging = info.find((r) => {
        const t = r.restriction_type ?? "";
        return (
          t.includes("MESSAGING") &&
          !t.includes("UTILITY") &&
          !t.includes("CALLING") &&
          !t.includes("CUSTOMER")
        );
      });
      if (bizMessaging) {
        matched = true;
        health.bizMessagingRestrictionType = bizMessaging.restriction_type ?? null;
        health.bizMessagingRestrictedUntil = expiry(bizMessaging);
      }
      // Entries outside every slot (RESTRICTED_ADD_PHONE_NUMBER_ACTION rides
      // along with every spam block; genuinely new types land here too) go to
      // the last-alert slot: the restriction types are not enumerated anywhere
      // we can read, so the stored trace is how a new one becomes known
      // instead of being invisible. When NOTHING matched, that alert is the
      // whole update — same posture as before, never silence.
      const unmatched = info.filter(
        (r) =>
          // Every CALLING entry is accounted for — the non-preferred direction
          // is deliberately ignored (see the preference note above), which is
          // not the same as unrecognised.
          !callingRestrictions.includes(r) &&
          ![utility, customerMessaging, bizMessaging].includes(r),
      );
      if (unmatched.length > 0 || !matched) {
        logUnhandledAccountUpdate(value, rawPayload);
        health.accountAlert = {
          source: "account_update",
          event: value.event ?? null,
          detail: JSON.stringify(
            matched ? { ...value, restriction_info: unmatched } : value,
          ).slice(0, 500),
        };
      }
      return health;
    }
    // The account-lock / disable leg of the enforcement ladder. `ban_info`
    // carries the state: SCHEDULE_FOR_DISABLE (still sending, on notice),
    // DISABLE (nothing sends until an appeal succeeds), REINSTATE (appeal
    // reversed the ban — clear the stored block). Modeled on the messaging
    // pair because that is what a ban IS — both directions blocked with no
    // expiry — which keeps the banner/composer surfaces on one code path.
    if (value.event === "DISABLED_UPDATE") {
      const state = (value.ban_info?.waba_ban_state ?? "").toUpperCase();
      const alert = {
        source: "account_update" as const,
        event: `DISABLED_UPDATE:${state || "UNKNOWN"}`,
        detail: JSON.stringify(value).slice(0, 500),
      };
      if (state === "REINSTATE") {
        return {
          kind: "channel_health",
          bizMessagingRestrictionType: null,
          bizMessagingRestrictedUntil: null,
          customerMessagingRestrictionType: null,
          customerMessagingRestrictedUntil: null,
          accountAlert: alert,
          rawPayload,
        };
      }
      if (state === "DISABLE" || state === "SCHEDULE_FOR_DISABLE") {
        return {
          kind: "channel_health",
          bizMessagingRestrictionType: `WABA_BAN_${state}`,
          bizMessagingRestrictedUntil: null,
          customerMessagingRestrictionType: `WABA_BAN_${state}`,
          customerMessagingRestrictedUntil: null,
          accountAlert: alert,
          rawPayload,
        };
      }
      // An unknown ban state falls through to the generic trace below.
    }
    if (value.event === "ACCOUNT_VIOLATION") {
      const type = value.violation_info?.violation_type;
      if (!type) return null;
      // A CALLING violation is the early warning before calling is paused, and
      // has its own field because the actionable response is different (narrow
      // call hours, hide the call button). Matched on CALLS too: the low
      // pickup-rate warning arrives as USER_INITIATED_CALLS_LOW_PICKUP_RATE
      // (call-settings doc) — "CALLING" alone misfiles it as a policy
      // violation.
      if (type.includes("CALLING") || type.includes("CALLS")) {
        return {
          kind: "channel_health",
          callingQualityWarning: type,
          rawPayload,
        };
      }
      // Everything else is a WhatsApp Business POLICY violation — the very
      // thing Meta says this webhook exists to report, and the warning that
      // precedes an account restriction. It used to be parsed and then dropped,
      // so the first a tenant heard of it was the restriction.
      return {
        kind: "channel_health",
        policyViolationType: type,
        rawPayload,
      };
    }
    // ── The integration going DARK, and coming back ────────────────────────
    //
    // Meta DOES name these now, and publishes their shapes — the comment below
    // used to say it didn't, which is why they all fell through to the anonymous
    // alert blob. Two distinct classes, and conflating them would be wrong:
    //
    // PERMANENT: the customer or Meta severed the link. `PARTNER_REMOVED` (the
    //   WABA was unshared), `PARTNER_APP_UNINSTALLED` (they deauthenticated or
    //   uninstalled the app), `ACCOUNT_DELETED`. Nothing we do resumes these — the
    //   customer has to re-onboard — so they set the restriction pair with NO
    //   expiry and are surfaced for an operator to act on.
    //
    // TRANSIENT: `ACCOUNT_OFFBOARDED` — a Coexistence client changed device or
    //   re-registered its number. Meta is explicit about the required behaviour:
    //   "Cloud API messaging | Suspended — messages cannot be sent or received via
    //   Cloud API while reonboarding is in progress", and under Detect offboarding,
    //   "Pause any pending Cloud API message sends for this client, as they fail
    //   while reonboarding is in progress." Reonboarding completes automatically in
    //   minutes and `ACCOUNT_RECONNECTED` announces it — and webhooks keep flowing
    //   throughout, so we DO get the recovery signal. Previously neither event was
    //   modelled, so an in-flight broadcast kept firing into guaranteed failure,
    //   burning recipient rows as failed and spending the rolling-24h budget.
    //
    // Reusing the messaging pair rather than inventing a column: it is exactly what
    // `DISABLED_UPDATE` does above, for the same reason — both directions blocked,
    // no expiry — which keeps the composer, banner and broadcast-pause surfaces on
    // one code path instead of three.
    const DARK_EVENTS: Record<string, string> = {
      PARTNER_REMOVED: "PARTNER_REMOVED",
      PARTNER_APP_UNINSTALLED: "PARTNER_APP_UNINSTALLED",
      ACCOUNT_DELETED: "ACCOUNT_DELETED",
      ACCOUNT_OFFBOARDED: "COEXISTENCE_REONBOARDING",
    };
    const darkEvent = value.event ? DARK_EVENTS[value.event.toUpperCase()] : undefined;
    if (darkEvent) {
      // `disconnection_info` (added 2026-04-03, three more reasons 2026-04-20) says
      // WHY, which is the difference between "they churned" and "their device
      // restarted". Carried verbatim into the alert rather than mapped, so a reason
      // Meta adds later still reaches the operator.
      const why = value.disconnection_info;
      const suffix = why?.reason ? `:${why.reason}` : "";
      return {
        kind: "channel_health",
        bizMessagingRestrictionType: darkEvent,
        bizMessagingRestrictedUntil: null,
        customerMessagingRestrictionType: darkEvent,
        customerMessagingRestrictedUntil: null,
        accountAlert: {
          source: "account_update",
          event: `${value.event}${suffix}`,
          detail: JSON.stringify(value).slice(0, 500),
        },
        rawPayload,
      };
    }
    if ((value.event ?? "").toUpperCase() === "ACCOUNT_RECONNECTED") {
      // Reonboarding finished. Clear the suspension so sends resume; the existing
      // paused-broadcast recovery path picks them up from here.
      return {
        kind: "channel_health",
        bizMessagingRestrictionType: null,
        bizMessagingRestrictedUntil: null,
        customerMessagingRestrictionType: null,
        customerMessagingRestrictedUntil: null,
        accountAlert: {
          source: "account_update",
          event: "ACCOUNT_RECONNECTED",
          detail: JSON.stringify(value).slice(0, 500),
        },
        rawPayload,
      };
    }
    // Any OTHER `account_update` event.
    //
    // So the rule is: parse what Meta has documented, and persist everything
    // else as the last-alert slot rather than guessing at a payload. When that
    // event lands, this is what turns "sends mysteriously stopped" into a
    // dated, queryable trace on the right WABA's connections.
    logUnhandledAccountUpdate(value, rawPayload);
    return {
      kind: "channel_health",
      accountAlert: {
        source: "account_update",
        event: value.event ?? null,
        detail: JSON.stringify(value).slice(0, 500),
      },
      rawPayload,
    };
  }
  let messagingTier: string | undefined;
  // `current_limit` is OVERLOADED by `event` (phone-number-quality-update
  // reference): on THROUGHPUT_UPGRADE it describes the number's THROUGHPUT
  // ("TIER_UNLIMITED — higher throughput", the doc's own example), NOT the
  // messaging limit. Reading it as a tier there set the portfolio's 24h cap
  // to UNLIMITED off a throughput event — ungating campaigns in the
  // dangerous direction. The reference lists the same value vocabulary for
  // <MAX_DAILY_MESSAGES_LIMIT>, so the guard covers BOTH fields on that
  // event (the health poll owns throughput).
  const isThroughputEvent =
    field === "phone_number_quality_update" &&
    value.event?.trim().toUpperCase() === "THROUGHPUT_UPGRADE";
  // The portfolio limit, on whichever webhook delivered it, wins. Limits have
  // been portfolio-scoped since 2025-10-07 — a per-phone number is at best the
  // same value and at worst a stale one.
  if (value.max_daily_conversations_per_business != null && !isThroughputEvent) {
    messagingTier = String(value.max_daily_conversations_per_business);
  } else if (field === "phone_number_quality_update") {
    // Skip the legacy `current_limit` read for the throughput event too;
    // every other/absent event keeps the legacy limit reading until Meta
    // removes the field (Feb 2026).
    if (value.current_limit && !isThroughputEvent) {
      messagingTier = value.current_limit;
    }
  } else if (field === "business_capability_update") {
    if (value.max_daily_conversation_per_phone != null) {
      messagingTier = String(value.max_daily_conversation_per_phone);
    }
  }
  // The portfolio's phone-number allowance rides business_capability_update.
  // Current reference spelling first, legacy spelling as fallback; the per-WABA
  // sibling (max_phone_numbers_per_waba) is deliberately not persisted — no
  // column models it, and the portfolio cap is what the add-number flow gates.
  let maxPhoneNumbers: number | undefined;
  if (field === "business_capability_update") {
    const rawCap =
      value.max_phone_numbers_per_business_portfolio ??
      value.max_phone_numbers_per_business;
    const capNum = rawCap != null ? Number(rawCap) : Number.NaN;
    if (Number.isFinite(capNum) && capNum > 0) maxPhoneNumbers = capNum;
  }
  // The quality band rides the same webhook. It used to be parsed PAST here —
  // a quality-only payload (no tier field) returned null and the band only
  // ever refreshed via the periodic Graph poll.
  const qualityRating =
    field === "phone_number_quality_update" &&
    typeof value.current_quality_rating === "string" &&
    value.current_quality_rating.trim()
      ? value.current_quality_rating.trim().toUpperCase()
      : undefined;
  if (
    messagingTier === undefined &&
    qualityRating === undefined &&
    maxPhoneNumbers === undefined
  ) {
    // `account_alerts` with no tier rider: the alert BODY is the payload.
    // Persist it as the last-alert slot instead of dropping it — this envelope
    // exists to explain enforcement, and it left no trace before.
    //
    // Documented shape (account-alerts reference, 2026-07): the discriminator
    // is `alert_info.alert_type` and the operator-readable sentence is
    // `alert_info.alert_description` — surface those instead of a JSON blob.
    // Undocumented variants keep the blob fallback so nothing regresses to
    // silence. `entity_type: "PHONE_NUMBER"` makes `entity_id` the number's
    // own id — the strongest attribution hint ingest can get.
    // Two-step-verification PIN events (security reference doc). Per-number
    // (the flat display_phone_number attributes it); `requester` names the
    // Business Suite user on reset REQUESTS only. An unexpected reset request
    // or a completed turn-off is the account-takeover tell, so the sentence
    // says what to do, not just what happened.
    if (field === "security") {
      const event = value.event?.trim().toUpperCase() || "UNKNOWN";
      const requester = value.requester?.trim();
      const sentence =
        event === "PIN_CHANGED"
          ? "Two-step verification PIN was changed or enabled via WhatsApp Manager."
          : event === "PIN_RESET_REQUEST"
            ? `Two-step verification reset was REQUESTED via WhatsApp Manager${requester ? ` by Business Suite user ${requester}` : ""} — if nobody on your team did this, secure your Meta Business account now.`
            : event === "PIN_REQUEST_SUCCESS"
              ? "Two-step verification was TURNED OFF via the reset email — re-enable a PIN to keep the number protected."
              : `Security event: ${event}.`;
      return {
        kind: "channel_health",
        accountAlert: {
          source: "security",
          event,
          detail: sentence,
        },
        rawPayload,
      };
    }
    // WABA policy review verdict (account-review-update reference doc).
    // Everything except APPROVED means "this WABA cannot be used with the
    // APIs" — the operator explanation for every send suddenly failing.
    if (field === "account_review_update") {
      const decision = value.decision?.trim().toUpperCase() || "UNKNOWN";
      const sentence =
        decision === "APPROVED"
          ? "WhatsApp Business Account review: approved — the account is ready for use."
          : decision === "REJECTED"
            ? "WhatsApp Business Account review: REJECTED — the account doesn't meet Meta's policy requirements and cannot be used with the API until resolved."
            : decision === "PENDING"
              ? "WhatsApp Business Account review: pending — the account can't be used with the API until Meta's review completes."
              : decision === "DEFERRED"
                ? "WhatsApp Business Account review: deferred — Meta needs more information before the account can be used with the API."
                : `WhatsApp Business Account review: ${decision}.`;
      return {
        kind: "channel_health",
        accountAlert: {
          source: "account_review_update",
          event: decision,
          detail: sentence,
        },
        rawPayload,
      };
    }
    if (field === "account_alerts") {
      const info = value.alert_info;
      const description = info?.alert_description?.trim();
      const severity = info?.alert_severity?.trim();
      const status = info?.alert_status?.trim();
      const prefix =
        severity || status
          ? `[${[severity, status].filter(Boolean).join("/")}] `
          : "";
      return {
        kind: "channel_health",
        accountAlert: {
          source: "account_alerts",
          event: info?.alert_type?.trim() || value.event || null,
          detail: description
            ? `${prefix}${description}`.slice(0, 500)
            : JSON.stringify(value).slice(0, 500),
        },
        ...(value.entity_type === "PHONE_NUMBER" && value.entity_id
          ? { phoneNumberId: value.entity_id }
          : {}),
        rawPayload,
      };
    }
    return null;
  }
  return {
    kind: "channel_health",
    ...(messagingTier !== undefined ? { messagingTier } : {}),
    ...(qualityRating !== undefined ? { qualityRating } : {}),
    ...(maxPhoneNumbers !== undefined ? { maxPhoneNumbers } : {}),
    rawPayload,
  };
}

/**
 * Send a WhatsApp call button — a tappable CTA that starts a call TO us.
 *
 * The inverse of a permission request: instead of asking to call the customer,
 * this invites them to call, which needs no permission at all and (with
 * callback permission enabled) grants us permission as a side effect.
 *
 * The optional `payload` is the attribution handle — it comes back on the call
 * webhooks as `cta_payload`, so an inbound call can be traced to the button
 * that produced it. Older WhatsApp clients drop it, so never treat its absence
 * as an error.
 */
/** Wire shape of `POST|DELETE /{phone-id}/block_users` (Block Users API). */
export interface MetaBlockUsersResponse {
  block_users?: {
    added_users?: Array<{ input?: string; wa_id?: string }>;
    removed_users?: Array<{ input?: string; wa_id?: string }>;
    failed_users?: Array<{
      input?: string;
      wa_id?: string;
      errors?: Array<{
        message?: string;
        code?: number;
        error_data?: { details?: string };
      }>;
    }>;
  };
  error?: { message?: string; code?: number };
}

/**
 * Block Users API response → per-user ledger. Exported for tests.
 *
 * The load-bearing rule: a MIXED response carries `failed_users` AND a
 * top-level OAuth-style `error` (#139100) in the SAME body — so the top-level
 * error must never be read as "the whole call failed" when the `block_users`
 * ledger is present. Successes arrive as `added_users` (block) or
 * `removed_users` (unblock); both map to `succeeded`.
 */
export function parseBlockUsersResponse(
  json: MetaBlockUsersResponse,
): BlockUsersResult {
  const toOutcome = (
    u: { input?: string; wa_id?: string },
    error: BlockUserOutcome["error"],
  ): BlockUserOutcome => ({
    input: u.input ?? "",
    externalUserId: u.wa_id ?? null,
    error,
  });
  const succeeded = [
    ...(json.block_users?.added_users ?? []),
    ...(json.block_users?.removed_users ?? []),
  ].map((u) => toOutcome(u, null));
  const failed = (json.block_users?.failed_users ?? []).map((u) => {
    const err = u.errors?.[0];
    return toOutcome(u, {
      code: typeof err?.code === "number" ? err.code : null,
      message: err?.message ?? null,
      details: err?.error_data?.details ?? null,
    });
  });
  return { succeeded, failed };
}

/**
 * One cheap top-level walk of a WhatsApp webhook envelope, for the two decisions
 * the webhook route has to make BEFORE parsing.
 *
 * `hasHistory` — a Coexistence `history` chunk is diverted to the background
 * worker UNPARSED (it can carry thousands of messages, and parsing it inline
 * would blow the 5s webhook budget). Meta delivers history in its own webhook,
 * never mixed with live messages, so one match means the whole POST is backfill.
 *
 * `accountIds` — the distinct receiving numbers named anywhere in the body, in
 * payload order. The route uses this only to decide whether a payload is worth
 * enqueuing at all (does this workspace own ANY of these numbers?). Real
 * attribution is per-event, off `NormalizedEvent.externalAccountId`.
 *
 * Wire shape only: no DB, no policy. Resolving these ids to `ChannelConnection`
 * rows is the domain layer's job (`lib/providers/inbound-accounts.ts`).
 */
export function scanWhatsappEnvelope(payload: unknown): {
  hasHistory: boolean;
  accountIds: string[];
} {
  const p = payload as {
    entry?: Array<{
      changes?: Array<{
        field?: string;
        value?: { metadata?: { phone_number_id?: string } };
      }>;
    }>;
  };
  let hasHistory = false;
  const accountIds: string[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(p?.entry) ? p.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.field === "history") hasHistory = true;
      const id = change?.value?.metadata?.phone_number_id;
      if (id && !seen.has(id)) {
        seen.add(id);
        accountIds.push(id);
      }
    }
  }
  return { hasHistory, accountIds };
}

