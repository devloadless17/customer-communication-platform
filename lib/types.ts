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
export type ConversationStatus = "open" | "pending" | "closed";
export type MessageDirection = "in" | "out";
export type MessageStatus = "sent" | "delivered" | "read" | "failed";
export type ProviderName = "meta_cloud";

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
}

/** How this contact got into the DB. See ContactSource enum on the schema. */
export type ContactSource = "inbound" | "manual";

export interface Contact {
  id: string;
  teamId: string;
  phoneNumber: string;
  name: string;
  avatarUrl?: string;
  email?: string;
  location?: string;
  /** Bag of custom field values, keyed by field key. Always a string. */
  customFields: Record<string, string>;
  source: ContactSource;
  /**
   * Tags currently applied to this contact. Empty array when the contact has
   * none. Tags themselves are listed in `/api/team/tags`; the strings here
   * are just the tag ids — the UI joins against the catalog.
   */
  tagIds?: string[];
  /**
   * Customer-lifecycle stage this contact is currently in. Resolved against
   * the team's ContactStage catalog (/api/team/stages). Null when the
   * contact pre-dates the stages feature AND the team's default stage was
   * later deleted; the UI renders an "Unassigned" pill in that case.
   */
  stageId?: string | null;
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
}

export type MediaKind = "image" | "video" | "audio" | "document" | "sticker";

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
  provider: ProviderName;
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
  authorUserId: string;
  body: string;
  timestamp: string;
}

export interface Conversation {
  id: string;
  teamId: string;
  contactId: string;
  assignedUserId: string | null;
  status: ConversationStatus;
  /** Denormalized for inbox-list rendering — kept in sync server-side. */
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

/**
 * Provider abstraction. App code only ever talks to this interface. The
 * Evolution and Meta Cloud implementations live behind it.
 *
 * Phase 2 forward-compat notes (flagged in CLAUDE.md):
 * - sendText to a fresh contact requires a pre-approved template on Cloud API.
 * - sendMedia returns a URL on Evolution; on Cloud API it'll be a media id.
 * - typingIndicator may not be available on Cloud API.
 */
export interface MessagingProvider {
  readonly name: ProviderName;
  sendText(input: SendTextInput): Promise<SendResult>;
  sendMedia(input: SendMediaInput): Promise<SendResult>;
  typingIndicator?(input: TypingInput): Promise<void>;
}

export interface SendTextInput {
  teamId: string;
  conversationId: string;
  toPhoneNumber: string;
  body: string;
  /** The agent authoring the message — recorded for attribution. */
  senderUserId: string;
}

export interface SendMediaInput extends Omit<SendTextInput, "body"> {
  mediaUrl: string;
  caption?: string;
}

export interface TypingInput {
  toPhoneNumber: string;
  durationMs: number;
}

export interface SendResult {
  externalId: string;
  status: MessageStatus;
}
