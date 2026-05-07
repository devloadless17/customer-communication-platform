/**
 * Domain types for the WhatsApp Multi-Agent Shared Inbox.
 *
 * These mirror the Prisma schema we'll generate in Week 1, so swapping fake
 * data for real DB rows later is mostly a sed job. Multi-tenancy is baked in
 * (every row has teamId) even though MVP runs single-tenant.
 *
 * IDs are strings to match Prisma's cuid() defaults.
 */

export type Role = "admin" | "agent";
export type ConversationStatus = "open" | "pending" | "closed";
export type MessageDirection = "in" | "out";
export type MessageStatus = "sent" | "delivered" | "read" | "failed";
export type ProviderName = "evolution" | "meta_cloud";

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

export interface Contact {
  id: string;
  teamId: string;
  phoneNumber: string;
  name: string;
  avatarUrl?: string;
}

export interface Message {
  id: string;
  teamId: string;
  conversationId: string;
  /** Provider-assigned id; UNIQUE across messages for dedupe. */
  externalId: string;
  /** null on inbound — only outbound messages have an authoring agent. */
  senderUserId: string | null;
  body: string;
  direction: MessageDirection;
  provider: ProviderName;
  status: MessageStatus;
  /** Original webhook payload kept verbatim for debugging. */
  rawPayload: Record<string, unknown>;
  timestamp: string;
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
