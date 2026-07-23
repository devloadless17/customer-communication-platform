import { readLimitedBody } from "@/lib/http/safe-fetch";
import type { MetaSendConfig } from "@/lib/providers/config";
import { MetaSendError, normalizeMetaSendError } from "./meta-send-error";
import { metaWireEnabled, wireOut } from "./meta-wire";

// Meta error responses are tiny in practice (JSON envelope, a few KB).
// Cap reads so a future endpoint or a compromised upstream returning a
// multi-GB response can't OOM the worker. Errors longer than the cap
// are truncated — we keep what fits and log the truncation.
const META_ERROR_BODY_CAP = 8192;

async function safeMetaText(res: Response): Promise<string> {
  try {
    const truncated = await readLimitedBody(res, META_ERROR_BODY_CAP);
    return truncated ?? "";
  } catch {
    return "";
  }
}
import type {
  CallHoursWindow,
  CallPermissionState,
  CallSettings,
  CallSettingsState,
  CreateTemplateArgs,
  CreateTemplateResult,
  DeleteTemplateArgs,
  FetchedMedia,
  MessagingProvider,
  NormalizedCallEvent,
  NormalizedChannelHealth,
  NormalizedContactSync,
  NormalizedEvent,
  NormalizedInboundMessage,
  NormalizedMediaRef,
  NormalizedMessageCorrection,
  NormalizedOutboundEcho,
  NormalizedReaction,
  NormalizedStatusUpdate,
  NormalizedTemplateStatusUpdate,
  ProviderTemplate,
  SendInteractiveArgs,
  SendLocationArgs,
  SendContactsArgs,
  SendReactionArgs,
  SendMediaArgs,
  SendTemplateArgs,
  SendTextArgs,
  SendTextResult,
  TemplateCategory,
  TemplateComponent,
  TemplateStatus,
  ProviderTemplateAnalyticsRow,
  TemplateAnalyticsArgs,
  UploadHeaderMediaArgs,
  UploadHeaderMediaResult,
  UploadMediaArgs,
  UploadMediaResult,
} from "@ccp/shared/providers/types";
import { CHANNEL_CAPABILITIES } from "@ccp/shared/providers/capabilities";
import type { MediaKind, MessageAttribution, MessageStatus, MessageStructured } from "@ccp/shared/types";

/**
 * Meta WhatsApp Cloud API webhook parser.
 *
 * Payload shape (abridged):
 *   { object, entry: [{ id, changes: [{ field, value: { messages?, statuses?, contacts?, metadata } }] }] }
 *
 * Walks `entry[].changes[].value` and emits one NormalizedInboundMessage per
 * incoming text message. Statuses are dropped at parse time for now (logged
 * at the route).
 *
 * Send / read calls take a MetaSendConfig (phone_number_id + access token)
 * loaded from the Team row by the route handler — the provider itself reads
 * no env vars. CLAUDE.md rule #6.
 */

/**
 * `fetch` with a hard timeout. Every Meta Graph / CDN call goes through here
 * so a hung upstream can't stall the request that triggered it — most
 * importantly the webhook handler, which downloads inbound media synchronously
 * before it returns 200 to Meta. Without this, one slow CDN response makes
 * Meta time the webhook out and retry the whole batch.
 */
// `??` only catches null/undefined — empty string slips through to Number("")
// which is 0, making every Meta call abort instantly. docker-compose.yml
// passes the empty string when META_FETCH_TIMEOUT_MS isn't set in .env, so
// the fallback only fires via `||` on a falsy parse.
const META_FETCH_TIMEOUT_MS = Number(process.env.META_FETCH_TIMEOUT_MS) || 20_000;
const META_FETCH_MAX_ATTEMPTS = 2; // 1 retry on transient 5xx
// Graph origin for every WhatsApp call. Real Meta by default; `META_GRAPH_BASE_URL`
// overrides it so an e2e run can point the whole app at a local mock Graph server.
// Read once at load (fixed for the process lifetime); duplicated locally rather
// than imported from meta-graph.ts to keep this stable WhatsApp path decoupled
// from the social helpers — same posture as DEFAULT_GRAPH_VERSION across configs.
const GRAPH_BASE = process.env.META_GRAPH_BASE_URL || "https://graph.facebook.com";

/**
 * Per-call fetch options layered on top of `RequestInit`.
 *
 *   retry — opt IN to the transient-5xx/timeout retry. Defaults to FALSE so a
 *           non-idempotent POST (a /messages send, a /calls initiation) is NEVER
 *           silently re-sent. Meta's send + call POSTs carry no idempotency key,
 *           so blindly retrying a 503/timeout blip can deliver the SAME WhatsApp
 *           message twice (customer-visible duplicate) or ring the customer
 *           twice — the exact failure class the OutboundSendAttempt /
 *           BroadcastSendAttempt guards + workflow skipped_after_crash journal
 *           exist to prevent. Those guards own the retry/refuse decision for
 *           sends; metaFetch must not pre-empt them. Idempotent / safe-to-repeat
 *           reads (fetchMedia, markIncomingRead, fetchTemplates, media upload,
 *           settings GET) pass `retry: true` and keep the one-shot blip recovery.
 */
interface MetaFetchOptions extends RequestInit {
  retry?: boolean;
}

/**
 * Strip the query string from a URL/string for error text. The upload-session
 * call (and any future query-param-bearing endpoint) must never echo a
 * credential through a thrown error message or a 502 body.
 */
function redactUrlForError(input: string | URL): string {
  try {
    const u = typeof input === "string" ? new URL(input) : input;
    return u.origin + u.pathname;
  } catch {
    // Not a parseable absolute URL — return as-is (no query to leak).
    return String(input);
  }
}

async function metaFetch(
  input: string | URL,
  init?: MetaFetchOptions,
): Promise<Response> {
  // Retry policy: transient 5xx + network errors get one quick retry, but ONLY
  // when the caller opts in via `retry: true`. Default OFF — see MetaFetchOptions
  // for why non-idempotent send/call POSTs must not be auto-replayed. We never
  // retry 4xx either way — those are policy errors (24h-window closed, template
  // missing, bad auth) where retrying just hides the real problem.
  const retry = init?.retry === true;
  const maxAttempts = retry ? META_FETCH_MAX_ATTEMPTS : 1;
  // Don't pass our own `retry` flag through to fetch's RequestInit.
  const { retry: _retry, ...fetchInit } = init ?? {};
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), META_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(input, { ...fetchInit, signal: ac.signal });
      // 5xx is transient by Meta convention. Retry once with backoff. The
      // request body is whatever the caller passed in `init.body` — fetch
      // re-uses it on retry without re-streaming concerns because all our
      // bodies are buffered (JSON or FormData built from in-memory bytes).
      if (res.status >= 500 && res.status < 600 && attempt < maxAttempts - 1) {
        // Drain so the connection can be reused by the keepalive pool.
        await res.text().catch(() => {});
        await sleep(500 + Math.random() * 250);
        continue;
      }
      // Dev wire log (DEBUG_META_WIRE): read a CLONE so the caller's body is
      // untouched. Gated + guarded — never affects the returned response.
      if (metaWireEnabled()) {
        const reqBody = typeof fetchInit.body === "string" ? fetchInit.body : "<binary>";
        const text = await res.clone().text().catch(() => "");
        wireOut(String(fetchInit.method ?? "GET"), redactUrlForError(input), reqBody, res.status, text);
      }
      return res;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // Timeouts surface as a typed error after the last attempt; mid-loop
        // we treat them as retryable network blips. The URL is redacted so a
        // query-param credential (e.g. a future signed-URL endpoint) can't leak
        // into the message that propagates to logs / a 502 error body.
        lastErr = new Error(
          `meta request timed out after ${META_FETCH_TIMEOUT_MS}ms: ${redactUrlForError(input)}`,
        );
      } else {
        lastErr = err;
      }
      if (attempt < maxAttempts - 1) {
        await sleep(500 + Math.random() * 250);
        continue;
      }
      throw lastErr;
    } finally {
      clearTimeout(timer);
    }
  }
  // Unreachable — loop returns or throws above.
  throw lastErr ?? new Error("metaFetch: no attempts ran");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface MetaEnvelope {
  object?: string;
  entry?: MetaEntry[];
}

interface MetaEntry {
  id?: string;
  changes?: MetaChange[];
}

interface MetaChange {
  field?: string;
  value?: MetaChangeValue;
}

interface MetaChangeValue {
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
  // `template_category_update` webhook fields — Meta auto-migrated a template's
  // category. `correct_category` is the current spec field; `new_category` is the
  // older alias. UPPERCASE (MARKETING | UTILITY | AUTHENTICATION).
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
  // `account_update` webhook fields — account-level enforcement. `event` above
  // discriminates: ACCOUNT_VIOLATION is an early quality warning,
  // ACCOUNT_RESTRICTION is an active pause with an expiry.
  restriction_info?: Array<{
    restriction_type?: string;
    reason?: string;
    /** Epoch seconds the restriction lifts. */
    expiration?: number;
  }>;
  violation_info?: { violation_type?: string };
  // `user_preferences` webhook: Meta reports a WhatsApp user's marketing
  // messaging preference. `value` is "stop" | "resume"; `category` is
  // "marketing". This is the ONLY signal allowed to CLEAR an opt-out.
  user_preferences?: Array<{
    wa_id?: string;
    detail?: string;
    category?: string;
    value?: string;
    timestamp?: string;
  }>;
  max_daily_conversation_per_phone?: number | string;
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
  // Value-level errors, used by two unrelated signals:
  //   - the history-declined code 2593109 ("History sync is turned off by the
  //     business from the WhatsApp Business App"), which can surface here or
  //     per history entry — we check both;
  //   - the calling error on a FAILED call terminate, sitting alongside
  //     `calls[]`, which is the only place Meta says WHY a call failed.
  errors?: MetaStatus["errors"];
}

// One chunk of the Coexistence history backfill. Meta splits the past ~180 days
// into 3 phases (0: day 0-1, 1: day 1-90, 2: day 90-180); large phases are
// further split across webhooks ordered by `chunk_order`, with `progress`
// (0-100) tracking completion. Group chats are excluded by Meta.
interface MetaHistoryEntry {
  metadata?: { phase?: number; chunk_order?: number; progress?: number };
  threads?: Array<{ id?: string; messages?: MetaMessage[] }>;
  errors?: Array<{ code?: number; title?: string; message?: string }>;
}

// One address-book change from the `smb_app_state_sync` webhook.
interface MetaStateSyncEntry {
  type?: string; // "contact"
  contact?: { full_name?: string; first_name?: string; phone_number?: string };
  action?: string; // "add" (added/edited) | "remove"
  metadata?: { timestamp?: string };
}

/**
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
}

/**
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
  /** BSUID of the callee on call statuses. */
  recipient_user_id?: string;
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
  };
  conversation?: {
    id?: string;
    origin?: { type?: string };
  };
  /** Present on `status: "failed"` — the actual delivery-rejection reason. */
  errors?: Array<{
    code?: number;
    title?: string;
    message?: string;
    error_data?: { details?: string };
  }>;
}

/** The `calling` object in a phone-number settings response. */
interface MetaCallingSettings {
  status?: string;
  call_icon_visibility?: string;
  callback_permission_status?: string;
  call_hours?: {
    status?: string;
    timezone_id?: string;
    weekly_operating_hours?: Array<{
      day_of_week?: string;
      open_time?: string;
      close_time?: string;
    }>;
  };
  /** Present while Meta has paused calling on this number. */
  restrictions?: {
    restrictions_list?: Array<{
      type?: string;
      reason?: string;
      /** Epoch seconds the restriction lifts. */
      expiration?: number;
    }>;
  };
}

interface MetaContact {
  profile?: { name?: string };
  /** The customer's phone. CONDITIONAL since the 2026 BSUID rollout: Meta omits
   *  it unless we've messaged/called that number in the last 30 days. */
  wa_id?: string;
  /** The business-scoped user id (BSUID), e.g. "LB.946402411360800". Present on
   *  inbound webhooks since the April-2026 rollout, whether or not the customer
   *  enabled a username. This — not `messages[]` — is where Meta puts it. */
  user_id?: string;
  /** Set only for customers who enabled the optional WhatsApp @username (2026). */
  username?: string;
  /** Parent portfolio BSUID ("US.ENT.…") for multi-portfolio businesses. */
  parent_user_id?: string;
}

interface MetaMediaPayload {
  id?: string;
  mime_type?: string;
  caption?: string;
  filename?: string;
  // audio voice notes carry voice=true; we treat both as "audio"
  voice?: boolean;
  // not all media types include a duration but some do
  duration?: number;
}

interface MetaContextRef {
  // Wamid of the message this one is replying to.
  id?: string;
  // The wa_id of the original sender (kept for debugging only).
  from?: string;
}

interface MetaInteractivePayload {
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
  /** WhatsApp Flows submission payload (JSON string). Retained via rawPayload. */
  nfm_reply?: { response_json?: string; name?: string };
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

interface MetaLocationPayload {
  latitude?: number;
  longitude?: number;
  name?: string;
  address?: string;
}

interface MetaContactsPayload {
  name?: { formatted_name?: string };
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
}

interface MetaMessage {
  from?: string;
  // NOTE: BSUID / @username do NOT live here. Meta stamps them on `contacts[]`
  // as `user_id` / `username` (see MetaContact) — the parser reads them from
  // there. `messages[].from` carries the phone (or the BSUID once Meta stops
  // sending the phone for a cold contact).
  // Present on Coexistence echo/history rows the BUSINESS sent: the CUSTOMER's
  // number. Absent on ordinary inbound `messages[]` (where `from` is already
  // the customer).
  to?: string;
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
}

const META_MEDIA_TYPES: MediaKind[] = ["image", "video", "audio", "document", "sticker"];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Customer message types we don't render with a dedicated bubble yet —
 * location pins, contact cards (vCard), orders, and Meta's `unsupported`
 * fallback. Rather than dropping them silently (which loses the message, never
 * updates unread / the 24h window, and leaves Meta no reason to redeliver), we
 * ingest them as a plain text row carrying a typed placeholder body. The raw
 * payload is preserved on the Message row, so proper rendering can be layered
 * on later without data loss. Returns null only for genuinely empty/unknown
 * shapes where no useful placeholder exists.
 */
function placeholderForUnhandledType(m: MetaMessage): string | null {
  switch (m.type) {
    case "location": {
      const loc = m.location;
      const place = loc?.name || loc?.address;
      if (place) return `📍 Location: ${place}`;
      if (loc && loc.latitude != null && loc.longitude != null) {
        return `📍 Location shared (${loc.latitude}, ${loc.longitude})`;
      }
      return "📍 Location shared";
    }
    case "contacts": {
      const names = (m.contacts ?? [])
        .map((c) => c.name?.formatted_name?.trim())
        .filter((n): n is string => Boolean(n));
      if (names.length > 0) return `👤 Contact card: ${names.join(", ")}`;
      return "👤 Contact card shared";
    }
    case "order": {
      // Surface the buyer's note attached to the order (doc `order.text`) instead
      // of dropping it — otherwise the customer's message is invisible in-inbox.
      const note = m.order?.text?.trim();
      return note ? `🛒 Order shared — ${note}` : "🛒 Order shared";
    }
    case "unsupported": {
      // Meta strips the content for unsupported types; the errors array is the
      // only context. Common cause: a template/interactive message received by
      // a WhatsApp Business (Cloud API) number from another business — the
      // phone renders it, but the inbound webhook can't. Surface Meta's reason
      // when present so it's not a context-free "Unsupported message".
      const err = m.errors?.[0];
      const reason = err?.error_data?.details?.trim() || err?.title?.trim();
      return reason ? `⚠️ Unsupported message — ${reason}` : "⚠️ Unsupported message";
    }
    default:
      // Unknown future type Meta might add — surface SOMETHING so it's
      // visible + counts toward unread, rather than vanishing.
      return m.type ? `Unsupported message (${m.type})` : null;
  }
}

/**
 * Build the structured (non-media) payload for a location pin or contact card so
 * the bubble can render a map / vCard instead of the bare text placeholder.
 * Returns undefined for types without structured rendering (order/unsupported
 * stay text-only). The raw payload is always retained on the row regardless.
 */
function structuredForMessage(m: MetaMessage): MessageStructured | undefined {
  if (m.type === "location" && m.location) {
    const { latitude, longitude, name, address } = m.location;
    if (latitude == null || longitude == null) return undefined;
    return {
      kind: "location",
      latitude,
      longitude,
      ...(name?.trim() ? { name: name.trim() } : {}),
      ...(address?.trim() ? { address: address.trim() } : {}),
    };
  }
  if (m.type === "contacts" && Array.isArray(m.contacts)) {
    const contacts = m.contacts
      .map((c) => {
        // Fold a vCard address into one human line ("1 Lucky Way, Menlo Park,
        // CA 94025, US"), dropping empty parts — the same way WhatsApp shows it.
        const addresses = (c.addresses ?? [])
          .map((a) =>
            [a.street, a.city, a.state, a.zip, a.country ?? a.country_code]
              .map((x) => x?.trim())
              .filter((x): x is string => !!x && x.length > 0)
              .join(", "),
          )
          .filter((a) => a.length > 0);
        // "Title · Company" (either part optional).
        const company = [c.org?.title?.trim(), c.org?.company?.trim()]
          .filter((x): x is string => !!x && x.length > 0)
          .join(" · ");
        return {
          name: c.name?.formatted_name?.trim() ?? "",
          phones: (c.phones ?? [])
            .map((p) => p.phone?.trim() ?? "")
            .filter((p) => p.length > 0),
          emails: (c.emails ?? [])
            .map((e) => e.email?.trim() ?? "")
            .filter((e) => e.length > 0),
          addresses,
          ...(company ? { company } : {}),
        };
      })
      .filter(
        (c) =>
          c.name.length > 0 ||
          c.phones.length > 0 ||
          c.emails.length > 0 ||
          c.addresses.length > 0,
      )
      // Keep the wire lean: drop empty optional arrays so an old-shape row and a
      // new phones-only row serialize identically.
      .map((c) => ({
        name: c.name,
        phones: c.phones,
        ...(c.emails.length ? { emails: c.emails } : {}),
        ...(c.addresses.length ? { addresses: c.addresses } : {}),
        ...(c.company ? { company: c.company } : {}),
      }));
    if (contacts.length === 0) return undefined;
    return { kind: "contacts", contacts };
  }
  if (m.type === "order" && m.order?.product_items?.length) {
    const items = m.order.product_items
      .map((it) => {
        const retailerId = it.product_retailer_id?.trim() ?? "";
        const quantity = Number(it.quantity ?? 0) || 0;
        const price = it.item_price != null ? Number(it.item_price) : undefined;
        return {
          retailerId,
          quantity,
          ...(price != null && Number.isFinite(price) ? { price } : {}),
        };
      })
      .filter((it) => it.retailerId.length > 0 && it.quantity > 0);
    if (items.length === 0) return undefined;
    const currency = m.order.product_items.find((it) => it.currency)?.currency;
    // Only surface a `total` when EVERY item is priced — otherwise it would
    // understate the real order while being labelled a definitive "Total".
    const allPriced = items.every((it) => it.price != null);
    const total = allPriced
      ? items.reduce((sum, it) => sum + (it.price ?? 0) * it.quantity, 0)
      : 0;
    return {
      kind: "order",
      items,
      itemCount: items.reduce((n, it) => n + it.quantity, 0),
      ...(allPriced && total > 0 ? { total } : {}),
      ...(currency ? { currency } : {}),
    };
  }
  return undefined;
}

/** New body text carried by a WhatsApp `edit.message` — the text body, or a
 *  media CAPTION (only the caption is editable on media). Undefined for an edit
 *  whose new content we can't represent as text (ingest then just marks it
 *  edited without rewriting the body). */
function editBody(msg: NonNullable<MetaMessage["edit"]>["message"]): string | undefined {
  return (
    msg?.text?.body ??
    msg?.image?.caption ??
    msg?.video?.caption ??
    msg?.document?.caption ??
    undefined
  );
}

/**
 * Build ad / deep-link attribution from a WhatsApp inbound `referral` (Click-to-
 * WhatsApp). Present only on the first message of an ad-sourced conversation;
 * undefined otherwise. Surfaced as the "from your ad" chip.
 */
function attributionForMessage(m: MetaMessage): MessageAttribution | undefined {
  const r = m.referral;
  if (!r) return undefined;
  const source: MessageAttribution["source"] =
    r.source_type === "ad" ? "ad" : r.source_type === "post" ? "post" : "unknown";
  return {
    source,
    ...(r.headline?.trim() ? { headline: r.headline.trim() } : {}),
    ...(r.body?.trim() ? { body: r.body.trim() } : {}),
    ...(r.source_url?.trim() ? { sourceUrl: r.source_url.trim() } : {}),
    ...(r.ctwa_clid?.trim() ? { clickId: r.ctwa_clid.trim() } : {}),
  };
}

/**
 * Extract the renderable content (body + optional media ref) from a Meta
 * message object WITHOUT the direction/contact wrapper. Shared by the
 * Coexistence echo + history parsers, which build both inbound and outbound
 * normalized events from the same message shape depending on who sent it.
 *
 * Mirrors the inbound `messages[]` walk's text/media/placeholder handling. Two
 * deliberate simplifications vs. that walk:
 *   - interactive-reply + reaction subtypes fall through to the typed
 *     placeholder here. Those only ever originate customer-side in the LIVE
 *     `messages` field; an echo is business-sent (a business doesn't tap its
 *     own buttons) and their appearance in a history backfill is rare enough
 *     that a placeholder row is an acceptable, non-lossy fallback.
 *   - history media first arrives as `type: "media_placeholder"` (no asset id);
 *     we render it as a "📎 Media" row so the message is never silently lost.
 *     For messages within 14 days of onboarding Meta follows up with the real
 *     media; if that carries the same wamid it dedupes against this placeholder
 *     (best-effort — historical media fidelity is not load-bearing).
 */
function extractMetaMessageContent(
  m: MetaMessage,
): { body: string; media?: NormalizedMediaRef } | null {
  if (m.type === "text") {
    const body = m.text?.body;
    return body ? { body } : null;
  }
  if (m.type === "media_placeholder") {
    return { body: "📎 Media" };
  }
  const mediaKind = m.type as MediaKind | undefined;
  if (mediaKind && META_MEDIA_TYPES.includes(mediaKind)) {
    const mediaPayload = m[mediaKind] as MetaMediaPayload | undefined;
    if (!mediaPayload?.id || !mediaPayload.mime_type) return null;
    const media: NormalizedMediaRef = {
      kind: mediaKind,
      externalMediaId: mediaPayload.id,
      mimeType: mediaPayload.mime_type,
      ...(mediaPayload.filename ? { filename: mediaPayload.filename } : {}),
      ...(mediaPayload.duration ? { durationMs: mediaPayload.duration * 1000 } : {}),
      ...(mediaKind === "audio" && mediaPayload.voice ? { voice: true } : {}),
    };
    return { body: mediaPayload.caption ?? "", media };
  }
  const placeholder = placeholderForUnhandledType(m);
  return placeholder ? { body: placeholder } : null;
}

/** Digits-only phone (Meta's wa_id is digits by spec; strip defensively). */
function digitsOnly(v: string | undefined): string | undefined {
  const d = v ? v.replace(/\D/g, "") : "";
  return d.length > 0 ? d : undefined;
}

function tsFromMeta(timestamp: string | undefined): Date {
  const secs = timestamp ? Number(timestamp) : NaN;
  return Number.isFinite(secs) ? new Date(secs * 1000) : new Date();
}

/** History-declined sentinel: the owner turned off sharing in the Business App. */
const HISTORY_DECLINED_CODE = 2593109;

function mapMetaStatus(s: string | undefined): MessageStatus | null {
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
function rewriteSdpForBrowser(sdp: string): string {
  // Meta's guidance is that WE act as the DTLS client, i.e. Meta is the DTLS
  // server. `a=setup:passive` in Meta's answer is what tells the browser to be
  // the client. (Meta's real answers already pin a concrete role, so this only
  // fires on the malformed case this rewrite exists for.)
  return sdp.replace(/^a=setup:actpass$/gm, "a=setup:passive");
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
function mapMetaCallPhase(
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
      // SIP-mode only. We deliberately never enable SIP (it would disable the
      // Graph calling endpoints this whole module is built on, along with
      // Meta-side call recording), so reaching here means someone flipped SIP
      // on out-of-band. Log it rather than blackholing the call.
      console.warn(
        "[meta] calls webhook: received SIP-only `call_created` — SIP appears " +
          "to be enabled on this number, which disables the Graph calling API",
      );
      return null;
    default:
      // Includes `call_recording_available` / `call_transcription_available`
      // when those features are enabled on the Meta side but not yet consumed
      // here. Visible, not lost.
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
function parseMetaCallStatus(
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
function parseMetaCall(
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
  const bsuid =
    (identityIsPhone ? undefined : rawIdentity) ??
    (direction === "in" ? c.from_user_id : c.to_user_id) ??
    contact?.user_id;
  if (!phone && !bsuid) return null;

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

  // SDP. Rewrite `a=setup:actpass` → `setup:active` ONLY on answers —
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
  }

  return {
    kind: "call",
    externalCallId,
    ...(phone ? { contactPhone: phone } : {}),
    ...(bsuid ? { bsuid } : {}),
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
          ...(firstError.title ? { errorTitle: firstError.title } : {}),
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
function parseMetaCallPermissionReply(
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
function parseTemplateStatusUpdate(
  value: MetaChangeValue,
  rawPayload: Record<string, unknown>,
): NormalizedTemplateStatusUpdate | null {
  const externalId =
    value.message_template_id != null
      ? String(value.message_template_id)
      : undefined;
  const name = value.message_template_name;
  if (!externalId && !name) return null;
  return {
    kind: "template_status",
    ...(externalId ? { externalId } : {}),
    ...(name ? { name } : {}),
    ...(value.message_template_language
      ? { language: value.message_template_language }
      : {}),
    status: mapTemplateStatus(value.event),
    ...(value.reason ? { reason: value.reason } : {}),
    rawPayload,
  };
}

/**
 * Parse a `template_category_update` webhook into a normalized event carrying
 * only the new `category` (status stays null — this webhook doesn't change
 * review status). Returns null with no id/name to match on, or when the category
 * doesn't map to a known enum value.
 */
function parseTemplateCategoryUpdate(
  value: MetaChangeValue,
  rawPayload: Record<string, unknown>,
): NormalizedTemplateStatusUpdate | null {
  const externalId =
    value.message_template_id != null
      ? String(value.message_template_id)
      : undefined;
  const name = value.message_template_name;
  if (!externalId && !name) return null;
  const category = mapTemplateCategory(value.correct_category ?? value.new_category);
  if (!category) return null;
  return {
    kind: "template_status",
    ...(externalId ? { externalId } : {}),
    ...(name ? { name } : {}),
    ...(value.message_template_language
      ? { language: value.message_template_language }
      : {}),
    status: null,
    category,
    rawPayload,
  };
}

/**
 * Parse a number-health webhook (`phone_number_quality_update`,
 * `business_capability_update`, `account_update`, or `account_alerts`) into a
 * NormalizedChannelHealth
 * carrying whichever of tier/quality/throughput the payload actually contains.
 * Ingest merges the partial onto the WhatsApp ChannelConnection. Returns null
 * when nothing usable is present (e.g. a generic account_alerts envelope), so a
 * pure alert doesn't blank a stored snapshot. Field mapping:
 *   - phone_number_quality_update: `current_limit` → messaging tier.
 *   - business_capability_update: `max_daily_conversation_per_phone` (number) → tier.
 */
function parseChannelHealthUpdate(
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
      const calling = (value.restriction_info ?? []).find((r) =>
        r.restriction_type?.includes("CALLING"),
      );
      if (calling) {
        return {
          kind: "channel_health",
          callingRestrictedUntil: calling.expiration
            ? new Date(calling.expiration * 1000)
            : null,
          callingRestrictionType: calling.restriction_type ?? null,
          callingRestrictionReason: calling.reason ?? null,
          rawPayload,
        };
      }
      // A restriction on something OTHER than calling — leave calling state
      // untouched rather than implying it was cleared.
      return null;
    }
    if (value.event === "ACCOUNT_VIOLATION") {
      const type = value.violation_info?.violation_type;
      if (type?.includes("CALLING")) {
        return {
          kind: "channel_health",
          callingQualityWarning: type,
          rawPayload,
        };
      }
      return null;
    }
    return null;
  }
  let messagingTier: string | undefined;
  if (field === "phone_number_quality_update") {
    if (value.current_limit) messagingTier = value.current_limit;
  } else if (field === "business_capability_update") {
    if (value.max_daily_conversation_per_phone != null) {
      messagingTier = String(value.max_daily_conversation_per_phone);
    }
  }
  if (messagingTier === undefined) return null;
  return { kind: "channel_health", messagingTier, rawPayload };
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
async function sendVoiceCallButton(
  args: SendInteractiveArgs,
  config: MetaSendConfig,
): Promise<SendTextResult> {
  const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/messages`;
  const params: Record<string, unknown> = {};
  // Meta caps the label at 20 chars and defaults it to "Call Now".
  if (args.voiceCall?.displayText) {
    params.display_text = args.voiceCall.displayText.slice(0, 20);
  }
  if (args.voiceCall?.ttlMinutes != null) {
    // 1 minute to 30 days. Clamp rather than reject: a caller asking for a
    // longer-lived button wants the longest one available, not an error.
    params.ttl_minutes = Math.min(
      43_200,
      Math.max(1, Math.trunc(args.voiceCall.ttlMinutes)),
    );
  }
  if (args.voiceCall?.payload) {
    params.payload = args.voiceCall.payload.slice(0, 512);
  }
  const res = await metaFetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: args.to,
      type: "interactive",
      interactive: {
        type: "voice_call",
        body: { text: args.bodyText },
        action: {
          name: "voice_call",
          ...(Object.keys(params).length ? { parameters: params } : {}),
        },
      },
      ...(args.replyToExternalId
        ? { context: { message_id: args.replyToExternalId } }
        : {}),
    }),
  });
  if (!res.ok) {
    const text = await safeMetaText(res);
    throw new MetaSendError(
      `meta sendVoiceCallButton failed: ${res.status} ${text}`,
      res.status,
      text,
    );
  }
  const json = (await res.json()) as { messages?: Array<{ id?: string }> };
  const externalId = json.messages?.[0]?.id;
  if (!externalId) {
    throw new Error(
      `meta sendVoiceCallButton missing message id: ${JSON.stringify(json)}`,
    );
  }
  return { externalId, timestamp: new Date() };
}

export const metaProvider: MessagingProvider<MetaSendConfig> = {
  name: "whatsapp",

  // Static per-channel capabilities live in @ccp/shared so the frontend reads
  // the exact same values (no endpoint/plumbing). WhatsApp: 24h window, no
  // human-agent extension, templates + calling.
  capabilities: CHANNEL_CAPABILITIES.whatsapp,

  parseWebhook(payload: unknown): NormalizedEvent[] {
    if (!isObject(payload)) return [];
    const env = payload as MetaEnvelope;
    if (env.object !== "whatsapp_business_account") return [];

    const events: NormalizedEvent[] = [];

    for (const entry of Array.isArray(env.entry) ? env.entry : []) {
      for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
        const value = change.value;
        if (!value) continue;

        // Template lifecycle: Meta sends `message_template_status_update` when a
        // template is approved, paused for quality, disabled, or rejected. These
        // arrive under their own `field` (NOT "messages") with flat value fields.
        // Ingesting them keeps the local catalog's status fresh automatically —
        // without this, a Meta-paused marketing template silently mass-fails a
        // scheduled broadcast and a newly-approved one never becomes sendable
        // until someone clicks the manual "Sync" button.
        if (change.field === "message_template_status_update") {
          const evt = parseTemplateStatusUpdate(value, payload as Record<string, unknown>);
          if (evt) events.push(evt);
          continue;
        }

        // Template category migration: Meta auto-moved a template between
        // categories (e.g. MARKETING→UTILITY). Category drives pricing + which
        // window reopens the conversation, so keep the local row accurate rather
        // than showing a stale category until the next manual Sync.
        if (change.field === "template_category_update") {
          const evt = parseTemplateCategoryUpdate(value, payload as Record<string, unknown>);
          if (evt) events.push(evt);
          continue;
        }

        // Marketing opt-out / opt-in. Meta reports when a WhatsApp user stops (or
        // resumes) marketing messages from this business. Ingest applies it to
        // Contact.marketingOptOutAt, which the broadcast audience resolver then
        // suppresses on. Dropped entirely before this existed.
        if (change.field === "user_preferences") {
          for (const pref of value.user_preferences ?? []) {
            const waId = pref.wa_id;
            const val = pref.value?.toLowerCase();
            if (!waId || (val !== "stop" && val !== "resume")) continue;
            events.push({
              kind: "marketing_preference",
              contactPhone: waId.replace(/\D/g, ""),
              optedOut: val === "stop",
              timestamp: pref.timestamp
                ? new Date(Number(pref.timestamp) * 1000)
                : new Date(),
              rawPayload: payload as Record<string, unknown>,
            });
          }
          continue;
        }

        // Number messaging-health: Meta pushes the phone number's messaging-limit
        // TIER (how many unique customers it may message per 24h) via
        // `phone_number_quality_update` (`current_limit`) and
        // `business_capability_update` (`max_daily_conversation_per_phone`).
        // Ingesting them keeps the cached snapshot fresh so a large template
        // broadcast is gated on the number's real capacity. `account_alerts` is
        // a generic envelope with no reliable tier — the periodic Graph poll
        // covers that. All three fell through the gate below (silently dropped)
        // before this block.
        // `account_update` joins them because it carries calling ENFORCEMENT —
        // an early quality warning, or an active ~7-day pause on calling during
        // which every call and permission request fails. Storing it is what
        // turns "calling randomly stopped working" into a dated explanation.
        if (
          change.field === "phone_number_quality_update" ||
          change.field === "business_capability_update" ||
          change.field === "account_update" ||
          change.field === "account_alerts"
        ) {
          const evt = parseChannelHealthUpdate(
            change.field,
            value,
            payload as Record<string, unknown>,
          );
          if (evt) events.push(evt);
          continue;
        }

        // Template quality band change (GREEN/YELLOW/RED). Informational — a RED
        // band that pauses the template arrives separately as a status update
        // (PAUSED), which we already ingest. Log it for observability; there's no
        // sendability decision to make here.
        if (change.field === "message_template_quality_update") {
          console.warn(
            JSON.stringify({
              event: "meta.template_quality_update",
              severity: "info",
              template: value.message_template_name,
              language: value.message_template_language,
              previous: value.previous_quality_score,
              current: value.new_quality_score,
            }),
          );
          continue;
        }

        // --- WhatsApp Coexistence webhooks -------------------------------
        // Emitted only when the number runs on both the Business App and the
        // Cloud API. Each keeps the shared inbox in sync with the owner's
        // phone. Silently dropped before this block existed (the field gate
        // below rejects everything except messages/calls).

        // smb_message_echoes: a message the owner just sent FROM the phone app.
        // `from` is the business, `to` is the customer — so the conversation
        // key is `to`, and we emit an OUTBOUND echo (no authoring agent).
        if (change.field === "smb_message_echoes") {
          for (const m of Array.isArray(value.message_echoes) ? value.message_echoes : []) {
            const externalId = m.id;
            const contactPhone = digitsOnly(m.to);
            if (!externalId || !contactPhone) continue;
            const content = extractMetaMessageContent(m);
            if (!content) continue;
            events.push({
              kind: "echo",
              externalId,
              contactPhone,
              body: content.body,
              ...(content.media ? { media: content.media } : {}),
              timestamp: tsFromMeta(m.timestamp),
              rawPayload: payload as Record<string, unknown>,
            } satisfies NormalizedOutboundEcho);
          }
          continue;
        }

        // history: the past-180d backfill. Each thread is one customer
        // (`thread.id` = their number); each message is inbound (from=customer)
        // or an outbound echo (from=business). Chunked across phases — we log
        // progress and let dedup make re-delivery idempotent.
        if (change.field === "history") {
          const businessNumber = digitsOnly(value.metadata?.display_phone_number);
          // Value-level decline: sharing is off, nothing to ingest.
          if (Array.isArray(value.errors) && value.errors.some((e) => e.code === HISTORY_DECLINED_CODE)) {
            console.warn(
              JSON.stringify({ event: "coexistence.history_declined", severity: "info" }),
            );
            continue;
          }
          for (const h of Array.isArray(value.history) ? value.history : []) {
            if (Array.isArray(h.errors) && h.errors.some((e) => e.code === HISTORY_DECLINED_CODE)) {
              console.warn(
                JSON.stringify({ event: "coexistence.history_declined", severity: "info" }),
              );
              continue;
            }
            console.log(
              JSON.stringify({
                event: "coexistence.history_chunk",
                phase: h.metadata?.phase,
                chunkOrder: h.metadata?.chunk_order,
                progress: h.metadata?.progress,
                threads: Array.isArray(h.threads) ? h.threads.length : 0,
              }),
            );
            for (const thread of Array.isArray(h.threads) ? h.threads : []) {
              const threadPhone = digitsOnly(thread.id);
              for (const m of Array.isArray(thread.messages) ? thread.messages : []) {
                const externalId = m.id;
                if (!externalId) continue;
                const content = extractMetaMessageContent(m);
                if (!content) continue;
                const ts = tsFromMeta(m.timestamp);
                const fromDigits = digitsOnly(m.from);
                const isBusinessSent = !!businessNumber && fromDigits === businessNumber;
                // Customer number: prefer the thread id; else the non-business
                // endpoint of the message (`to` for echoes, `from` for inbound).
                const contactPhone =
                  threadPhone ?? (isBusinessSent ? digitsOnly(m.to) : fromDigits);
                if (!contactPhone) continue;
                if (isBusinessSent) {
                  events.push({
                    kind: "echo",
                    externalId,
                    contactPhone,
                    body: content.body,
                    ...(content.media ? { media: content.media } : {}),
                    timestamp: ts,
                    rawPayload: payload as Record<string, unknown>,
                  } satisfies NormalizedOutboundEcho);
                } else {
                  events.push({
                    kind: "message",
                    externalId,
                    contactPhone,
                    contactName: null,
                    body: content.body,
                    ...(content.media ? { media: content.media } : {}),
                    timestamp: ts,
                    rawPayload: payload as Record<string, unknown>,
                  } satisfies NormalizedInboundMessage);
                }
              }
            }
          }
          continue;
        }

        // smb_app_state_sync: the owner's phone address book changed. We use it
        // only to NAME contacts that already exist (see ingestContactSync).
        if (change.field === "smb_app_state_sync") {
          for (const s of Array.isArray(value.state_sync) ? value.state_sync : []) {
            if (s.type !== "contact" || !s.contact) continue;
            const phone = digitsOnly(s.contact.phone_number);
            if (!phone) continue;
            events.push({
              kind: "contact_sync",
              phone,
              fullName: s.contact.full_name?.trim() || null,
              action: s.action === "remove" ? "remove" : "add",
              rawPayload: payload as Record<string, unknown>,
            } satisfies NormalizedContactSync);
          }
          continue;
        }

        // Meta uses two relevant `field` values for content:
        //   "messages" — text / media / interactive / status updates
        //   "calls"    — voice call lifecycle (offer, answer, terminate, ICE,
        //                permission granted/revoked, etc.) — confirmed by
        //                live webhook payloads 2026-05-29.
        // We accept both; the per-array walkers below safely no-op on the
        // other type since `value.messages` / `value.calls` / `value.statuses`
        // are independently present.
        if (change.field !== "messages" && change.field !== "calls") {
          // Everything above is handled; anything else Meta subscribed us to
          // (account/phone-number quality alerts, flows, etc.) is dropped — but
          // logged so a NEW field type Meta starts sending surfaces in ops
          // instead of vanishing silently. Fail-soft: still a 200.
          console.warn(
            JSON.stringify({
              event: "meta.webhook.unhandled_field",
              severity: "info",
              object: "whatsapp_business_account",
              field: change.field,
            }),
          );
          continue;
        }

        // `contacts[]` — not `messages[]` — is where Meta puts the customer's
        // identity: display name, the business-scoped user id (`user_id`, the
        // BSUID) and the optional WhatsApp `username`. Index by BOTH keys: since
        // the 2026 rollout Meta omits `wa_id` for a contact we haven't messaged
        // in 30 days, and then `messages[].from` is the BSUID instead.
        const contactByKey = new Map<string, MetaContact>();
        for (const c of Array.isArray(value.contacts) ? value.contacts : []) {
          if (c.wa_id) contactByKey.set(c.wa_id.replace(/\D/g, ""), c);
          if (c.user_id) contactByKey.set(c.user_id, c);
        }

        for (const m of Array.isArray(value.messages) ? value.messages : []) {
          const externalId = m.id;
          const rawFrom = typeof m.from === "string" ? m.from.trim() : "";
          // A wa_id is digits-only by spec; a BSUID is prefixed and dotted
          // ("LB.946402411360800"). Never digit-strip a BSUID — that would mint
          // a bogus phone number and create a contact under a fake identity.
          // A phone `from` is all digits; tolerate the doc's leading "+"
          // (`+16505551234`) by stripping it before the digit test so a plus-
          // prefixed number isn't misclassified as a BSUID (phone is stored
          // digits-only elsewhere anyway).
          const phoneDigits = rawFrom.replace(/^\+/, "");
          const fromIsPhone = phoneDigits.length > 0 && !/\D/.test(phoneDigits);
          const phone = fromIsPhone ? phoneDigits : undefined;
          const contact = contactByKey.get(rawFrom);
          // BSUID + @username come off `contacts[]`; fall back to `from` when it
          // IS the BSUID (Meta omitted the phone for a cold contact).
          const bsuid =
            contact?.user_id?.trim() || (!fromIsPhone && rawFrom ? rawFrom : undefined);
          const username = contact?.username?.trim() || undefined;
          if (!externalId || (!phone && !bsuid)) continue;
          const contactName = contact?.profile?.name ?? null;
          // Shared identity fragment spread into every inbound-message emit
          // below (exactly one of phone/bsuid is the resolve key at ingest).
          const identity = {
            ...(phone ? { contactPhone: phone } : {}),
            ...(bsuid ? { bsuid } : {}),
            ...(username ? { username } : {}),
          };
          // Click-to-WhatsApp ad attribution (only on the first ad-sourced
          // inbound) — spread into the content emits so the "from your ad" chip
          // renders on whichever message type carried the referral.
          const attribution = attributionForMessage(m);
          const attributionSpread = attribution ? { attribution } : {};

          const tsSecs = m.timestamp ? Number(m.timestamp) : NaN;
          const ts = Number.isFinite(tsSecs) ? new Date(tsSecs * 1000) : new Date();

          // Customer changed their WhatsApp number (`type:"system"`). Migrate the
          // existing contact to the NEW number (`system.wa_id`) so their thread
          // CONTINUES instead of forking into a second contact/conversation when
          // they next message. `from` (= `phone` here) is the OLD number.
          if (m.type === "system" && m.system?.type === "user_changed_number") {
            const newPhone = m.system.wa_id?.replace(/^\+/, "").trim();
            if (phone && newPhone && /^\d+$/.test(newPhone) && newPhone !== phone) {
              events.push({
                kind: "contact_number_change",
                oldPhone: phone,
                newPhone,
                rawPayload: payload as Record<string, unknown>,
              });
            }
            continue;
          }

          // Customer EDITED or UNSENT (revoked) a prior message — a correction,
          // not a new message. Match is EXACT (`original_message_id` = the target
          // wamid), so ingest rewrites/tombstones precisely that row. Checked
          // BEFORE the content branches. (Best-effort on the Cloud API; honoured
          // when delivered — mirrors the Messenger/IG `is_deleted` path.)
          if (m.type === "edit" && m.edit?.original_message_id) {
            const newBody = editBody(m.edit.message);
            events.push({
              kind: "message_correction",
              action: "edit",
              targetExternalId: m.edit.original_message_id,
              ...(newBody ? { newBody } : {}),
              timestamp: ts,
              rawPayload: payload as Record<string, unknown>,
            } satisfies NormalizedMessageCorrection);
            continue;
          }
          if (m.type === "revoke" && m.revoke?.original_message_id) {
            events.push({
              kind: "message_correction",
              action: "delete",
              targetExternalId: m.revoke.original_message_id,
              timestamp: ts,
              rawPayload: payload as Record<string, unknown>,
            } satisfies NormalizedMessageCorrection);
            continue;
          }

          // Pre-extract the optional reply context so both text + media branches
          // share the same shape. Meta sends `context.id` as the wamid of the
          // original; we round-trip the wamid and let ingest resolve to our id.
          const replyToExternalId = m.context?.id;

          if (m.type === "text") {
            const body = m.text?.body;
            if (!body) continue;
            events.push({
              kind: "message",
              externalId,
              ...identity,
              contactName,
              body,
              ...attributionSpread,
              timestamp: ts,
              rawPayload: payload as Record<string, unknown>,
              ...(replyToExternalId ? { replyToExternalId } : {}),
            } satisfies NormalizedInboundMessage);
            continue;
          }

          // Interactive reply: the contact tapped a button or list row on a
          // previous outbound interactive message. The author-assigned id
          // round-trips back as `interactive.button_reply.id` (or
          // `list_reply.id`); the displayed text comes back as `title`.
          // We fold the title into `body` for uniform search + preview AND
          // surface the structured payload via `interactiveReply` for the
          // ask_question step to route on.
          if (m.type === "interactive") {
            const inner = m.interactive;
            // Call-permission decision. Must be checked BEFORE the generic
            // fallback below, which would otherwise turn the customer's
            // "Allow calls" into a meaningless "💬 Interactive reply" bubble
            // and leave the permission itself unrecorded.
            if (
              inner?.type === "call_permission_reply" &&
              inner.call_permission_reply
            ) {
              const permEvent = parseMetaCallPermissionReply(
                inner.call_permission_reply,
                identity,
                contactName,
                // context.id is the request message we sent (or, for a callback
                // grant, the missed call that triggered it).
                replyToExternalId,
                ts,
                payload as Record<string, unknown>,
              );
              if (permEvent) events.push(permEvent);
              continue;
            }
            if (inner?.type === "button_reply" && inner.button_reply) {
              const { id: optId, title } = inner.button_reply;
              if (!optId || !title) continue;
              events.push({
                kind: "message",
                externalId,
                ...identity,
                contactName,
                body: title,
                interactiveReply: { kind: "button_reply", id: optId, title },
                timestamp: ts,
                rawPayload: payload as Record<string, unknown>,
                ...(replyToExternalId ? { replyToExternalId } : {}),
              } satisfies NormalizedInboundMessage);
              continue;
            }
            if (inner?.type === "list_reply" && inner.list_reply) {
              const { id: optId, title } = inner.list_reply;
              if (!optId || !title) continue;
              events.push({
                kind: "message",
                externalId,
                ...identity,
                contactName,
                body: title,
                interactiveReply: { kind: "list_reply", id: optId, title },
                timestamp: ts,
                rawPayload: payload as Record<string, unknown>,
                ...(replyToExternalId ? { replyToExternalId } : {}),
              } satisfies NormalizedInboundMessage);
              continue;
            }
            // Any other interactive subtype — today most importantly WhatsApp
            // Flows (`nfm_reply`, a submitted form). Persist a placeholder row
            // rather than dropping it: we 200 the webhook, so Meta never
            // redelivers, and a bare `continue` loses the customer's submission
            // completely — no message row, no unread bump, no 24h-window reset,
            // not even the raw payload to recover from later. Same contract as
            // placeholderForUnhandledType for location/contacts/order.
            events.push({
              kind: "message",
              externalId,
              ...identity,
              contactName,
              body: inner?.type === "nfm_reply" ? "📝 Form response" : "💬 Interactive reply",
              timestamp: ts,
              rawPayload: payload as Record<string, unknown>,
              ...(replyToExternalId ? { replyToExternalId } : {}),
            } satisfies NormalizedInboundMessage);
            continue;
          }

          // Template quick-reply tap: a customer tapped a QUICK_REPLY button on
          // an approved template we sent. Arrives as `type:"button"` with
          // `button.payload` = the author-assigned id + `button.text` = the label.
          // Without this branch it fell through to the "unsupported message"
          // placeholder — losing the payload the ask_question step routes on.
          // Emit a structured button_reply, parity with interactive replies.
          if (m.type === "button") {
            const payloadId = m.button?.payload;
            const title = m.button?.text ?? "";
            if (!payloadId) continue;
            events.push({
              kind: "message",
              externalId,
              ...identity,
              contactName,
              body: title,
              interactiveReply: { kind: "button_reply", id: payloadId, title },
              timestamp: ts,
              rawPayload: payload as Record<string, unknown>,
              ...(replyToExternalId ? { replyToExternalId } : {}),
            } satisfies NormalizedInboundMessage);
            continue;
          }

          // Inbound emoji reactions (m.type === "reaction", payload
          // `m.reaction = { message_id, emoji }`). The customer reacted to one
          // of our messages; `message_id` is that message's wamid and `emoji`
          // is the reaction (empty string ⇒ reaction REMOVED). Ingest resolves
          // the target by wamid and patches its `reaction` column. We never
          // create a Message row for the reaction itself.
          if (m.type === "reaction") {
            const targetExternalId = m.reaction?.message_id;
            if (!targetExternalId) continue;
            const rawEmoji = m.reaction?.emoji;
            events.push({
              kind: "reaction",
              externalId,
              targetExternalId,
              emoji: rawEmoji && rawEmoji.length > 0 ? rawEmoji : null,
              contactPhone: phone,
              timestamp: ts,
              rawPayload: payload as Record<string, unknown>,
            } satisfies NormalizedReaction);
            continue;
          }

          // Media: image / video / audio / document / sticker. Each has its
          // own subobject with id, mime_type, optional caption + filename.
          const mediaKind = m.type as MediaKind | undefined;
          if (!mediaKind || !META_MEDIA_TYPES.includes(mediaKind)) {
            // Non-media, non-text, non-interactive customer content: location
            // pins, contact cards, orders, and Meta's `unsupported` fallback.
            // Ingest as a text placeholder so unread / 24h-window / list preview
            // stay correct and the raw payload is preserved (the webhook returns
            // 200, so Meta never redelivers — dropping these loses them forever).
            const placeholder = placeholderForUnhandledType(m);
            if (!placeholder) continue;
            // Location pins + contact cards additionally carry structured data
            // for a dedicated bubble (map pin / vCard). The placeholder body
            // stays for search / list preview / unread.
            const structured = structuredForMessage(m);
            events.push({
              kind: "message",
              externalId,
              ...identity,
              contactName,
              body: placeholder,
              ...(structured ? { structured } : {}),
              ...attributionSpread,
              timestamp: ts,
              rawPayload: payload as Record<string, unknown>,
              ...(replyToExternalId ? { replyToExternalId } : {}),
            } satisfies NormalizedInboundMessage);
            continue;
          }
          const mediaPayload = m[mediaKind] as MetaMediaPayload | undefined;
          if (!mediaPayload?.id || !mediaPayload.mime_type) continue;

          const media: NormalizedMediaRef = {
            kind: mediaKind,
            externalMediaId: mediaPayload.id,
            mimeType: mediaPayload.mime_type,
            ...(mediaPayload.filename ? { filename: mediaPayload.filename } : {}),
            ...(mediaPayload.duration
              ? { durationMs: mediaPayload.duration * 1000 }
              : {}),
            // WhatsApp voice notes arrive as audio with `voice: true` — flag it
            // so the bubble shows the mic / "Voice message" affordance instead
            // of the generic audio-file player.
            ...(mediaKind === "audio" && mediaPayload.voice ? { voice: true } : {}),
          };

          events.push({
            kind: "message",
            externalId,
            ...identity,
            contactName,
            // Caption goes into body so search + previews stay uniform.
            body: mediaPayload.caption ?? "",
            media,
            ...attributionSpread,
            timestamp: ts,
            rawPayload: payload as Record<string, unknown>,
            ...(replyToExternalId ? { replyToExternalId } : {}),
          } satisfies NormalizedInboundMessage);
        }

        for (const c of Array.isArray(value.calls) ? value.calls : []) {
          const evt = parseMetaCall(
            c,
            payload as Record<string, unknown>,
            Array.isArray(value.contacts) ? value.contacts : [],
            // Sits alongside `calls[]` on a FAILED terminate and is the only
            // place Meta says WHY the call failed.
            Array.isArray(value.errors) ? value.errors : undefined,
          );
          if (!evt) continue;
          events.push(evt);
        }

        for (const s of Array.isArray(value.statuses) ? value.statuses : []) {
          // `statuses[]` is overloaded: `type: "call"` rows are CALL progress
          // (RINGING/ACCEPTED/REJECTED), everything else is message delivery.
          // Routing the whole array into the message-status path below silently
          // dropped every call status, including `ACCEPTED` — the one
          // authoritative "the customer picked up" signal Meta sends.
          if (s.type === "call") {
            const callEvt = parseMetaCallStatus(
              s,
              payload as Record<string, unknown>,
            );
            if (callEvt) events.push(callEvt);
            continue;
          }
          const status = mapMetaStatus(s.status);
          // Surface WHY Meta failed delivery — otherwise a `failed` status is a
          // silent red icon with no reason. These are the (#13xxxx) codes from
          // Meta's status webhook (rate/quality limits, undeliverable, etc.).
          // First error wins for the persisted reason (Meta sends one per status
          // in practice); we still log every error for forensics.
          let errorCode: number | undefined;
          let errorTitle: string | undefined;
          let errorDetail: string | undefined;
          if (status === "failed" && s.errors?.length) {
            for (const e of s.errors) {
              console.error(
                `[meta] message ${s.id} delivery FAILED: (#${e.code ?? "?"}) ${
                  e.title ?? ""
                } — ${e.error_data?.details ?? e.message ?? "no detail"}`,
              );
            }
            const first = s.errors[0];
            if (typeof first?.code === "number") errorCode = first.code;
            if (first?.title) errorTitle = first.title;
            // Prefer the actionable error_data.details, fall back to message.
            const detail = first?.error_data?.details ?? first?.message;
            if (detail) errorDetail = detail;
          }
          if (!status || !s.id) continue;
          const tsSecs = s.timestamp ? Number(s.timestamp) : NaN;
          const ts = Number.isFinite(tsSecs) ? new Date(tsSecs * 1000) : new Date();
          const evt: NormalizedStatusUpdate = {
            kind: "status",
            externalId: s.id,
            status,
            ...(errorCode !== undefined ? { errorCode } : {}),
            ...(errorTitle !== undefined ? { errorTitle } : {}),
            ...(errorDetail !== undefined ? { errorDetail } : {}),
            // Billing metadata, when Meta attached it (normally on `sent`).
            // Narrow, named shape rather than the raw Meta object: the provider
            // layer's job is to translate wire shapes, and NormalizedStatusUpdate
            // is a cross-channel contract that must not grow WhatsApp blobs.
            ...(s.pricing
              ? {
                  pricing: {
                    ...(typeof s.pricing.billable === "boolean"
                      ? { billable: s.pricing.billable }
                      : {}),
                    ...(s.pricing.category ? { category: s.pricing.category } : {}),
                    ...(s.pricing.pricing_model ? { model: s.pricing.pricing_model } : {}),
                  },
                }
              : {}),
            timestamp: ts,
            rawPayload: payload as Record<string, unknown>,
          };
          events.push(evt);
        }
      }
    }

    return events;
  },

  async sendText(args: SendTextArgs, config: MetaSendConfig): Promise<SendTextResult> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/messages`;
    // No `retry:` — customer-visible /messages sends are NON-idempotent (Meta
    // assigns the wamid, there's no client idempotency key), so a metaFetch
    // 5xx/timeout retry could deliver the same message twice. The worker-level
    // OutboundSendAttempt guard owns the retry/refuse decision (it classifies
    // rate_limited / 5xx as recoverable). Same for sendInteractive/sendMedia/
    // sendTemplate below and placeCall.
    const res = await metaFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: args.to,
        type: "text",
        // `preview_url` renders a link-preview card for the first URL in the
        // body. Auto-enabled when the body contains an http(s) link (caller can
        // force it either way). Meta ignores it when there's no URL.
        text: {
          body: args.body,
          preview_url: args.previewUrl ?? /https?:\/\//i.test(args.body),
        },
        // When replying, include `context` so the customer's WhatsApp shows
        // the quote + jump-to-original behavior. Meta validates the wamid
        // is recent enough; a stale wamid returns error 131xxx.
        ...(args.replyToExternalId
          ? { context: { message_id: args.replyToExternalId } }
          : {}),
      }),
    });

    if (!res.ok) {
      // Surface Meta's error body so 24h-window failures (code 131047) and
      // similar policy errors land in our logs verbatim. Caller decides how
      // to render this to the agent.
      const text = await safeMetaText(res);
      throw new MetaSendError(`meta sendText failed: ${res.status} ${text}`, res.status, text);
    }

    const json = (await res.json()) as {
      messages?: Array<{ id?: string }>;
    };
    const externalId = json.messages?.[0]?.id;
    if (!externalId) {
      throw new Error(`meta sendText response missing message id: ${JSON.stringify(json)}`);
    }

    // Meta's response doesn't include a server timestamp; we stamp at send.
    return { externalId, timestamp: new Date() };
  },

  async sendInteractive(
    args: SendInteractiveArgs,
    config: MetaSendConfig,
  ): Promise<SendTextResult> {
    // A call button has no options — it's a single CTA that dials us — so it
    // takes its own short path before the option-count checks below.
    if (args.kind === "voice_call") {
      return sendVoiceCallButton(args, config);
    }

    // Pre-flight option-count check. Meta rejects with a cryptic 132xxx
    // error for "wrong option count"; failing fast with a clear message
    // saves the admin a debugging round-trip.
    if (args.options.length === 0) {
      throw new MetaSendError("sendInteractive: at least one option required", 400, "");
    }
    if (args.kind === "buttons" && args.options.length > 3) {
      throw new MetaSendError(
        "sendInteractive: WhatsApp buttons cap at 3 options — use kind=list for more",
        400,
        "",
      );
    }
    if (args.kind === "list" && args.options.length > 10) {
      throw new MetaSendError("sendInteractive: WhatsApp lists cap at 10 rows", 400, "");
    }

    // Build the interactive payload. Buttons + list share the outer
    // shape; only `interactive.type` + `action` differ.
    const interactive =
      args.kind === "buttons"
        ? {
            type: "button" as const,
            body: { text: args.bodyText },
            action: {
              buttons: args.options.map((o) => ({
                type: "reply" as const,
                reply: {
                  // Meta caps button title length at 20 chars + id length at
                  // 256. We rely on the caller / UI to enforce; truncate
                  // defensively to keep a stray long title from causing a
                  // 400 (which would surface in the workflow run as a
                  // generic "send failed").
                  id: o.id.slice(0, 256),
                  title: o.title.slice(0, 20),
                },
              })),
            },
          }
        : {
            type: "list" as const,
            body: { text: args.bodyText },
            action: {
              button: (args.listCtaLabel ?? "Choose").slice(0, 20),
              sections: [
                {
                  title: (args.listSectionTitle ?? "Options").slice(0, 24),
                  rows: args.options.map((o) => ({
                    // Meta caps a list-row id at 256 chars (same as buttons) —
                    // NOT 200. Truncating at 200 silently corrupted a >200-char
                    // id, so the `list_reply.id` didn't match on reply and
                    // workflow routing (ask_question) fell through.
                    id: o.id.slice(0, 256),
                    // List rows: title cap 24, description cap 72.
                    title: o.title.slice(0, 24),
                    ...(o.description
                      ? { description: o.description.slice(0, 72) }
                      : {}),
                  })),
                },
              ],
            },
          };

    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/messages`;
    const res = await metaFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: args.to,
        type: "interactive",
        interactive,
        ...(args.replyToExternalId
          ? { context: { message_id: args.replyToExternalId } }
          : {}),
      }),
    });

    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta sendInteractive failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }

    const json = (await res.json()) as { messages?: Array<{ id?: string }> };
    const externalId = json.messages?.[0]?.id;
    if (!externalId) {
      throw new Error(`meta sendInteractive response missing message id: ${JSON.stringify(json)}`);
    }
    return { externalId, timestamp: new Date() };
  },

  async sendLocation(args: SendLocationArgs, config: MetaSendConfig): Promise<SendTextResult> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/messages`;
    const res = await metaFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: args.to,
        type: "location",
        location: {
          latitude: args.latitude,
          longitude: args.longitude,
          ...(args.name ? { name: args.name } : {}),
          ...(args.address ? { address: args.address } : {}),
        },
        ...(args.replyToExternalId
          ? { context: { message_id: args.replyToExternalId } }
          : {}),
      }),
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(`meta sendLocation failed: ${res.status} ${text}`, res.status, text);
    }
    const json = (await res.json()) as { messages?: Array<{ id?: string }> };
    const externalId = json.messages?.[0]?.id;
    if (!externalId) {
      throw new Error(`meta sendLocation response missing message id: ${JSON.stringify(json)}`);
    }
    return { externalId, timestamp: new Date() };
  },

  async sendContacts(args: SendContactsArgs, config: MetaSendConfig): Promise<SendTextResult> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/messages`;
    // Map our vCard shape → Meta's `contacts` wire shape. Meta requires
    // `name.formatted_name` + at least one of first/last, so seed first_name
    // from the display name. Our addresses are pre-joined human lines, so they
    // go in the `street` slot (Meta renders them fine).
    const contacts = args.contacts.map((c) => {
      const [first = c.name, ...rest] = c.name.trim().split(/\s+/);
      const last = rest.join(" ");
      return {
        name: {
          formatted_name: c.name || "Contact",
          first_name: first || c.name || "Contact",
          ...(last ? { last_name: last } : {}),
        },
        ...(c.phones.length
          ? {
              // Our contacts store the number as digits (the wa_id shape). Send
              // `phone` in display E.164 (leading "+") so the customer sees the
              // full international number, and set `wa_id` (digits) so the card
              // gets working "Message" + "Save contact" buttons on WhatsApp
              // (without wa_id Meta shows only "Invite to WhatsApp").
              phones: c.phones.map((raw) => {
                const digits = raw.replace(/\D/g, "");
                return {
                  phone: digits ? `+${digits}` : raw,
                  type: "CELL",
                  ...(digits.length >= 8 ? { wa_id: digits } : {}),
                };
              }),
            }
          : {}),
        ...(c.emails?.length
          ? { emails: c.emails.map((email) => ({ email, type: "WORK" })) }
          : {}),
        ...(c.addresses?.length
          ? { addresses: c.addresses.map((street) => ({ street, type: "HOME" })) }
          : {}),
        ...(c.company ? { org: { company: c.company } } : {}),
      };
    });
    const res = await metaFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: args.to,
        type: "contacts",
        contacts,
        ...(args.replyToExternalId
          ? { context: { message_id: args.replyToExternalId } }
          : {}),
      }),
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(`meta sendContacts failed: ${res.status} ${text}`, res.status, text);
    }
    const json = (await res.json()) as { messages?: Array<{ id?: string }> };
    const externalId = json.messages?.[0]?.id;
    if (!externalId) {
      throw new Error(`meta sendContacts response missing message id: ${JSON.stringify(json)}`);
    }
    return { externalId, timestamp: new Date() };
  },

  async sendReaction(args: SendReactionArgs, config: MetaSendConfig): Promise<SendTextResult> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/messages`;
    const res = await metaFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: args.to,
        type: "reaction",
        // Meta's convention: an empty emoji removes the business's reaction.
        reaction: { message_id: args.messageExternalId, emoji: args.emoji },
      }),
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(`meta sendReaction failed: ${res.status} ${text}`, res.status, text);
    }
    const json = (await res.json()) as { messages?: Array<{ id?: string }> };
    const externalId = json.messages?.[0]?.id;
    // A reaction send returns a message id; we don't persist a new row for it
    // (it mutates the target message), but keep the shape uniform.
    return { externalId: externalId ?? `reaction:${args.messageExternalId}`, timestamp: new Date() };
  },

  async sendTypingIndicator(
    externalId: string,
    config: MetaSendConfig,
    _recipientId?: string,
    active: boolean = true,
  ): Promise<void> {
    // WhatsApp has NO "stop typing" — the indicator only auto-expires — so a
    // `typing_off` request (active:false) is a no-op here.
    if (!active) return;
    // Meta bundles the typing bubble onto the read-receipt endpoint: the call
    // marks `externalId` as read AND shows the customer a typing indicator
    // for up to 25 seconds. The indicator auto-dismisses when the next
    // outbound message lands or the timer expires — there is no explicit
    // "stop typing" endpoint. Caller is responsible for refreshing every
    // ~20s while the agent keeps typing.
    //
    // Constraint: requires a recent inbound to anchor on. Outside the 24h
    // window (no recent inbound), Meta rejects with policy errors — we
    // swallow them since the agent's local UX shouldn't degrade.
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/messages`;
    // Idempotent best-effort — keep the transient-blip retry.
    const res = await metaFetch(url, {
      method: "POST",
      retry: true,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: externalId,
        typing_indicator: { type: "text" },
      }),
    });

    if (!res.ok) {
      const body = await safeMetaText(res);
      console.warn(
        `[meta] sendTypingIndicator failed for ${externalId}: ${res.status} ${body}`,
      );
    }
  },

  async markIncomingRead(externalId: string, config: MetaSendConfig): Promise<void> {
    // Meta's read-receipt endpoint reuses the messages POST shape with
    // status: "read" — marking the latest wamid as read implicitly marks
    // every earlier inbound from that conversation as read on the customer's
    // device, so one call per agent-view is enough.
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/messages`;
    // Idempotent read-receipt — marking a wamid read twice is a no-op, so the
    // transient-blip retry stays enabled.
    const res = await metaFetch(url, {
      method: "POST",
      retry: true,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: externalId,
      }),
    });

    if (!res.ok) {
      // Non-fatal: log but don't throw. Common cause is a wamid older than
      // the 7-day window Meta accepts for read receipts.
      const body = await safeMetaText(res);
      console.warn(
        `[meta] markIncomingRead failed for ${externalId}: ${res.status} ${body}`,
      );
    }
  },

  // -------------------------------------------------------------------------
  // Media: fetch (inbound), upload (outbound staging), send (outbound).
  // -------------------------------------------------------------------------

  async fetchMedia(
    externalMediaId: string,
    config: MetaSendConfig,
    maxBytes?: number,
  ): Promise<FetchedMedia> {
    // Step 1: GET /{media-id} → { url, mime_type, ... }. The signed URL is
    // valid for ~5 minutes — we MUST hit it immediately. Don't store it.
    const metaUrl = `${GRAPH_BASE}/${config.graphVersion}/${encodeURIComponent(externalMediaId)}`;
    // GET — idempotent; keep the transient-blip retry (this runs on the webhook
    // hot path where a Meta CDN hiccup shouldn't drop an inbound attachment).
    const metaRes = await metaFetch(metaUrl, {
      retry: true,
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (!metaRes.ok) {
      const t = await metaRes.text();
      throw new MetaSendError(
        `meta media metadata failed: ${metaRes.status} ${t}`,
        metaRes.status,
        t,
      );
    }
    const meta = (await metaRes.json()) as { url?: string; mime_type?: string };
    if (!meta.url || !meta.mime_type) {
      throw new Error("meta media metadata missing url or mime_type");
    }

    // Step 2: download the binary. Meta's CDN ALSO requires the bearer token
    // — undocumented gotcha, requests without it 401. GET — idempotent, retry on.
    const binRes = await metaFetch(meta.url, {
      retry: true,
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (!binRes.ok) {
      const t = await binRes.text().catch(() => "");
      throw new MetaSendError(
        `meta media download failed: ${binRes.status} ${t}`,
        binRes.status,
        t,
      );
    }
    // minor#3: reject via Content-Length BEFORE buffering the whole binary into
    // heap. A 4-wide inbound batch each buffering up to ~100MB could transiently
    // spike ~400MB of api heap before the caller's post-buffer cap fired. The
    // caller still enforces the authoritative per-kind cap on the returned bytes
    // (a CDN can omit/understate Content-Length), so this is purely a RAM guard.
    if (maxBytes !== undefined) {
      const lenHeader = binRes.headers.get("content-length");
      const declared = lenHeader ? Number.parseInt(lenHeader, 10) : NaN;
      if (Number.isFinite(declared) && declared > maxBytes) {
        // Drain the unread body so the connection is released, then bail.
        await binRes.body?.cancel().catch(() => undefined);
        throw new MediaTooLargeError(declared, maxBytes);
      }
    }
    const ab = await binRes.arrayBuffer();
    return { bytes: new Uint8Array(ab), mimeType: meta.mime_type };
  },

  async uploadMedia(
    args: UploadMediaArgs,
    config: MetaSendConfig,
  ): Promise<UploadMediaResult> {
    // Multipart upload to /{phone-number-id}/media. Meta returns an id valid
    // for ~30 days, single-use per outbound message.
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/media`;
    const fd = new FormData();
    fd.append("messaging_product", "whatsapp");
    // Meta requires the type field — using the mime type works. The wire
    // format of the file part is what Meta dispatches the right validators on.
    fd.append("type", args.mimeType);
    // Hand the Uint8Array straight to Blob. Node 20+'s undici-backed Blob
    // accepts Uint8Array as a BlobPart at runtime — the prior `new
    // ArrayBuffer(len) + .set(bytes)` dance doubled peak RAM (one copy of
    // the bytes + the ArrayBuffer + the Blob internal). For a 100MB
    // document upload that doubled-copy was a measurable OOM risk on the
    // 4GB heap. The cast is needed because TS's BlobPart type narrows to
    // `Uint8Array<ArrayBuffer>` (excluding SharedArrayBuffer); our bytes
    // always come from `file.arrayBuffer()` or `fetch().arrayBuffer()`,
    // both of which return ArrayBuffer-backed Uint8Arrays.
    fd.append(
      "file",
      new Blob([args.bytes as Uint8Array<ArrayBuffer>], { type: args.mimeType }),
      args.filename,
    );

    // Staging upload — produces a single-use media id with no customer-visible
    // effect, so a retried 5xx blip is safe (worst case: one orphaned media id
    // that Meta expires in ~30 days). Keep the retry.
    const res = await metaFetch(url, {
      method: "POST",
      retry: true,
      headers: { authorization: `Bearer ${config.accessToken}` },
      body: fd,
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta media upload failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
    const json = (await res.json()) as { id?: string };
    if (!json.id) {
      throw new Error(`meta media upload missing id: ${JSON.stringify(json)}`);
    }
    return { mediaId: json.id };
  },

  async sendMedia(args: SendMediaArgs, config: MetaSendConfig): Promise<SendTextResult> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/messages`;
    // Build the type-specific subobject. Caption is only accepted INLINE on
    // image/video/document; sticker + audio reject it (Meta returns 100), so for
    // those a caption is delivered as a follow-up text after the media (below).
    const captionInline =
      args.kind === "image" || args.kind === "video" || args.kind === "document";
    const sub: Record<string, unknown> = { id: args.mediaId };
    if (args.caption && captionInline) {
      sub.caption = args.caption;
    }
    if (args.kind === "document" && args.filename) {
      sub.filename = args.filename;
    }
    // Audio voice-note flag — renders with the WhatsApp waveform UI on the
    // recipient's side. Meta-side flag, not a separate payload type.
    if (args.kind === "audio" && args.voice) {
      sub.voice = true;
    }

    const res = await metaFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: args.to,
        type: args.kind,
        [args.kind]: sub,
        ...(args.replyToExternalId
          ? { context: { message_id: args.replyToExternalId } }
          : {}),
      }),
    });

    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta sendMedia failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }

    const json = (await res.json()) as { messages?: Array<{ id?: string }> };
    const externalId = json.messages?.[0]?.id;
    if (!externalId) {
      throw new Error(`meta sendMedia response missing id: ${JSON.stringify(json)}`);
    }

    // Audio / sticker can't carry an inline caption (Meta rejects it), so a
    // caption is NOT sent with them — the media goes on its own. The send layer
    // only passes a caption for kinds that inline it, and the composer sends
    // such a file alone, so nothing is silently dropped here.
    return { externalId, timestamp: new Date() };
  },

  // -------------------------------------------------------------------------
  // Templates: list approved templates + send a parameterized one.
  //
  // Meta's templates live at the WhatsApp Business Account level — not the
  // phone number. That's why fetchTemplates requires wabaId in config; if it
  // hasn't been pasted yet we throw a typed error so the route can render a
  // helpful "add your WABA id in settings" message instead of a 500.
  // -------------------------------------------------------------------------

  async fetchTemplates(config: MetaSendConfig): Promise<ProviderTemplate[]> {
    if (!config.wabaId) {
      throw new MissingWabaIdError();
    }

    // Page through the catalog. Meta's default page size is 25; we crank it
    // up because most teams have <100 templates total and one round-trip is
    // strictly better than three.
    const url = new URL(
      `${GRAPH_BASE}/${config.graphVersion}/${encodeURIComponent(config.wabaId)}/message_templates`,
    );
    // `parameter_format` tells us NAMED vs POSITIONAL authoritatively. Without it
    // we were inferring it from a regex over the body text, which is a guess: a
    // POSITIONAL template whose body happens to contain `{{order_id}}` as
    // literal text would be misread, and the wire assembly would then send the
    // wrong parameter shape and 132000 every recipient.
    url.searchParams.set(
      "fields",
      "name,language,status,category,components,id,parameter_format",
    );
    url.searchParams.set("limit", "200");

    const results: ProviderTemplate[] = [];
    let next: string | null = url.toString();
    // Hard cap on follow-up pages: if a team has > 1000 templates something's
    // wrong upstream, and pagination loops are the easy way to hang a server.
    let pages = 0;

    while (next && pages < 5) {
      pages += 1;
      // GET — idempotent; keep the transient-blip retry.
      const res = await metaFetch(next, {
        retry: true,
        headers: { authorization: `Bearer ${config.accessToken}` },
      });
      if (!res.ok) {
        const text = await safeMetaText(res);
        throw new MetaSendError(
          `meta fetchTemplates failed: ${res.status} ${text}`,
          res.status,
          text,
        );
      }
      const json = (await res.json()) as {
        data?: Array<MetaTemplateRow>;
        paging?: { next?: string };
      };
      for (const row of json.data ?? []) {
        const t = normalizeMetaTemplate(row);
        if (t) results.push(t);
      }
      next = json.paging?.next ?? null;
    }

    return results;
  },

  async createTemplate(
    args: CreateTemplateArgs,
    config: MetaSendConfig,
  ): Promise<CreateTemplateResult> {
    if (!config.wabaId) throw new MissingWabaIdError();

    const url = `${GRAPH_BASE}/${config.graphVersion}/${encodeURIComponent(config.wabaId)}/message_templates`;
    const res = await metaFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        name: args.name,
        language: args.language,
        category: args.category.toUpperCase(),
        components: args.components,
      }),
    });

    if (!res.ok) {
      // Meta's create endpoint is the noisiest one in the API — it rejects
      // for missing examples, duplicate names, policy issues, and per-
      // component validation failures. Surfacing the body verbatim is the
      // only way the UI can show useful error messages.
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta createTemplate failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }

    const json = (await res.json()) as { id?: string; status?: string };
    if (!json.id) {
      throw new Error(`meta createTemplate response missing id: ${JSON.stringify(json)}`);
    }
    const status = mapTemplateStatus(json.status) ?? "pending";
    return { externalId: json.id, status };
  },

  async deleteTemplate(args: DeleteTemplateArgs, config: MetaSendConfig): Promise<void> {
    if (!config.wabaId) throw new MissingWabaIdError();

    // Without `hsm_id`, Meta deletes ALL language variants under `name`.
    // We pass it when we have it so deleting one language leaves the others.
    const url = new URL(
      `${GRAPH_BASE}/${config.graphVersion}/${encodeURIComponent(config.wabaId)}/message_templates`,
    );
    url.searchParams.set("name", args.name);
    if (args.externalId) url.searchParams.set("hsm_id", args.externalId);

    // DELETE is idempotent (a repeat 404 is treated as success below), so the
    // transient-blip retry stays on.
    const res = await metaFetch(url, {
      method: "DELETE",
      retry: true,
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      // A 404 from Meta means the template is already gone — treat as success
      // so a stale local row that we're cleaning up doesn't keep failing.
      if (res.status === 404) return;
      throw new MetaSendError(
        `meta deleteTemplate failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
  },

  /**
   * Switch on WABA-level template analytics.
   *
   * IRREVERSIBLE at Meta — there is no `false`. Free to enable and free to
   * query; the only cost is that it cannot be undone, which is why the domain
   * layer gates it behind an explicit admin confirmation and never fires it
   * from a read path.
   */
  async enableTemplateInsights(config: MetaSendConfig): Promise<void> {
    if (!config.wabaId) throw new MissingWabaIdError();
    const url = new URL(
      `${GRAPH_BASE}/${config.graphVersion}/${encodeURIComponent(config.wabaId)}`,
    );
    url.searchParams.set("is_enabled_for_insights", "true");
    // No retry: a POST that flips an irreversible flag must not be replayed on
    // an ambiguous timeout. The caller re-checks state instead.
    const res = await metaFetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta enableTemplateInsights failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
  },

  /**
   * Read Meta's own per-template daily analytics.
   *
   * Wire shape (nested field expansion on the WABA node):
   *   /{WABA}?fields=template_analytics.start(..).end(..).granularity(DAILY)
   *           .metric_types([SENT,DELIVERED,READ,CLICKED,COST])
   *           .template_ids([..])
   *
   * Two Meta constraints the caller must respect and this method enforces:
   * at most 10 template ids per request, and a 90-day lookback. Timestamps are
   * UNIX SECONDS, not milliseconds — passing ms silently returns an empty set
   * rather than an error, which reads as "no data" forever.
   */
  async fetchTemplateAnalytics(
    args: TemplateAnalyticsArgs,
    config: MetaSendConfig,
  ): Promise<ProviderTemplateAnalyticsRow[]> {
    if (!config.wabaId) throw new MissingWabaIdError();
    const ids = args.templateExternalIds.slice(0, 10);
    if (ids.length === 0) return [];

    const startSec = Math.floor(args.start.getTime() / 1000);
    const endSec = Math.floor(args.end.getTime() / 1000);
    const field =
      `template_analytics.start(${startSec}).end(${endSec}).granularity(DAILY)` +
      `.metric_types(["SENT","DELIVERED","READ","CLICKED","COST"])` +
      `.template_ids([${ids.map((id: string) => JSON.stringify(id)).join(",")}])`;

    const url = new URL(
      `${GRAPH_BASE}/${config.graphVersion}/${encodeURIComponent(config.wabaId)}`,
    );
    url.searchParams.set("fields", field);

    // Idempotent read — the transient-blip retry is safe here.
    const res = await metaFetch(url, {
      method: "GET",
      retry: true,
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta fetchTemplateAnalytics failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
    const json = (await res.json()) as {
      template_analytics?: { data?: unknown } | Array<{ data_points?: unknown }>;
    };
    return parseTemplateAnalytics(json);
  },

  async uploadHeaderMedia(
    args: UploadHeaderMediaArgs,
    config: MetaSendConfig,
  ): Promise<UploadHeaderMediaResult> {
    if (!config.appId) {
      throw new MissingAppIdError();
    }

    // Step 1: create a resumable upload session. Endpoint is app-scoped, not
    // WABA-scoped — different from the per-message media upload.
    const startUrl = new URL(
      `${GRAPH_BASE}/${config.graphVersion}/${encodeURIComponent(config.appId)}/uploads`,
    );
    startUrl.searchParams.set("file_length", String(args.bytes.byteLength));
    startUrl.searchParams.set("file_type", args.mimeType);
    startUrl.searchParams.set("file_name", args.filename);
    // Token goes in the Authorization header, NOT the query string. The Graph
    // /{app-id}/uploads endpoint accepts `Authorization: Bearer`, and putting
    // the decrypted access token in the URL leaked it into logs + the 502 error
    // body whenever this call timed out (metaFetch's timeout message echoes the
    // input URL, and the 502 surfaced to any team member with templates:manage).
    const startRes = await metaFetch(startUrl, {
      method: "POST",
      // Staging upload session — no customer-visible effect, safe to retry.
      retry: true,
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (!startRes.ok) {
      const text = await startRes.text();
      throw new MetaSendError(
        `meta upload session failed: ${startRes.status} ${text}`,
        startRes.status,
        text,
      );
    }
    const startJson = (await startRes.json()) as { id?: string };
    const sessionId = startJson.id;
    if (!sessionId) {
      throw new Error(`meta upload session missing id: ${JSON.stringify(startJson)}`);
    }

    // Step 2: POST the bytes to the session. The Authorization header uses
    // `OAuth <token>` (not Bearer) for this endpoint — undocumented for a
    // long time, called out only in the resumable-upload guide.
    const uploadUrl = `${GRAPH_BASE}/${config.graphVersion}/${sessionId}`;
    const ab = new ArrayBuffer(args.bytes.byteLength);
    new Uint8Array(ab).set(args.bytes);
    const uploadRes = await metaFetch(uploadUrl, {
      method: "POST",
      // Staging upload (resumable from offset 0) — safe to retry on a blip.
      retry: true,
      headers: {
        authorization: `OAuth ${config.accessToken}`,
        file_offset: "0",
      },
      body: ab,
    });
    if (!uploadRes.ok) {
      const text = await uploadRes.text();
      throw new MetaSendError(
        `meta upload bytes failed: ${uploadRes.status} ${text}`,
        uploadRes.status,
        text,
      );
    }
    const uploadJson = (await uploadRes.json()) as { h?: string };
    if (!uploadJson.h) {
      throw new Error(`meta upload missing handle: ${JSON.stringify(uploadJson)}`);
    }
    return { headerHandle: uploadJson.h };
  },

  async sendTemplate(
    args: SendTemplateArgs,
    config: MetaSendConfig,
  ): Promise<SendTextResult> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/messages`;

    // Build the `components` array Meta expects. Each parameterized component
    // becomes one entry with `type` ("header" | "body" | "button") and a
    // `parameters` array of `{ type: "text", text }`. Empty arrays are omitted
    // entirely — sending an empty `parameters` triggers Meta error 132000.
    const components: Array<Record<string, unknown>> = [];
    // Media header (IMAGE/VIDEO/DOCUMENT) takes precedence — Meta wants the
    // parameter typed to the media kind with a `{ link }` (or `{ id }`) object,
    // NOT a text parameter. A template's header is either text OR media, never
    // both, so these two branches are mutually exclusive.
    if (args.variables.headerMedia) {
      const { kind, link, filename } = args.variables.headerMedia;
      const media: Record<string, unknown> = { link };
      if (kind === "document" && filename) media.filename = filename;
      components.push({
        type: "header",
        parameters: [{ type: kind, [kind]: media }],
      });
    } else if (args.variables.headerNamed) {
      // NAMED-format template: Meta requires `parameter_name` on the header
      // component exactly like the body, else it rejects with 132000.
      components.push({
        type: "header",
        parameters: [
          {
            type: "text",
            parameter_name: args.variables.headerNamed.name,
            text: args.variables.headerNamed.text,
          },
        ],
      });
    } else if (args.variables.header && args.variables.header.length > 0) {
      components.push({
        type: "header",
        parameters: [{ type: "text", text: args.variables.header }],
      });
    }
    // Body params. Named format (`parameter_format: NAMED`, `{{order_id}}`)
    // takes precedence when the caller supplied `bodyNamed`; otherwise the
    // positional `{{1}}, {{2}}, …` array. Empty in both cases → no body entry.
    if (args.variables.bodyNamed && args.variables.bodyNamed.length > 0) {
      components.push({
        type: "body",
        parameters: args.variables.bodyNamed.map(({ name, text }) => ({
          type: "text",
          parameter_name: name,
          text,
        })),
      });
    } else if (args.variables.body.length > 0) {
      components.push({
        type: "body",
        parameters: args.variables.body.map((text) => ({ type: "text", text })),
      });
    }
    // Dynamic buttons (URL suffix / copy-code / quick-reply payload). Each is
    // its own `button` component keyed by `sub_type` + `index`. Static buttons
    // carry no parameter and are simply not listed here.
    for (const btn of args.variables.buttons ?? []) {
      const parameter =
        btn.subType === "copy_code"
          ? { type: "coupon_code", coupon_code: btn.text }
          : btn.subType === "quick_reply"
            ? { type: "payload", payload: btn.text }
            : { type: "text", text: btn.text };
      components.push({
        type: "button",
        sub_type: btn.subType,
        index: String(btn.index),
        parameters: [parameter],
      });
    }

    const res = await metaFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: args.to,
        type: "template",
        template: {
          name: args.name,
          language: { code: args.language },
          ...(components.length > 0 ? { components } : {}),
        },
      }),
    });

    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta sendTemplate failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }

    const json = (await res.json()) as { messages?: Array<{ id?: string }> };
    const externalId = json.messages?.[0]?.id;
    if (!externalId) {
      throw new Error(
        `meta sendTemplate response missing message id: ${JSON.stringify(json)}`,
      );
    }
    return { externalId, timestamp: new Date() };
  },

  // -------------------------------------------------------------------------
  // WhatsApp Business Calling
  //
  // Every method shares the `metaFetch` helper (timeout + transient-5xx retry)
  // and the same `Bearer ${accessToken}` pattern as the messaging sends.
  //
  // Two shapes live here, and conflating them was the original sin of this
  // file. CALL SIGNALING is `POST /{phoneNumberId}/calls` with an `action`
  // discriminator (connect / pre_accept / accept / reject / terminate).
  // PERMISSION is not a calling endpoint at all — requesting it is an ordinary
  // interactive MESSAGE, and reading it is `GET /{phoneNumberId}/call_permissions`.
  // There is no `/call_permission_requests` edge; an earlier version invented
  // one, so no permission request ever reached a customer.
  //
  // Send only documented body fields. Graph rejects unknown parameters with
  // `(#100) Invalid parameter`, which turns a stray field into a total request
  // failure rather than a harmless no-op.
  // -------------------------------------------------------------------------

  /**
   * Ask the customer for permission to call them.
   *
   * This is a `type: "interactive"` message on the normal messages endpoint,
   * NOT a calling endpoint — it is billed like any other message and its
   * delivery is reported by the ordinary message-status webhook. Meta renders
   * the Allow/Deny prompt itself; only `body.text` is ours to write.
   *
   * The returned id is the request MESSAGE's wamid, which the customer's
   * `call_permission_reply` webhook echoes back in `context.id`. Persisting it
   * is what lets a grant be matched to the exact request that produced it.
   */
  async sendCallPermissionRequest(
    args: { to?: string; recipient?: string; bodyText?: string },
    config: MetaSendConfig,
  ): Promise<{ permissionRequestId: string; expiresAt: Date }> {
    if (!args.to && !args.recipient) {
      throw new Error(
        "meta sendCallPermissionRequest needs a phone number or a BSUID",
      );
    }
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/messages`;
    const res = await metaFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        // `to` takes precedence when both are present (Meta's rule); we send
        // whichever identity the contact actually has. A cold caller Meta
        // hasn't seen in 30 days has only a BSUID.
        ...(args.to ? { to: args.to } : {}),
        ...(args.recipient ? { recipient: args.recipient } : {}),
        type: "interactive",
        interactive: {
          type: "call_permission_request",
          action: { name: "call_permission_request" },
          // Body is optional per Meta, but a bare permission prompt with no
          // context reads as a scam to the customer. Callers always pass one.
          ...(args.bodyText ? { body: { text: args.bodyText } } : {}),
        },
      }),
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta sendCallPermissionRequest failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
    // Message-send response shape: the id lives at messages[0].id.
    const json = (await res.json()) as {
      messages?: Array<{ id?: string }>;
    };
    const permissionRequestId = json.messages?.[0]?.id;
    if (!permissionRequestId) {
      throw new Error(
        `meta sendCallPermissionRequest missing message id: ${JSON.stringify(json)}`,
      );
    }
    // The REQUEST lapses 7 days after delivery if the customer never responds.
    // This is not a grant and must never be treated as one — the grant's own
    // expiry arrives on the reply webhook. (It also expires immediately if we
    // send a newer request, which the caller handles by only ever reading the
    // most recent row.)
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    return { permissionRequestId, expiresAt };
  },

  /**
   * Read the customer's authoritative permission state + live quota.
   *
   * Meta returns `permission.status` plus a per-action `limits[]` breakdown
   * with `can_perform_action` already computed across every window. Trusting
   * that verdict is what keeps us correct when Meta changes a cap — the
   * business-initiated call limit has moved 5 → 10 → 100 in a year, and any
   * number hardcoded here would be wrong again by the next changelog entry.
   */
  async getCallPermission(
    args: { to?: string; recipient?: string },
    config: MetaSendConfig,
  ): Promise<CallPermissionState> {
    if (!args.to && !args.recipient) {
      throw new Error("meta getCallPermission needs a phone number or a BSUID");
    }
    const query = args.to
      ? `user_wa_id=${encodeURIComponent(args.to)}`
      : `recipient=${encodeURIComponent(args.recipient!)}`;
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/call_permissions?${query}`;
    const res = await metaFetch(url, {
      method: "GET",
      // Idempotent read — safe to replay on a transient 5xx, unlike the
      // non-idempotent call/send POSTs.
      retry: true,
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta getCallPermission failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
    const json = (await res.json()) as {
      permission?: { status?: string; expiration_time?: number };
      actions?: Array<{
        action_name?: string;
        can_perform_action?: boolean;
        limits?: Array<{ limit_expiration_time?: number }>;
      }>;
    };
    const rawStatus = json.permission?.status;
    const status: CallPermissionState["status"] =
      rawStatus === "temporary" || rawStatus === "permanent"
        ? rawStatus
        : "no_permission";
    const action = (name: string) =>
      json.actions?.find((a) => a.action_name === name);
    const startCall = action("start_call");
    // Only present when the quota is actually exhausted, which is exactly when
    // we want to tell the agent how long to wait.
    const resetAt = startCall?.limits?.find((l) => l.limit_expiration_time)
      ?.limit_expiration_time;
    return {
      status,
      hasPermission: status !== "no_permission",
      // Absent action ⇒ Meta didn't say no. Fall back to the permission status
      // rather than hard-blocking on a response shape we didn't anticipate.
      canStartCall: startCall?.can_perform_action ?? status !== "no_permission",
      canRequestPermission:
        action("send_call_permission_request")?.can_perform_action ?? true,
      // Permanent permissions carry no expiration_time at all.
      expiresAt:
        status === "temporary" && json.permission?.expiration_time
          ? new Date(json.permission.expiration_time * 1000)
          : null,
      startCallResetAt: resetAt ? new Date(resetAt * 1000) : null,
    };
  },

  async placeCall(
    args: {
      to?: string;
      recipient?: string;
      sdpOffer: string;
      correlationId?: string;
    },
    config: MetaSendConfig,
  ): Promise<{ externalCallId: string }> {
    if (!args.to && !args.recipient) {
      throw new Error("meta placeCall needs a phone number or a BSUID");
    }
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/calls`;
    const res = await metaFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      // Meta's outbound-call shape requires `session.sdp_type=offer` +
      // `session.sdp=<browser RTCPeerConnection.createOffer SDP>`. Without
      // session.* the API returns 131009 "Missing session parameter".
      //
      // These are the ONLY documented fields. A `from` field used to be sent
      // here; it is not part of the contract (Meta always uses the number
      // behind phoneNumberId) and an unknown parameter can fail the request
      // outright.
      body: JSON.stringify({
        messaging_product: "whatsapp",
        ...(args.to ? { to: args.to } : {}),
        ...(args.recipient ? { recipient: args.recipient } : {}),
        action: "connect",
        session: { sdp_type: "offer", sdp: args.sdpOffer },
        // Echoed back on every status + terminate webhook for this call, so
        // ingest can match a webhook to our row directly instead of racing the
        // returned call id. Meta caps it at 512 chars; our ids are far shorter.
        ...(args.correlationId
          ? { biz_opaque_callback_data: args.correlationId }
          : {}),
      }),
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta placeCall failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
    const json = (await res.json()) as {
      calls?: Array<{ id?: string }>;
      // Some Meta variants return id at top level. Belt + suspenders.
      id?: string;
    };
    const externalCallId = json.calls?.[0]?.id ?? json.id;
    if (!externalCallId) {
      throw new Error(`meta placeCall missing call id: ${JSON.stringify(json)}`);
    }
    return { externalCallId };
  },

  async preAcceptCall(
    args: { externalCallId: string; sdpAnswer: string },
    config: MetaSendConfig,
  ): Promise<void> {
    // Meta requires `session.sdp_type=answer + session.sdp=<answer SDP>`
    // on pre_accept just like on accept — verified by Meta error 131009
    // "Missing session parameter" when the body omits session. The two
    // hops (pre_accept → accept) exist for media timing; both carry the
    // same SDP answer. Without this Meta rejects pre_accept with 400 and
    // the call never connects on the answering side.
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/calls`;
    // Idempotent: a fixed (call_id, action) re-issued is a no-op on Meta's side.
    // Keep the transient-blip retry (this is NOT the non-idempotent placeCall).
    const res = await metaFetch(url, {
      method: "POST",
      retry: true,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        call_id: args.externalCallId,
        action: "pre_accept",
        session: { sdp_type: "answer", sdp: args.sdpAnswer },
      }),
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta preAcceptCall failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
  },

  async acceptCall(
    args: { externalCallId: string; sdpAnswer: string },
    config: MetaSendConfig,
  ): Promise<void> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/calls`;
    // Idempotent (fixed call_id + action); keep the transient-blip retry.
    const res = await metaFetch(url, {
      method: "POST",
      retry: true,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        call_id: args.externalCallId,
        action: "accept",
        session: { sdp_type: "answer", sdp: args.sdpAnswer },
      }),
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta acceptCall failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
  },

  async rejectCall(
    args: { externalCallId: string },
    config: MetaSendConfig,
  ): Promise<void> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/calls`;
    // Idempotent (fixed call_id + action); keep the transient-blip retry.
    const res = await metaFetch(url, {
      method: "POST",
      retry: true,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      // call_id + action only. A `reject_reason` used to be appended here; it
      // is not in Meta's contract, and an unknown parameter can fail the whole
      // request — which would leave the customer's phone ringing after the
      // agent declined. Any reason is recorded locally instead.
      body: JSON.stringify({
        messaging_product: "whatsapp",
        call_id: args.externalCallId,
        action: "reject",
      }),
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta rejectCall failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
  },

  async endCall(
    args: { externalCallId: string },
    config: MetaSendConfig,
  ): Promise<void> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/calls`;
    // Idempotent terminate — a repeat on an already-ended call is treated as
    // success below, so the transient-blip retry is safe to keep.
    const res = await metaFetch(url, {
      method: "POST",
      retry: true,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        call_id: args.externalCallId,
        action: "terminate",
      }),
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      // 4xx on an already-terminated call: idempotent treat-as-success so
      // a duplicate hangup from the browser doesn't bubble a confusing
      // error. The Call row's terminal-state CAS already prevents the
      // local mutation; this just keeps the API response clean.
      if (res.status === 404 || /already.*(terminated|ended)/i.test(text)) return;
      throw new MetaSendError(
        `meta endCall failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
  },

  /**
   * Admin helper: enable WhatsApp Cloud API Calling on the phone number.
   *
   * Phone-number-level setting that's REQUIRED before placeCall works
   * (else Meta returns 138000 "Calling API not enabled"). Distinct from
   * the "Display call buttons" toggle in WhatsApp Manager (UI-only).
   *
   * Called once per number per team via POST /api/calls/admin/enable.
   * Safe to re-run — Meta returns success even when already enabled.
   */
  /**
   * Read the current settings on the phone number — used for diagnosing
   * which calling fields are set, what call_hours look like, whether
   * inbound is actually enabled, etc. Phase-1 admin helper.
   */
  async getPhoneNumberSettings(
    config: MetaSendConfig,
  ): Promise<{ raw: unknown }> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/settings`;
    // GET — idempotent diagnostic read, keep the retry.
    const res = await metaFetch(url, {
      retry: true,
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    const text = await safeMetaText(res);
    if (!res.ok) {
      throw new MetaSendError(
        `meta getPhoneNumberSettings failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
    let raw: unknown = text;
    try {
      raw = JSON.parse(text);
    } catch {
      // ignore
    }
    return { raw };
  },

  /**
   * Admin one-shot: turn calling on with defaults that make the number usable
   * immediately — reachable around the clock, call icon shown, and callback
   * permission on (a customer who calls us thereby lets us call them back,
   * which is the cheapest legitimate source of calling permission there is).
   *
   * An admin can narrow any of it afterwards via `updateCallSettings`.
   */
  async enableCalling(config: MetaSendConfig): Promise<{ ok: true; raw: unknown }> {
    const state = await metaProvider.updateCallSettings!(
      {
        enabled: true,
        callIconVisible: true,
        callbackPermissionEnabled: true,
        // No windows ⇒ call hours DISABLED ⇒ open 24/7.
        hours: { timezoneId: "UTC", windows: [] },
      },
      config,
    );
    return { ok: true, raw: state.raw };
  },

  /**
   * Write calling configuration. Only the fields present in `settings` are
   * sent, so this serves both the one-time enable and targeted changes later.
   */
  async updateCallSettings(
    settings: CallSettings,
    config: MetaSendConfig,
  ): Promise<CallSettingsState> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/settings`;
    const calling: Record<string, unknown> = {};
    if (settings.enabled !== undefined) {
      calling.status = settings.enabled ? "ENABLED" : "DISABLED";
    }
    if (settings.callIconVisible !== undefined) {
      calling.call_icon_visibility = settings.callIconVisible
        ? "DEFAULT"
        : "DISABLE_ALL";
    }
    if (settings.callbackPermissionEnabled !== undefined) {
      calling.callback_permission_status = settings.callbackPermissionEnabled
        ? "ENABLED"
        : "DISABLED";
    }
    if (settings.hours !== undefined) {
      // No windows ⇒ reachable around the clock, which Meta expresses as call
      // hours DISABLED ("if call hours are disabled, your business is
      // considered open all 24 hours of the day, 7 days a week"). Do NOT model
      // 24/7 as a 0000-2359 window: times are minute-granular, so that leaves
      // calls refused for the last minute of every day, and no widening closes
      // the gap.
      calling.call_hours = settings.hours.windows.length
        ? {
            status: "ENABLED",
            timezone_id: settings.hours.timezoneId,
            weekly_operating_hours: settings.hours.windows.map((w) => ({
              day_of_week: w.dayOfWeek,
              open_time: w.openTime,
              close_time: w.closeTime,
            })),
          }
        : { status: "DISABLED" };
    }
    // Idempotent settings write — Meta returns success even when the value is
    // already set, so the transient-blip retry is safe.
    const res = await metaFetch(url, {
      method: "POST",
      retry: true,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({ calling }),
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta updateCallSettings failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
    // Read back rather than echoing our own input: Meta normalizes some values,
    // and the response is where restrictions live.
    return metaProvider.getCallSettings!(config);
  },

  async getCallSettings(config: MetaSendConfig): Promise<CallSettingsState> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/settings`;
    const res = await metaFetch(url, {
      method: "GET",
      retry: true,
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    const text = await safeMetaText(res);
    if (!res.ok) {
      throw new MetaSendError(
        `meta getCallSettings failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
    let raw: unknown = text;
    try {
      raw = JSON.parse(text);
    } catch {
      // Keep the string — the caller surfaces it verbatim for diagnosis.
    }
    const calling = (raw as { calling?: MetaCallingSettings } | null)?.calling;
    const hours = calling?.call_hours;
    return {
      enabled: calling?.status === "ENABLED",
      // Absent ⇒ Meta's default, which is to show the icon.
      callIconVisible: calling?.call_icon_visibility !== "DISABLE_ALL",
      callbackPermissionEnabled:
        calling?.callback_permission_status === "ENABLED",
      // Call hours DISABLED means "open 24/7", which we model as no windows.
      hours:
        hours?.status === "ENABLED"
          ? {
              timezoneId: hours.timezone_id ?? "UTC",
              windows: (hours.weekly_operating_hours ?? []).flatMap((w) =>
                w.day_of_week && w.open_time && w.close_time
                  ? [
                      {
                        dayOfWeek: w.day_of_week as CallHoursWindow["dayOfWeek"],
                        openTime: w.open_time,
                        closeTime: w.close_time,
                      },
                    ]
                  : [],
              ),
            }
          : null,
      // A restricted number rejects every call attempt. Without surfacing this,
      // a paused tenant sees only a string of unexplained failures.
      restrictions: (calling?.restrictions?.restrictions_list ?? []).flatMap(
        (r) =>
          r.type
            ? [
                {
                  type: r.type,
                  reason: r.reason ?? "",
                  expiresAt: r.expiration ? new Date(r.expiration * 1000) : null,
                },
              ]
            : [],
      ),
      raw,
    };
  },

};

// Send-error classification moved to `meta-send-error.ts` (shared with the
// social providers). Re-exported here so every existing `@/lib/providers/meta`
// import keeps working. Imported at the top for meta.ts's own `throw`s.
export { MetaSendError, normalizeMetaSendError };
export type { MetaErrorCode, NormalizedSendError } from "./meta-send-error";

/**
 * minor#3: thrown by `fetchMedia` when the response Content-Length already
 * exceeds the caller's cap, BEFORE the binary is buffered into heap. Distinct
 * type so the caller maps it to a NON-retriable drop (re-downloading yields the
 * same over-cap bytes) instead of parking it for the sweeper to retry forever.
 */
export class MediaTooLargeError extends Error {
  readonly declaredBytes: number;
  readonly maxBytes: number;
  constructor(declaredBytes: number, maxBytes: number) {
    super(`inbound media over cap before download: ${declaredBytes} > ${maxBytes}`);
    this.name = "MediaTooLargeError";
    this.declaredBytes = declaredBytes;
    this.maxBytes = maxBytes;
  }
}

/**
 * Thrown by fetchTemplates when the team hasn't pasted a WABA id yet. The
 * templates route catches this and returns a 409 + actionable message
 * pointing the admin at /settings/whatsapp.
 */
export class MissingWabaIdError extends Error {
  constructor() {
    super("WhatsApp Business Account id is not configured for this team");
    this.name = "MissingWabaIdError";
  }
}

/**
 * Thrown by `uploadHeaderMedia` when the team hasn't pasted a Meta App ID
 * yet. The /templates create route catches this and asks the admin to add it
 * in /settings/whatsapp — same pattern as MissingWabaIdError.
 */
export class MissingAppIdError extends Error {
  constructor() {
    super("Meta App ID is not configured for this team");
    this.name = "MissingAppIdError";
  }
}

// ---------------------------------------------------------------------------
// Template helpers — keep wire-shape parsing local to this file so the
// provider interface stays Meta-agnostic.
// ---------------------------------------------------------------------------

interface MetaTemplateRow {
  id?: string;
  name?: string;
  language?: string;
  status?: string;
  category?: string;
  components?: TemplateComponent[];
  /** Meta's own answer: "POSITIONAL" | "NAMED". Absent on old rows. */
  parameter_format?: string;
}

function normalizeMetaTemplate(row: MetaTemplateRow): ProviderTemplate | null {
  if (!row.name || !row.language) return null;
  const status = mapTemplateStatus(row.status);
  const category = mapTemplateCategory(row.category);
  if (!status || !category) return null;
  const components = Array.isArray(row.components) ? row.components : [];
  const body = components.find((c) => c.type === "BODY");
  return {
    name: row.name,
    language: row.language,
    status,
    category,
    bodyText: body?.text ?? "",
    components,
    // Default POSITIONAL when Meta omits it: that is the historical default and
    // the shape every pre-existing row was synced under, so an omitted field
    // can't silently flip a working template to the named wire format.
    parameterFormat: (row.parameter_format ?? "").toUpperCase() === "NAMED" ? "named" : "positional",
    ...(row.id ? { externalId: row.id } : {}),
  };
}

function mapTemplateStatus(s: string | undefined): TemplateStatus | null {
  switch ((s ?? "").toUpperCase()) {
    // REINSTATED = Meta re-enabled a previously disabled/paused/flagged template;
    // it "can be sent again" (doc). Without it the row stays locally un-sendable
    // and broadcasts keep skipping it until a manual Sync.
    case "APPROVED":
    case "REINSTATED":
      return "approved";
    case "PENDING":
    case "IN_APPEAL":
    case "PENDING_DELETION":
      return "pending";
    case "REJECTED":
      return "rejected";
    // A FLAGGED template can't be sent — treat like paused so it's not offered.
    case "PAUSED":
    case "FLAGGED":
      return "paused";
    // ARCHIVED templates are scheduled for deletion and can't be sent — mark them
    // non-sendable rather than leaving a stale "approved".
    case "DISABLED":
    case "DELETED":
    case "ARCHIVED":
      return "disabled";
    default:
      return null;
  }
}

function mapTemplateCategory(c: string | undefined): TemplateCategory | null {
  switch ((c ?? "").toUpperCase()) {
    case "MARKETING":
      return "marketing";
    case "UTILITY":
    case "TRANSACTIONAL":
      return "utility";
    case "AUTHENTICATION":
      return "authentication";
    default:
      return null;
  }
}

// Template placeholder rendering/counting moved to @ccp/shared so the client
// optimistic preview can't drift from the server-stored body. Re-exported here
// so existing `@/lib/providers/meta` import sites keep working.
export {
  countTemplatePlaceholders,
  renderTemplateBody,
} from "@ccp/shared/template-render";

/**
 * Parse Meta's `template_analytics` response into flat template-day rows.
 *
 * The shape is awkward and has moved: the payload is sometimes
 * `{ template_analytics: { data: [ { data_points: [...] } ] } }` and sometimes
 * `{ template_analytics: [ { data_points: [...] } ] }`. Both are handled rather
 * than picking one, because guessing wrong yields an empty array that is
 * indistinguishable from "this template genuinely sent nothing".
 *
 * NULL DISCIPLINE is the load-bearing part. Meta returns READ and CLICKED only
 * for the last ~7 days, and omits COST entirely for Solution-Partner-billed
 * WABAs. An absent metric becomes `null` — never 0 — so the storage layer can
 * COALESCE-merge and never overwrite a captured number with a later blank.
 */
export function parseTemplateAnalytics(json: {
  template_analytics?: unknown;
}): ProviderTemplateAnalyticsRow[] {
  const ta = json.template_analytics;
  const groups: unknown[] = Array.isArray(ta)
    ? ta
    : ta && typeof ta === "object" && Array.isArray((ta as { data?: unknown }).data)
      ? ((ta as { data: unknown[] }).data)
      : [];

  const out: ProviderTemplateAnalyticsRow[] = [];
  for (const group of groups) {
    const points = (group as { data_points?: unknown }).data_points;
    if (!Array.isArray(points)) continue;
    for (const raw of points) {
      const pt = raw as Record<string, unknown>;
      const templateExternalId = str(pt.template_id);
      const startSec = num(pt.start);
      if (!templateExternalId || startSec === null) continue;

      const cost = pt.cost;
      let amountSpent: number | null = null;
      let perDelivered: number | null = null;
      let perUrlClick: number | null = null;
      let currency: string | null = null;
      // `cost` is an ARRAY of typed entries, and it is absent (not zero) when
      // Meta withholds pricing.
      if (Array.isArray(cost)) {
        for (const entry of cost) {
          const e = entry as Record<string, unknown>;
          const type = str(e.type);
          const value = num(e.value);
          currency = str(e.currency) ?? currency;
          if (type === "AMOUNT_SPENT") amountSpent = value;
          else if (type === "COST_PER_DELIVERED") perDelivered = value;
          else if (type === "COST_PER_URL_BUTTON_CLICK") perUrlClick = value;
        }
      }

      out.push({
        templateExternalId,
        // Meta reports UNIX SECONDS; the day boundary is the window start.
        date: new Date(startSec * 1000),
        sent: num(pt.sent) ?? 0,
        delivered: num(pt.delivered) ?? 0,
        // Absent = not reported (outside the 7-day window), NOT zero.
        read: num(pt.read),
        clicked: num(pt.clicked),
        costAmountSpent: amountSpent,
        costPerDelivered: perDelivered,
        costPerUrlClick: perUrlClick,
        currency,
      });
    }
  }
  return out;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
