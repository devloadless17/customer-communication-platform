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
export type ConversationStatus = "open" | "pending" | "closed";
export type MessageDirection = "in" | "out";
export type MessageStatus = "sent" | "delivered" | "read" | "failed";
export type Channel = "whatsapp";

export interface Team {
  id: string;
  name: string;
}

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
}

/** How this contact got into the DB. See ContactSource enum on the schema. */
export type ContactSource = "inbound" | "manual";

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
  avatarUrl?: string;
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
  status: MessageStatus;
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

export interface Conversation {
  id: string;
  teamId: string;
  contactId: string;
  assignedUserId: string | null;
  status: ConversationStatus;
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
}

/**
 * Generic keyset-paginated page. `nextCursor` is opaque to the client —
 * it just round-trips it to the next request. `null` means no more pages.
 */
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

