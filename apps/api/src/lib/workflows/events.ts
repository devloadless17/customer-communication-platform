/**
 * Typed event registry for the workflows system.
 *
 * Domain events emitted by the app (inbound message, assignment, status
 * change, tag change, manual trigger, …) are normalized into one of these
 * shapes before dispatch. Trigger conditions evaluate against the payload;
 * step handlers receive the payload verbatim (wrapped in a versioned
 * envelope on the wire).
 *
 * Adding a new trigger:
 *   1. Add a value to `WorkflowTriggerEvent` in prisma/schema.prisma
 *   2. Define its payload shape here
 *   3. Call dispatch() from the place the event actually happens
 *   4. Update lib/workflows/conditions.ts FIELDS_BY_TRIGGER if you want
 *      new condition fields exposed
 *   5. Update the UI's trigger picker
 */
import type {
  ConversationStatus,
  ProviderName,
  WorkflowTriggerEvent,
} from "@prisma/client";
import type { MediaKind } from "@ccp/shared/types";

export type { WorkflowTriggerEvent };

/** Wire-format envelope sent to http_request steps. Bump `version` on breaking changes. */
export interface WorkflowEventEnvelope<P = EventPayload> {
  version: 1;
  event: WorkflowTriggerEvent;
  teamId: string;
  occurredAt: string;
  data: P;
  /** URLs n8n / external apps can call back to fetch more context. */
  _links: {
    conversation: string;
    messages: string;
    contact: string;
  };
}

// ---------------------------------------------------------------------------
// Snapshot shapes — leaner than the full DB rows, only the fields workflow
// authors are likely to filter on or feed an AI. Adding fields is non-breaking
// (downstream parses JSON); removing them IS breaking, hence the `version: 1`.
// ---------------------------------------------------------------------------

export interface WorkflowMessageSnapshot {
  id: string;
  conversationId: string;
  externalId: string;
  direction: "in" | "out";
  body: string;
  mediaKind: MediaKind | null;
  mediaCaption: string | null;
  timestamp: string;
  senderUserId: string | null;
}

export interface WorkflowConversationSnapshot {
  id: string;
  status: ConversationStatus;
  assignedUserId: string | null;
  unreadCount: number;
  lastMessageAt: string;
  // Analytics fields — populated incrementally; null when the event hasn't
  // happened yet. Workflow authors filtering on conversation_closed should
  // see fully-populated values; those filtering on conversation_created see
  // mostly null.
  firstAssignedAt: string | null;
  firstAssignedUserId: string | null;
  lastAssignedAt: string | null;
  firstResponseAt: string | null;
  firstResponseByUserId: string | null;
  closedAt: string | null;
  closedByUserId: string | null;
  closedCategory: string | null;
  closedSummary: string | null;
  assignmentsCount: number;
  incomingMessagesCount: number;
  outgoingMessagesCount: number;
  responsesCount: number;
}

export interface WorkflowContactSnapshot {
  id: string;
  phoneNumber: string | null;
  identityProvider: ProviderName | null;
  externalContactId: string | null;
  name: string;
  email: string | null;
  stageId: string | null;
  tagIds: string[];
  customFields: Record<string, string>;
  // Additive — populated when the snapshot builder has the data on the input
  // Contact row. Mirrors @ccp/shared/workflows/events so the public outbound-
  // webhook envelope mapper can read them via the standard snapshot shape.
  firstName?: string | null;
  lastName?: string | null;
  language?: string | null;
  countryCode?: string | null;
  avatarUrl?: string | null;
  location?: string | null;
  assignedUserId?: string | null;
  createdAt?: string;
}

/**
 * Build a {@link WorkflowConversationSnapshot} from a Prisma Conversation
 * row. Centralized so dispatch sites don't each inline a 20-field spread
 * (and forget to update them all when the snapshot grows). Pass any object
 * with at least the required base fields — analytics fields default to the
 * "never happened" representation (null / 0) when omitted.
 */
export function workflowConversationSnapshot(c: {
  id: string;
  status: ConversationStatus;
  assignedUserId: string | null;
  unreadCount: number;
  lastMessageAt: Date;
  firstAssignedAt?: Date | null;
  firstAssignedUserId?: string | null;
  lastAssignedAt?: Date | null;
  firstResponseAt?: Date | null;
  firstResponseByUserId?: string | null;
  closedAt?: Date | null;
  closedByUserId?: string | null;
  closedCategory?: string | null;
  closedSummary?: string | null;
  assignmentsCount?: number;
  incomingMessagesCount?: number;
  outgoingMessagesCount?: number;
  responsesCount?: number;
}): WorkflowConversationSnapshot {
  return {
    id: c.id,
    status: c.status,
    assignedUserId: c.assignedUserId,
    unreadCount: c.unreadCount,
    lastMessageAt: c.lastMessageAt.toISOString(),
    firstAssignedAt: c.firstAssignedAt?.toISOString() ?? null,
    firstAssignedUserId: c.firstAssignedUserId ?? null,
    lastAssignedAt: c.lastAssignedAt?.toISOString() ?? null,
    firstResponseAt: c.firstResponseAt?.toISOString() ?? null,
    firstResponseByUserId: c.firstResponseByUserId ?? null,
    closedAt: c.closedAt?.toISOString() ?? null,
    closedByUserId: c.closedByUserId ?? null,
    closedCategory: c.closedCategory ?? null,
    closedSummary: c.closedSummary ?? null,
    assignmentsCount: c.assignmentsCount ?? 0,
    incomingMessagesCount: c.incomingMessagesCount ?? 0,
    outgoingMessagesCount: c.outgoingMessagesCount ?? 0,
    responsesCount: c.responsesCount ?? 0,
  };
}

export function workflowContactSnapshot(c: {
  id: string;
  phoneNumber: string | null;
  identityProvider?: ProviderName | null;
  externalContactId?: string | null;
  name: string;
  email?: string | null;
  stageId?: string | null;
  tags?: Array<{ id: string }>;
  customFields?: unknown;
  firstName?: string | null;
  lastName?: string | null;
  language?: string | null;
  countryCode?: string | null;
  avatarUrl?: string | null;
  location?: string | null;
  assignedUserId?: string | null;
  createdAt?: Date | string | null;
}): WorkflowContactSnapshot {
  return {
    id: c.id,
    phoneNumber: c.phoneNumber,
    identityProvider: c.identityProvider ?? null,
    externalContactId: c.externalContactId ?? null,
    name: c.name,
    email: c.email ?? null,
    stageId: c.stageId ?? null,
    tagIds: (c.tags ?? []).map((t) => t.id),
    customFields: normalizeCustomFields(c.customFields),
    firstName: c.firstName ?? null,
    lastName: c.lastName ?? null,
    language: c.language ?? null,
    countryCode: c.countryCode ?? null,
    avatarUrl: c.avatarUrl ?? null,
    location: c.location ?? null,
    assignedUserId: c.assignedUserId ?? null,
    createdAt:
      c.createdAt instanceof Date
        ? c.createdAt.toISOString()
        : c.createdAt ?? undefined,
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

export interface WorkflowUserSnapshot {
  id: string;
  name: string;
  email: string;
}

// ---------------------------------------------------------------------------
// Per-trigger payloads. Each payload carries `conversation` and `contact`
// where applicable so step handlers and condition evaluation can rely on
// those keys without per-trigger branching.
// ---------------------------------------------------------------------------

export interface MessageReceivedPayload {
  message: WorkflowMessageSnapshot;
  conversation: WorkflowConversationSnapshot;
  contact: WorkflowContactSnapshot;
  /**
   * Last N messages on the conversation (newest last), excluding the trigger
   * message. Pre-included so a downstream AI/RAG flow doesn't have to make
   * a round-trip just to get short-term context. n=10 by default.
   */
  recentMessages: WorkflowMessageSnapshot[];
}

export interface ConversationCreatedPayload {
  conversation: WorkflowConversationSnapshot;
  contact: WorkflowContactSnapshot;
}

export interface ConversationOpenedPayload {
  conversation: WorkflowConversationSnapshot;
  contact: WorkflowContactSnapshot;
  /** Status the conversation came from. `null` for fresh new conversations. */
  previousStatus: ConversationStatus | null;
  openedByUserId: string | null;
}

export interface ConversationClosedPayload {
  conversation: WorkflowConversationSnapshot;
  contact: WorkflowContactSnapshot;
  previousStatus: ConversationStatus;
  closedByUserId: string | null;
  closedCategory: string | null;
  closedSummary: string | null;
}

export interface ConversationAssignedPayload {
  conversation: WorkflowConversationSnapshot;
  contact: WorkflowContactSnapshot;
  assignedUser: WorkflowUserSnapshot | null;
  previousAssignedUserId: string | null;
}

export interface ConversationStatusChangedPayload {
  conversation: WorkflowConversationSnapshot;
  contact: WorkflowContactSnapshot;
  previousStatus: ConversationStatus;
  newStatus: ConversationStatus;
  changedByUserId: string | null;
}

export interface ContactTagUpdatedPayload {
  contact: WorkflowContactSnapshot;
  kind: "added" | "removed";
  tagId: string;
  /** User who applied the change. Null for system / API actions. */
  changedByUserId: string | null;
}

export interface ContactFieldUpdatedPayload {
  contact: WorkflowContactSnapshot;
  /** Key from ContactFieldDefinition. Always a string the team has registered. */
  fieldKey: string;
  previousValue: string | null;
  newValue: string | null;
  changedByUserId: string | null;
}

export interface ContactLifecycleUpdatedPayload {
  contact: WorkflowContactSnapshot;
  previousStageId: string | null;
  newStageId: string | null;
  changedByUserId: string | null;
}

export interface ManualTriggerPayload {
  contact: WorkflowContactSnapshot;
  /** Conversation context if the manual trigger was fired from the inbox; null otherwise. */
  conversation: WorkflowConversationSnapshot | null;
  triggeredByUserId: string;
  /** Arbitrary metadata the UI optionally passes (e.g. selected button id). */
  metadata: Record<string, string>;
}

export interface IncomingWebhookPayload {
  contact: WorkflowContactSnapshot | null;
  /** Raw JSON body of the incoming POST. */
  body: unknown;
  headers: Record<string, string>;
}

export type EventPayload =
  | MessageReceivedPayload
  | ConversationCreatedPayload
  | ConversationOpenedPayload
  | ConversationClosedPayload
  | ConversationAssignedPayload
  | ConversationStatusChangedPayload
  | ContactTagUpdatedPayload
  | ContactFieldUpdatedPayload
  | ContactLifecycleUpdatedPayload
  | ManualTriggerPayload
  | IncomingWebhookPayload;

export type PayloadFor<E extends WorkflowTriggerEvent> =
  E extends "message_received" ? MessageReceivedPayload :
  E extends "conversation_created" ? ConversationCreatedPayload :
  E extends "conversation_opened" ? ConversationOpenedPayload :
  E extends "conversation_closed" ? ConversationClosedPayload :
  E extends "conversation_assigned" ? ConversationAssignedPayload :
  E extends "conversation_status_changed" ? ConversationStatusChangedPayload :
  E extends "contact_tag_updated" ? ContactTagUpdatedPayload :
  E extends "contact_field_updated" ? ContactFieldUpdatedPayload :
  E extends "contact_lifecycle_updated" ? ContactLifecycleUpdatedPayload :
  E extends "manual_trigger" ? ManualTriggerPayload :
  E extends "incoming_webhook" ? IncomingWebhookPayload :
  never;
