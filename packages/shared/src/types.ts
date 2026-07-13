/**
 * Domain types for the WhatsApp Multi-Agent Shared Inbox.
 *
 * These mirror the Prisma schema we'll generate in Week 1, so swapping fake
 * data for real DB rows later is mostly a sed job. Multi-tenancy is baked in
 * (every row has teamId) even though MVP runs single-tenant.
 *
 * IDs are strings to match Prisma's cuid() defaults.
 */

export type Role = "superAdmin" | "admin" | "manager" | "agent";
export type Plan = "free" | "starter" | "advanced" | "enterprise";
// Org-approval lifecycle. `pending` = created, awaiting super-admin approval
// (no app access); `active` = approved; `suspended` = access revoked by a
// super-admin. Mirrors the Prisma `TeamStatus` enum.
export type TeamStatus = "pending" | "active" | "suspended";
export type ConversationStatus = "open" | "pending" | "closed";
export type MessageDirection = "in" | "out";
export type MessageStatus = "sent" | "delivered" | "read" | "failed";
// The messaging channel a conversation lives on — the single discriminator for
// "where is this from". Mirrors the Prisma `Channel` enum.
//   LIVE:      whatsapp (phone), messenger + instagram (Meta social, keyed by an
//              opaque PSID / IGSID).
//   DESIGNED-FOR (disabled): telegram / email / sms — enum value + capability
//              maps exist so the architecture is ready, but there's no provider
//              yet, so no row can carry them. See LIVE_CHANNELS.
export type Channel =
  | "whatsapp"
  | "messenger"
  | "instagram"
  | "telegram"
  | "email"
  | "sms";
// Provenance of an outbound message. `api` = sent through this platform;
// `business_app` = sent from the WhatsApp Business App on the owner's phone and
// mirrored to us via WhatsApp Coexistence. Mirrors the Prisma `MessageOrigin`
// enum (kept as a local union so the shared package has no Prisma dependency).
export type MessageOrigin = "api" | "business_app";

export interface Team {
  id: string;
  name: string;
  /** AI Autopilot opt-in (default false). When false the per-conversation AI
   *  controls are hidden and auto-pause-on-human-reply is skipped. Optional for
   *  source-compat; absent = false. */
  aiAutopilotEnabled?: boolean;
}

/**
 * User-controlled availability/presence.
 *
 *   available — default; shown as the regular online dot.
 *   busy      — yellow dot; receives events but signals "in a meeting / on a call".
 *   away      — grey dot; signals "stepped away, will be back".
 *   offline   — appears offline to teammates even while connected (still
 *               receives events so coming back is instant). NOT a hard
 *               disconnect — the socket stays up.
 *
 * `null`/undefined on the wire is equivalent to "available" (we don't force
 * existing rows through a backfill on migration).
 */
export type UserAvailabilityStatus = "available" | "busy" | "away" | "offline";

export interface User {
  id: string;
  teamId: string;
  role: Role;
  name: string;
  email: string;
  avatarUrl?: string;
  /** ISO timestamp the row was created. Used by settings/team for "joined X ago". */
  createdAt?: string;
  /**
   * False when the row has a `deactivatedAt` timestamp. Lets the client tell
   * who's still on the roster (sidebar / online dots / assignment dropdown)
   * vs. who only exists for historical message attribution. We expose the
   * boolean — not the date — to keep the client payload lean.
   */
  isActive: boolean;
  /** User-set availability. Absent = treat as "available". */
  availabilityStatus?: UserAvailabilityStatus;
  /** Optional free-form note teammates see alongside the status. */
  availabilityMessage?: string;
}

/** How this contact got into the DB. See ContactSource enum on the schema. */
export type ContactSource = "inbound" | "manual";

/**
 * Provider profile signals for a social contact. Instagram is the only channel
 * that exposes these today (on its user node); Messenger/WhatsApp expose none,
 * so every field is optional and the whole object is absent for them. Captured
 * at ingest, display-only context in the contact panel — never a strong key
 * (fuzzy identity matching is banned).
 */
export interface SocialProfile {
  /** IG follower count at capture time (a rough audience-size signal). */
  followerCount?: number | null;
  /** IG "verified" badge — `is_verified_user`. */
  isVerified?: boolean | null;
  /** The customer follows the business's IG account — `is_user_follow_business`. */
  followsBusiness?: boolean | null;
  /** The business follows the customer back — `is_business_follow_user`. */
  businessFollows?: boolean | null;
  // ── Messenger identity signals (each behind a `pages_user_*` App Review; null
  //    until that permission is approved, so these degrade cleanly to absent). ──
  /** IETF-ish locale from Meta, e.g. `en_US` — the customer's language/region. */
  locale?: string | null;
  /** GMT offset in hours (Meta `timezone`, e.g. `2`, `-7`) → renders "Local time". */
  timezone?: number | null;
  /** Meta-reported gender, e.g. `male` / `female`. */
  gender?: string | null;
}

export interface Contact {
  id: string;
  teamId: string;
  /**
   * WhatsApp/SMS contacts carry a phone number; Instagram/Telegram contacts
   * don't (their identity lives in `identityChannel` + `externalContactId`).
   * Nullable end-to-end so the UI degrades to "show what identity we have."
   */
  phoneNumber: string | null;
  /**
   * Multi-channel identity. Set together with `externalContactId` when the
   * contact's natural id isn't a phone number — Instagram scoped-user-id,
   * Telegram chat-id, etc. WhatsApp contacts leave both null and use
   * phoneNumber. The DB enforces `(teamId, identityChannel, externalContactId)`
   * uniqueness so a contact can be deduped on either key.
   */
  identityChannel?: Channel | null;
  externalContactId?: string | null;
  /**
   * Provider handle for social channels — the Instagram `@username`. Meta
   * exposes it on the IG user-profile node (Messenger/WhatsApp have none), so
   * it's captured at ingest and surfaced in the contact panel as an extra
   * identity signal. Null on channels without a handle.
   */
  username?: string | null;
  /**
   * Canonical display name. Derived from `firstName + lastName` when both
   * are set; otherwise it's whatever the create path (inbound webhook,
   * manual UI, CSV import, /v1 POST) stored. Single source of truth for
   * the inbox + every list rendering.
   */
  name: string;
  /** First name, split off `name` on first space at migration time + maintained at write time. */
  firstName?: string | null;
  /** Last name (rest of the original `name` after the first space). */
  lastName?: string | null;
  /** BCP-47 language tag — e.g. `"ar"`, `"en"`. Used for WhatsApp template selection. */
  language?: string | null;
  /** ISO 3166-1 alpha-2 country code derived from `phoneNumber` via libphonenumber. */
  countryCode?: string | null;
  /**
   * When set to a FUTURE timestamp, Meta has revoked our permission to place
   * business-initiated calls to this contact (4 consecutive unanswered calls,
   * or an explicit customer opt-out). The inbox hides the Phone button while
   * this is in the future so the agent isn't handed an enabled button the
   * backend would 4xx; cleared on the next permission grant. ISO 8601, or
   * null/undefined when calling is allowed. Surfaced only on the full
   * per-conversation contact load — the inbox-list mapper omits it.
   */
  callPermissionRevokedUntil?: string | null;
  avatarUrl?: string;
  /** Social-channel profile signals (Instagram follower count / verified /
   *  follow relationship). Absent on WhatsApp/Messenger. See {@link SocialProfile}. */
  socialProfile?: SocialProfile | null;
  email?: string;
  location?: string;
  /** Bag of custom field values, keyed by field key. Always a string. */
  customFields: Record<string, string>;
  source: ContactSource;
  /**
   * Derived view: the union of tag ids across every conversation this contact
   * owns. Tags live on Conversation (post the conversation-tags refactor), so
   * a contact's "tags" is computed by JOINing through their threads.
   * Populated only by routes that opt into the (cheap) extra JOIN; otherwise
   * undefined — never trust this client-side without a server-rendered value.
   */
  tagIds?: string[];
  /**
   * Customer-lifecycle stage this contact is currently in. Resolved against
   * the team's ContactStage catalog (/api/team/stages). Null when the
   * contact pre-dates the stages feature AND the team's default stage was
   * later deleted; the UI renders an "Unassigned" pill in that case.
   */
  stageId?: string | null;
  /** ISO row-creation timestamp. Exposed for webhook payloads and the /v1 contact GET. */
  createdAt?: string;
}

/**
 * Team-wide contact field definition. Every contact in the team renders one
 * row per definition (even when blank); the value lives in
 * Contact.customFields[key]. Per-contact one-off fields are keys on
 * customFields that DON'T have a matching definition.
 */
export interface ContactFieldDefinition {
  id: string;
  teamId: string;
  key: string;
  label: string;
  order: number;
  /** Admin-controlled visibility for the inbox contact panel. Hidden fields
   *  are dropped from the panel for all agents. Defaults to true on the
   *  server for backwards compat. */
  isVisible: boolean;
}

/**
 * Built-in contact-panel field visibility. Per-team admin toggle for the
 * rows in the inbox contact panel + contact detail drawer. Phone is NOT in
 * this map — it's the WhatsApp identity and always renders, as is `name`
 * (rendered as the panel heading). Stored as a JSON map on
 * Team.contactPanelBuiltins; the server resolves missing keys to the
 * "available by default" default (true), so existing teams keep parity
 * after the surface grows.
 *
 * `country` corresponds to the ISO 3166-1 alpha-2 `countryCode` column on
 * Contact; the shorter key keeps the settings UI human-readable.
 */
export interface ContactPanelBuiltins {
  firstName: boolean;
  lastName: boolean;
  email: boolean;
  location: boolean;
  language: boolean;
  country: boolean;
  firstContacted: boolean;
}

/**
 * Customer-lifecycle stage. Mirrors the ContactStage Prisma model. Per-team
 * configurable — the catalog comes from /api/team/stages.
 *
 * `color` reuses the TagColor named slots (lib/tag-colors.ts) so chips share
 * one Tailwind safelist; runtime falls back to `slate` if a row was created
 * with an unknown slot.
 */
export interface ContactStage {
  id: string;
  teamId: string;
  name: string;
  color: TagColor;
  position: number;
  /** True for the stage new contacts land in. At most one per team. */
  isDefault: boolean;
}

/**
 * Named color slot for a Tag. Maps to a safelist of Tailwind classes in
 * `lib/tag-colors.ts` — adding a new value here also needs an entry there
 * or the chip falls back to the slate variant.
 */
export type TagColor =
  | "slate"
  | "rose"
  | "amber"
  | "emerald"
  | "sky"
  | "violet"
  | "pink"
  | "lime"
  | "orange";

export const TAG_COLORS: TagColor[] = [
  "slate",
  "rose",
  "amber",
  "emerald",
  "sky",
  "violet",
  "pink",
  "lime",
  "orange",
];

export interface Tag {
  id: string;
  teamId: string;
  name: string;
  color: TagColor;
  /**
   * ISO-8601 creation timestamp. Optional because display-only construction
   * sites (contact chips, audience previews) don't carry it; the tags catalog
   * REST endpoint always populates it so the settings page can sort by recency.
   */
  createdAt?: string;
}

export type MediaKind = "image" | "video" | "audio" | "document" | "sticker";

/**
 * Conversation-list preview text for a media message that carries no caption.
 *
 * SINGLE SOURCE OF TRUTH — shared by the server (which writes
 * `Conversation.lastMessagePreview` on send/ingest, see
 * `apps/api/src/lib/providers/ingest.ts` `mediaPreview`) and the client (which
 * paints the same label optimistically before the `message:new` frame lands,
 * see the reply-box send path). These two must produce identical strings: if
 * they drift, the sender's list preview flickers from one label to the other
 * when the real server frame arrives.
 */
export function mediaPreviewLabel(kind: MediaKind | undefined): string {
  switch (kind) {
    case "image":
      return "📷 Photo";
    case "video":
      return "🎥 Video";
    case "audio":
      return "🎤 Voice message";
    case "document":
      return "📄 Document";
    case "sticker":
      return "🌟 Sticker";
    default:
      return "";
  }
}

/**
 * DTO returned by `/api/team/whatsapp/templates` for the picker UI. Lives
 * here (not next to the route) so client components can import the type
 * without a moduleresolution edge case pulling server-only deps along.
 */
export interface TemplateDto {
  id: string;
  externalId: string | null;
  name: string;
  language: string;
  category: string;
  status: string;
  bodyText: string;
  // Loose typing — the picker narrows to TemplateComponent[] internally.
  components: unknown[];
  /**
   * Per-variable metadata (label + source + defaultValue). See
   * `lib/template-bindings.ts` for the shape. Empty `{}` for templates that
   * haven't had bindings configured yet.
   */
  variableBindings: unknown;
  syncedAt: string;
}

/** Per-recipient outcome of a forward, returned by `/api/messages/forward`. */
export interface ForwardResult {
  contactId: string;
  contactName: string;
  /** True when every queued message reached this contact. */
  ok: boolean;
  sent: number;
  failed: number;
  /** First failure reason (e.g. closed 24h window); only when `failed > 0`. */
  error?: string;
}

export interface MediaAttachment {
  kind: MediaKind;
  /** Public URL the browser fetches (always /api/media/<messageId>). */
  url: string;
  mimeType: string;
  sizeBytes: number;
  /** Optional caption shown alongside the media. */
  caption?: string;
  /** Original filename — only set for documents. */
  filename?: string;
  /** Audio + video only. */
  durationMs?: number;
  /** Audio only: true for a WhatsApp voice note (push-to-talk) vs a shared
   *  audio file. Drives the mic glyph + "Voice message" label on the bubble. */
  voice?: boolean;
  /**
   * Video-only — server-generated first-frame JPEG used as the `poster`
   * attribute on `<video>`. Absent on outbound video (the agent's player
   * picks its own frame) and on inbound rows that predate the M8 audit
   * (graceful: VideoBlock falls back to bg-black). Served through the
   * same auth-redirect path as the main media URL.
   */
  thumbnailUrl?: string;
}

/**
 * Snapshot of a quoted message — just enough to render the gray quote block
 * inside a reply bubble. Resolved server-side via JOIN at read time, so
 * editing the original (when we add edit) automatically refreshes the quote.
 */
export interface ReplySnapshot {
  id: string;
  /** Caption for media, body for text. Truncated server-side if huge. */
  body: string;
  direction: MessageDirection;
  /** Authoring teammate's name on outbound; null on inbound. */
  senderName: string | null;
  /** When the original was a media message, what kind. */
  mediaKind?: MediaKind;
  /**
   * Small thumbnail for the quoted-reply preview when the original was an
   * image or video. Image: the authenticated media stream itself (it doubles
   * as its own thumb); video: the extracted poster, only when one exists.
   * Absent for non-image/video media (audio/document/sticker) and text.
   */
  thumbnailUrl?: string;
}

/**
 * Structured (non-media) message content that gets a dedicated bubble instead of
 * a plain text placeholder — a shared WhatsApp location pin or contact card. The
 * `body` still carries a human-readable placeholder (for search / list preview /
 * unread), and this drives the rich rendering. Discriminated by `kind`.
 */
export type MessageStructured =
  | {
      kind: "location";
      latitude: number;
      longitude: number;
      name?: string;
      address?: string;
    }
  | {
      kind: "contacts";
      // A shared vCard. `phones` stays a plain string[] (back-compat with rows
      // stored before the richer fields existed); the rest are optional so old
      // rows render unchanged while new ones carry everything WhatsApp shows.
      contacts: Array<{
        name: string;
        phones: string[];
        emails?: string[];
        /** Pre-formatted, human-readable address lines. */
        addresses?: string[];
        /** "Title · Company" (whichever parts the vCard included). */
        company?: string;
      }>;
    }
  | {
      // Instagram story interaction: the customer mentioned you in / replied to
      // their story, or shared a post. `url` is the story/post media when Meta
      // includes it (a preview thumbnail the agent can open for context).
      kind: "story";
      storyType: "mention" | "reply" | "share";
      url?: string;
    }
  | {
      // A WhatsApp catalog order the customer placed (`type:"order"`). Items
      // reference catalog products by retailer id — we don't resolve product
      // names (no catalog join), so the card shows id × qty @ price + a total.
      kind: "order";
      items: Array<{
        retailerId: string;
        quantity: number;
        price?: number;
      }>;
      itemCount: number;
      total?: number;
      currency?: string;
    };

/**
 * Ad / deep-link attribution on the FIRST inbound message of an ad-sourced
 * conversation — a Click-to-WhatsApp ad (WhatsApp `referral`) or a
 * Click-to-Messenger ad / m.me `ref` (Messenger `referral`). Surfaced as a small
 * "from your ad" chip so an agent instantly knows the customer came from a
 * campaign (and the `sourceUrl`/`ctwaClid` tie it back to the ad platform).
 */
export interface MessageAttribution {
  /** `ad` (paid), `post` (organic CTA), or the deep-link `ref` payload. */
  source: "ad" | "post" | "ref" | "unknown";
  /** Ad creative headline, when present. */
  headline?: string;
  /** Ad creative body/description, when present. */
  body?: string;
  /** The ad/post URL the customer clicked. */
  sourceUrl?: string;
  /** Click id (WhatsApp `ctwa_clid` / Messenger ad id) for ad-platform matching. */
  clickId?: string;
  /** Free-form deep-link ref payload (m.me `ref=...`), when that's the source. */
  ref?: string;
}

export interface Message {
  id: string;
  teamId: string;
  conversationId: string;
  /** Provider-assigned id; UNIQUE across messages for dedupe. */
  externalId: string;
  /** null on inbound — only outbound messages have an authoring agent. */
  senderUserId: string | null;
  /** For media messages: the caption (or empty). For text: the message body. */
  body: string;
  direction: MessageDirection;
  channel: Channel;
  /**
   * Provenance of an OUTBOUND message. Absent/`"api"` for the overwhelming
   * majority — anything sent through this platform (agent, automation,
   * broadcast, /v1). `"business_app"` marks a message the owner sent from the
   * WhatsApp Business App on their phone, mirrored to us via WhatsApp
   * Coexistence — the inbox renders a "· via WhatsApp app" marker so a phone
   * reply is distinguishable from a system/automation send (both agentless).
   * Always `"api"` (or absent) on inbound rows.
   */
  origin?: MessageOrigin;
  status: MessageStatus;
  /**
   * Provider failure diagnostics — present ONLY on a `status: "failed"`
   * outbound message that carried a Meta `errors[0]` reason. Surfaces WHY a
   * send failed to the agent in the inbox failed bubble (tooltip / muted
   * line). Persisted on Message.statusError* and hydrated by `mapMessage` so a
   * page refresh stays consistent with the live `message:status` socket frame.
   */
  statusErrorCode?: number | null;
  statusErrorTitle?: string | null;
  statusErrorDetail?: string | null;
  /**
   * The CUSTOMER's current emoji reaction to this message (WhatsApp lets a
   * contact react to any message). Set / replaced / cleared by inbound
   * reaction webhooks; null/absent = no reaction. Rendered as a small pill on
   * the bubble.
   */
  reaction?: string | null;
  /**
   * OUR team's outbound reaction to this message — the business-side twin of
   * `reaction`, a separate field so a customer reaction and our reaction on the
   * same message coexist. Set / cleared by the send-reaction path; null/absent
   * = we haven't reacted. Rendered as its own pill next to the customer's.
   */
  agentReaction?: string | null;
  /**
   * Structured non-media content (shared location pin / contact card). Drives a
   * dedicated bubble; `body` still holds the text placeholder. Absent for normal
   * text/media messages. See {@link MessageStructured}.
   */
  structured?: MessageStructured | null;
  /**
   * Ad / deep-link attribution on an ad-sourced conversation's first inbound
   * message. Drives a "from your ad" chip on the bubble. Absent otherwise. See
   * {@link MessageAttribution}.
   */
  attribution?: MessageAttribution | null;
  /**
   * ISO time the CUSTOMER unsent (deleted) this message (WhatsApp revoke /
   * Messenger·Instagram unsend). When set, the bubble renders "This message was
   * deleted" instead of the body (which is preserved in the DB for the record).
   * null/absent = not deleted.
   */
  deletedAt?: string | null;
  /**
   * ISO time the customer edited this message's body (WhatsApp edit). The `body`
   * already carries the new text; this just drives an "edited" marker on the
   * bubble. null/absent = never edited.
   */
  editedAt?: string | null;
  /**
   * Original webhook payload, kept verbatim in the DB for debugging
   * (CLAUDE.md rule #4). NOT hydrated on read paths — the column is `omit`ed
   * from every message query so a full JSONB blob per row never travels
   * Postgres → Node → browser. Optional here; only present on the write-side
   * objects that just inserted the row.
   */
  rawPayload?: Record<string, unknown>;
  timestamp: string;
  /** Set when the message carries an attachment; absent for text-only. */
  media?: MediaAttachment;
  /**
   * Inbound media only: true while the binary is still being downloaded from
   * Meta + uploaded to our blob provider in the background. The bubble shows
   * a placeholder for the kind (image/video/audio/document) until a
   * `message:media:ready` event swaps in the real `media` block. Lets the
   * agent see "📷 Photo" in ~100ms instead of waiting for the full download.
   */
  mediaPending?: boolean;
  /** When this message is a quoted reply, the id of the original. */
  replyToMessageId?: string | null;
  /** Snapshot used by the bubble to render the quote block inline. */
  replyTo?: ReplySnapshot | null;
  /**
   * Interactive reply payload — set when this inbound message is the customer
   * tapping a button / list option (WhatsApp interactive reply). `kind` is the
   * parser value (`"button_reply"` | `"list_reply"`); `id` is the stable author-
   * assigned option id (what workflows branch on); `title` is the localized
   * label the customer saw. Absent / null for every plain text or media message.
   */
  interactive?: { kind: string; id: string; title: string } | null;
  // ----- Optimistic UI (client-side only — never persisted by the server) -----
  /**
   * Round-tripped through the API + socket emit so the client can match an
   * optimistic bubble against its real counterpart and swap silently.
   */
  clientTempId?: string;
  /** True while the bubble is awaiting server confirmation. */
  pending?: boolean;
  /** True when the optimistic send hit a network / 4xx error. */
  failed?: boolean;
  /**
   * CLIENT-ONLY monotonic send-order stamp, assigned when the agent creates an
   * optimistic own-send and PRESERVED across the `message:new` reconcile (like
   * `clientTempId`). The timeline uses it for two things: (1) tail-membership
   * stickiness — a reconciled own-send keeps pinned to the bottom while an
   * EARLIER-seq sibling is still pending, so an out-of-order `message:new` can't
   * let a later send's confirmed row jump above a still-pending earlier one; and
   * (2) tail ordering — pinned rows sort by this clock-independent seq instead of
   * by mixed client/server timestamps. Shared counter with the optimistic
   * activity pills (see ConversationActivityEvent.optimisticSeq) so a send and
   * the auto-pause pill it triggers order deterministically.
   */
  optimisticSeq?: number;
  /**
   * CLIENT-ONLY group key (= this send's `clientTempId`), set on an optimistic
   * own-send and PRESERVED across the `message:new` reconcile. It ties the
   * message to the auto-claim activity pills the same send fans out
   * (ConversationActivityEvent.optimisticGroupId). The timeline ANCHORS those
   * pills to this message's timeline position (sorting them in send order
   * directly under it) instead of their own racy/late server audit `at` — so a
   * "reopened"/"self-assigned" pill can never float ABOVE the reply once the
   * send confirms with a server/Meta timestamp. Absent on non-own messages and
   * on every server-origin row, which sort purely by `timestamp`.
   */
  optimisticGroupId?: string;
}

/**
 * Snippet shape consumed by the reply composer's slash menu. The settings
 * editor uses a richer DTO (with `createdBy`/`updatedAt`) defined alongside
 * that page; this one is the minimum the inbox runtime needs.
 */
export interface SnippetItem {
  id: string;
  name: string;
  label: string;
  body: string;
}

export interface InternalNote {
  id: string;
  conversationId: string;
  /** Null when the author was hard-deleted. UI renders "Removed user". */
  authorUserId: string | null;
  body: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Conversation activity log (audit timeline rendered inline in the thread).
// Backed by the ConversationEvent table — recorded server-side by the audit
// subscriber, READ here for display. Names (actor, stage, tag) are resolved at
// write time on the server so historical entries survive renames/deletes.
// ---------------------------------------------------------------------------

export type ConversationEventKind =
  | "assigned"
  | "status_changed"
  | "tag_added"
  | "tag_removed"
  | "stage_changed"
  | "note_added"
  | "note_deleted"
  | "ai_paused"
  | "ai_resumed"
  | "call_completed"
  | "call_missed"
  | "call_rejected"
  | "call_failed";

/**
 * Who triggered the change.
 *  - `user`     — a human session (actorName = their name)
 *  - `apiKey`   — an external /v1 integration (actorName = the key's label)
 *  - `workflow` — an automation step (actorWorkflowName = the workflow's name,
 *                 or null/undefined for a since-deleted workflow → generic label)
 *  - `system`   — no human, no API key, no workflow (retention sweeps, etc.)
 */
export type ActivityActorKind = "user" | "apiKey" | "workflow" | "system";

/**
 * One inline activity entry. `before`/`after` carry the per-kind payload the
 * audit subscriber wrote (e.g. status_changed → before.status / after.status;
 * stage_changed → before.stageName / after.stageName; assigned →
 * before.assignedUserId / after.assignedUserId). The server pre-resolves
 * `assignedToName` for `assigned` so the client doesn't need the team roster.
 */
export interface ConversationActivityEvent {
  id: string;
  conversationId: string;
  kind: ConversationEventKind;
  /** Display name of the actor; null when system/automation. */
  actorName: string | null;
  actorKind: ActivityActorKind;
  /** Pre-resolved target-user name for `assigned` (the new assignee), null on
   *  unassign. Other kinds leave it undefined. */
  assignedToName?: string | null;
  /** Pre-resolved workflow name when `actorKind === "workflow"` (the automation
   *  that caused the change). null when the workflow was since deleted (the row
   *  kept its `workflowId` but the name can't be resolved) → the timeline falls
   *  back to a generic "Automation" label. Other actor kinds leave it undefined. */
  actorWorkflowName?: string | null;
  /** Raw per-kind payload as written by the audit subscriber. */
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** ISO timestamp — named `at` to match the message/note `timestamp` only at
   *  the timeline-merge boundary (the merge maps it). */
  at: string;
  /**
   * CLIENT-ONLY, never serialized by the server. True while this is an
   * un-reconciled optimistic stub (the agent's own just-made change, before the
   * authoritative GET confirms it). The timeline pins ONLY these to the bottom;
   * the instant the server row reconciles, the stub is rebuilt from server data
   * (which lacks this flag) so it settles and sorts by real server time — just
   * like a message does when its `pending` clears. Keeping a reconciled row
   * pinned (the old behavior, keyed off the surviving `optimistic-…` id) was the
   * source of two ordering bugs: a later message sorting ABOVE a stuck-pinned
   * log, and rapid changes jumping mid-list→bottom as server-clocked reconciled
   * rows tie-broke against client-clocked fresh stubs.
   */
  optimisticPending?: boolean;
  /**
   * CLIENT-ONLY monotonic stamp shared with optimistic messages
   * (Message.optimisticSeq). Used to order this pill within the pinned tail
   * relative to the send that triggered it — e.g. an agent reply (lower seq)
   * then the auto-pause pill it causes (higher seq) render in that order
   * instead of fighting on client-vs-server clocks. Dropped on reconcile along
   * with `optimisticPending`.
   */
  optimisticSeq?: number;
  /**
   * CLIENT-ONLY group key identifying pills emitted by ONE triggering action —
   * specifically the auto-claim trio (ai_paused + reopened + self-assigned) a
   * single human reply fans out together, keyed by that send's `clientTempId`.
   * The server writes these rows near-simultaneously, so their audit `at` is
   * racy and would let "self-assigned" swap above "reopened" the moment the
   * triggering send confirms and un-pins them. The timeline keeps pills that
   * share this id ordered by `optimisticSeq` even after they settle, so the trio
   * holds its send order. NARROW BY DESIGN: only the reply-box send path sets
   * it; independent actions (dropdown status/assign, stage, tag) leave it
   * undefined and sort purely by `at`. Carried across reconcile with
   * `optimisticSeq`; absent on every server-origin row.
   */
  optimisticGroupId?: string;
}

export interface Conversation {
  id: string;
  teamId: string;
  contactId: string;
  assignedUserId: string | null;
  status: ConversationStatus;
  /**
   * AI Autopilot — true = the conversation is eligible for the external AI
   * auto-reply flow; false = a human is handling it (AI stays silent). Drives
   * the inbox "AI Autopilot" toggle. Optional for source-compat; absent =
   * true (the column default).
   */
  aiEnabled?: boolean;
  /**
   * Team-wide unread counter — the single source of truth for both the row
   * badge AND the bold-text "unread" cue across the inbox UI. Unread is
   * team-wide by design (collab inbox): any member opening a thread zeroes
   * this and it clears for everyone. There is no per-agent inbox read state
   * (team chat has its own; see TeamChannelReadReceipt).
   */
  unreadCount: number;
  lastMessageAt: string;
  lastMessagePreview: string;
  /**
   * Direction of the message behind `lastMessagePreview` — drives the inbox
   * row's triage cue ("we replied" arrow vs a customer message waiting). Set
   * everywhere `lastMessagePreview` is set so the two never disagree. Optional
   * + nullable: legacy rows / brand-new conversations have no real last message
   * yet, which the row renders as no cue.
   */
  lastMessageDirection?: MessageDirection | null;
  /**
   * Channel this thread lives on. Drives channel-aware UI affordances —
   * today the Phone button (whatsapp-only). Optional for source-compat;
   * absent = whatsapp (the only channel in the data model right now).
   */
  channel?: Channel;
}

/**
 * Lightweight join shape used by the UI. The server resolves these from
 * Prisma; the UI never assembles them by hand.
 */
export interface ConversationWithRefs {
  conversation: Conversation;
  contact: Contact;
  assignedUser: User | null;
  messages: Message[];
  notes: InternalNote[];
  /**
   * Inline activity log — assignment / status / stage / tag / note-delete
   * events, newest-relevant window, oldest-first to match `messages`/`notes`.
   * Merged into the thread timeline by `at`. Bounded server-side so a churny
   * thread can't bloat the hydration payload; the full history (if ever
   * needed) would be a separate paginated endpoint. Optional + defaults to
   * `[]` so existing construction sites (list rows, ingest fanout) that don't
   * populate it stay valid.
   */
  events?: ConversationActivityEvent[];
  /**
   * Latest inbound timestamp across ALL of this contact's conversations.
   * Used to drive the 24h customer-service window in the reply box. Null
   * when the contact has never messaged us — only templates can be sent
   * in that case (Meta Cloud API constraint).
   */
  lastInboundAt: string | null;
  /**
   * True totals for this conversation, used by the contact panel's
   * "Messages · Notes" stat row. `messages` above is paginated (the most
   * recent N), so its length lies for long threads. Notes happen to be
   * loaded in full today, but we keep the field here for symmetry and
   * to stay correct if note pagination is ever added.
   *
   * Optional: only populated by `getConversationWithRefs` (the per-thread
   * hydration). The conversation list keeps these undefined to avoid a
   * count() query per row — the sidebar doesn't render them.
   */
  messageCount?: number;
  noteCount?: number;
  /**
   * Active in-flight voice call for this thread, if any. Set by the
   * `call:incoming` / `call:ringing` reducers, cleared by `call:ended`.
   * The full call HISTORY is `calls` below; this slot is the live one.
   */
  activeCall?: ActiveCallState | null;
  /**
   * Voice call history, oldest-first to match `messages`/`notes`. Merged
   * into the thread timeline by `ringingAt`. Optional + defaults to `[]`
   * so existing construction sites stay valid.
   */
  calls?: CallSnapshot[];
}

/**
 * In-flight call state — what the inbox shell + thread renders while a call
 * is ringing or active. Cleared on every terminal state.
 */
export interface ActiveCallState {
  callId: string;
  externalCallId: string;
  direction: "in" | "out";
  status: "ringing" | "in_progress";
  startedAt: string;
  answeredAt: string | null;
}

/**
 * Wire-shape snapshot of a Call row. Mirrors `apps/api/src/calls/calls.service.ts`
 * SerializedCall. Lives here so the inbox + contact panel can render call
 * history with the same shape the API emits.
 */
export interface CallSnapshot {
  id: string;
  conversationId: string;
  externalCallId: string;
  channel: string;
  direction: "in" | "out";
  status: "ringing" | "in_progress" | "completed" | "missed" | "rejected" | "failed";
  /** Agent who PLACED an outbound call (null for inbound / unknown). */
  initiatedByUserId: string | null;
  answeredByUserId: string | null;
  ringingAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
}

/** Patch shape accepted by `PATCH /api/contacts/[id]`. All fields optional. */
export interface ContactPatch {
  name?: string;
  phoneNumber?: string;
  email?: string | null;
  location?: string | null;
  /** Partial merge: keys with `null` value are removed, strings overwrite. */
  customFields?: Record<string, string | null>;
  /** Move the contact to this stage. `null` clears the stage. */
  stageId?: string | null;
}

/**
 * One row in the /contacts list. Carries the latest non-closed conversation
 * (when one exists) so the row can show "Open chat" vs "No thread yet"
 * without an N+1 round-trip.
 */
export interface ContactListItem {
  contact: Contact;
  /** Latest non-closed conversation for this contact, if any. */
  activeConversationId: string | null;
  /** Most recent message timestamp across all conversations — for sorting / "last seen". */
  lastMessageAt: string | null;
  /**
   * Most recent INBOUND message timestamp across all conversations
   * (including closed). Used to compute the 24h customer-service window —
   * outbound messages don't reset that clock.
   */
  lastInboundAt: string | null;
  /**
   * "Group by person" mode only: every channel the unified PERSON behind this
   * row is reachable on (this contact is the representative). Drives the row's
   * channel-badge cluster. Undefined in the default per-contact list. Length ≥ 1.
   */
  personChannels?: Channel[];
}

/**
 * Generic keyset-paginated page. `nextCursor` is opaque to the client —
 * it just round-trips it to the next request. `null` means no more pages.
 */
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  /**
   * Authoritative total matching the request's filter set (NOT just the loaded
   * page). Populated only on the FIRST page (no cursor) — scroll-pages omit it
   * and the client reuses the first value. Lets the UI show "Showing 200 of
   * 3,418" instead of capping the displayed count at the loaded-row count.
   * Optional because not every cursor-paged endpoint computes it.
   */
  totalCount?: number;
}

