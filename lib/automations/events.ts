/**
 * Typed event registry for the automations system.
 *
 * Domain events emitted by the app (inbound message, assignment, status
 * change) are normalized into one of these shapes before dispatch. Conditions
 * are evaluated against the payload, and the action handler receives the
 * payload verbatim (wrapped in a versioned envelope on the wire).
 *
 * Adding a new trigger:
 *   1. Add a value to `AutomationTriggerEvent` in prisma/schema.prisma
 *   2. Define its payload shape here
 *   3. Call dispatch() from the place the event actually happens
 *   4. Update lib/automations/conditions.ts if you want new condition fields
 *   5. Update the UI's trigger picker
 */
import type { AutomationTriggerEvent, ConversationStatus, ProviderName } from "@prisma/client";
import type { MediaKind } from "@/lib/types";

export type { AutomationTriggerEvent };

/** Wire-format envelope sent to webhook actions. Bump `version` on breaking changes. */
export interface AutomationWebhookEnvelope<P = EventPayload> {
  version: 1;
  event: AutomationTriggerEvent;
  teamId: string;
  occurredAt: string;
  data: P;
  /** URLs n8n can call back to fetch more context. Honors APP_PUBLIC_URL. */
  _links: {
    conversation: string;
    messages: string;
    contact: string;
  };
}

// ---------------------------------------------------------------------------
// Snapshot shapes — leaner than the full DB rows, only the fields automation
// authors are likely to filter on or feed an AI. Adding fields is non-breaking
// (n8n parses JSON); removing them IS breaking, hence the `version: 1`.
// ---------------------------------------------------------------------------

export interface AutomationMessageSnapshot {
  id: string;
  conversationId: string;
  externalId: string;
  direction: "in" | "out";
  body: string;
  /** Present only when the message carried a media attachment. */
  mediaKind: MediaKind | null;
  /** Caption when present, separate from `body` for media-with-caption rows. */
  mediaCaption: string | null;
  /** ISO-8601, matches DB column. */
  timestamp: string;
  /** Outbound only: who sent it. null for inbound. */
  senderUserId: string | null;
}

export interface AutomationConversationSnapshot {
  id: string;
  status: ConversationStatus;
  assignedUserId: string | null;
  unreadCount: number;
  lastMessageAt: string;
}

export interface AutomationContactSnapshot {
  id: string;
  /**
   * Null for non-phone-identity channels (Instagram/Telegram). WhatsApp-only
   * automations can short-circuit on null; channel-agnostic ones should
   * resolve identity through {@link identityProvider}+{@link externalContactId}.
   */
  phoneNumber: string | null;
  identityProvider: ProviderName | null;
  externalContactId: string | null;
  name: string;
  email: string | null;
  /** Custom fields the team has configured; empty `{}` when none. */
  customFields: Record<string, string>;
}

/**
 * Build an {@link AutomationContactSnapshot} from a Prisma Contact row (or
 * any object with the same fields). Centralized so the conversation routes
 * (assign / status / tags / messages) don't each inline the same field list
 * and forget to add new ones when the snapshot shape grows.
 */
export function automationContactSnapshot(c: {
  id: string;
  phoneNumber: string | null;
  identityProvider?: ProviderName | null;
  externalContactId?: string | null;
  name: string;
  email?: string | null;
  customFields?: unknown;
}): AutomationContactSnapshot {
  return {
    id: c.id,
    phoneNumber: c.phoneNumber,
    identityProvider: c.identityProvider ?? null,
    externalContactId: c.externalContactId ?? null,
    name: c.name,
    email: c.email ?? null,
    customFields: normalizeCustomFields(c.customFields),
  };
}

function normalizeCustomFields(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export interface AutomationUserSnapshot {
  id: string;
  name: string;
  email: string;
}

// ---------------------------------------------------------------------------
// Per-trigger payloads
// ---------------------------------------------------------------------------

export interface MessageReceivedPayload {
  message: AutomationMessageSnapshot;
  conversation: AutomationConversationSnapshot;
  contact: AutomationContactSnapshot;
  /**
   * Last N messages on the conversation (newest last), excluding the trigger
   * message. Pre-included so a downstream AI/RAG flow doesn't have to make a
   * round-trip just to get short-term context. n=10 by default.
   */
  recentMessages: AutomationMessageSnapshot[];
}

export interface ConversationAssignedPayload {
  conversation: AutomationConversationSnapshot;
  contact: AutomationContactSnapshot;
  /** Null when the conversation was UNassigned. */
  assignedUser: AutomationUserSnapshot | null;
  /** Previous assignee (if any). Null when the conversation was unassigned before. */
  previousAssignedUserId: string | null;
}

export interface ConversationStatusChangedPayload {
  conversation: AutomationConversationSnapshot;
  contact: AutomationContactSnapshot;
  previousStatus: ConversationStatus;
  newStatus: ConversationStatus;
  /** User who triggered the change. Null for system-driven transitions. */
  changedByUserId: string | null;
}

export type EventPayload =
  | MessageReceivedPayload
  | ConversationAssignedPayload
  | ConversationStatusChangedPayload;

/** Compile-time helper: given an event, which payload shape it carries. */
export type PayloadFor<E extends AutomationTriggerEvent> =
  E extends "message_received" ? MessageReceivedPayload :
  E extends "conversation_assigned" ? ConversationAssignedPayload :
  E extends "conversation_status_changed" ? ConversationStatusChangedPayload :
  never;
