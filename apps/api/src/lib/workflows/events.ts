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
  Channel,
  WorkflowTriggerEvent,
} from "@prisma/client";
import type { MediaKind } from "@ccp/shared/types";

export type { WorkflowTriggerEvent };

/**
 * Cross-system chain-depth ceiling shared by every entry point that can
 * fan back into the platform via a partner round-trip: the per-workflow
 * `incoming_webhook` trigger AND the /v1 external send/template endpoints
 * (when called from a partner integration that an outbound webhook can
 * reach). Each entry point reads `X-CCP-Depth` from the inbound request,
 * drops at/above this ceiling, and propagates depth+1 into any work it
 * schedules. The in-process trigger_workflow `TRIGGER_DEPTH_MAX` uses the
 * same value so both chain axes share one ceiling.
 */
export const MAX_CHAIN_DEPTH = 8;

/**
 * Parse the inbound `X-CCP-Depth` header. Missing / non-numeric / negative
 * values fall back to 0 (top-level call). Bounded above by Number.MAX_SAFE_*
 * implicitly via Number.parseInt; we don't cap here so the caller can log
 * the actual value of an obviously-poisoned request before dropping it.
 */
export function parseChainDepth(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Wire-format envelope sent to http_request steps. Bump `version` on breaking changes. */
export interface WorkflowEventEnvelope<P = EventPayload> {
  version: 1;
  event: WorkflowTriggerEvent;
  teamId: string;
  occurredAt: string;
  data: P;
  /**
   * Cross-system chain depth. The `http_request` step stamps `X-CCP-Depth:
   * depth+1` on every outbound call; if an external system bounces back into
   * our per-workflow `incoming_webhook`, that handler reads the header, caps
   * it, and seeds the resulting run's envelope with the incremented value.
   * Bounds the http_request → external → incoming_webhook → http_request
   * cycle that the in-process trigger_workflow depth-cap can't see across the
   * HTTP boundary (audit 2026-05-22). 0 for top-level / non-chained runs.
   */
  depth?: number;
  /**
   * In-process workflow-chain depth. Incremented by every `trigger_workflow`
   * step. Bounded by `TRIGGER_DEPTH_MAX` (see `steps/trigger-workflow.ts`).
   * Stored on every CHAINED run's `eventPayload._workflowDepth` regardless
   * of the chained workflow's trigger event — so a chain through a
   * non-`manual_trigger` workflow doesn't reset the counter. 0 for top-
   * level user-initiated runs.
   */
  workflowDepth?: number;
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
  /** Channel this message came through (`meta_cloud` = WhatsApp today).
   *  Always present — every message row carries a non-null channel — so
   *  authors branch on it directly instead of inferring from the contact
   *  (whose `identityChannel` is null for phone-keyed WhatsApp contacts).
   *  Mirrors @ccp/shared/workflows/events. */
  channel: Channel;
  direction: "in" | "out";
  body: string;
  mediaKind: MediaKind | null;
  mediaCaption: string | null;
  timestamp: string;
  senderUserId: string | null;
  // PR 2.4 additions — all optional so existing callers keep working.
  // Builders compute the derivable ones (hasMedia from mediaKind) and
  // accept the JOINed ones (senderName) when the call site has the data.
  /** Display name of whoever sent this message. Contact name for inbound,
   *  Agent name for outbound. Resolves to empty string when the call site
   *  didn't supply it. */
  senderName?: string | null;
  /** Public CDN URL of the media binary, or null for text-only messages. */
  mediaUrl?: string | null;
  /** Convenience boolean — true when mediaKind is set. */
  hasMedia?: boolean;
}

export interface WorkflowConversationSnapshot {
  id: string;
  /** Channel this thread lives on (`meta_cloud` = WhatsApp). Source of truth
   *  for the conversation's channel — mirrors Conversation.channel. */
  channel: Channel;
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
  // PR 2.4 additions — both derivable / loadable on demand.
  /** True when unreadCount > 0. Convenience for branch conditions. */
  hasUnread?: boolean;
  /** Full agent object when the call site JOINed User on assignedUserId.
   *  Null when no agent is assigned OR the call site didn't load it. */
  assignedAgent?: WorkflowUserSnapshot | null;
}

export interface WorkflowContactSnapshot {
  id: string;
  phoneNumber: string | null;
  identityChannel: Channel | null;
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
  createdAt?: string;
  // PR 2.4 additions — loadable / derivable on demand. None of these are
  // required at the builder boundary; the call site passes them when it
  // has the data, else they resolve to null/empty in tokens.
  /** ISO of the latest inbound timestamp on this contact. Drives
   *  windowState below and exposes a stable token for "have they
   *  messaged us recently?" branching. */
  lastInboundAt?: string | null;
  /** WhatsApp 24h customer-service window state. Computed inside the
   *  builder from lastInboundAt; one of "open" | "closing-soon" |
   *  "closed" | "never". Always present on the snapshot when
   *  lastInboundAt is supplied. */
  windowState?: "open" | "closing-soon" | "closed" | "never";
  /** Tag display names parallel to `tagIds`. Same order. Loaded only when
   *  the call site JOINed Tag rows. */
  tagNames?: string[];
  /** Lifecycle stage display name. Loaded when the call site JOINed Stage. */
  stageName?: string | null;
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
  channel: Channel;
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
  // PR 2.4 input — populated when the call site JOINed User.
  assignedUser?: { id: string; name: string; email: string } | null;
}): WorkflowConversationSnapshot {
  return {
    id: c.id,
    channel: c.channel,
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
    hasUnread: c.unreadCount > 0,
    assignedAgent: c.assignedUser
      ? { id: c.assignedUser.id, name: c.assignedUser.name, email: c.assignedUser.email }
      : null,
  };
}

/**
 * Build a {@link WorkflowConversationSnapshot} from a Conversation row whose
 * status/assignment was just flipped by an `assignConversation` call, with
 * the analytics writes the `analytics` subscriber will apply on
 * `conversation.assigned` predicted in-memory so workflow-dispatch sees the
 * post-everything snapshot without a fresh DB read.
 *
 * Predicted fields mirror `trackOnAssigned` in lib/conversations/analytics.ts:
 *   - `assignmentsCount` incremented when the new assignee differs from the
 *     previous AND the new assignee is non-null (pure unassign doesn't count).
 *   - `lastAssignedAt` set to now under the same gate.
 *   - `firstAssignedAt` / `firstAssignedUserId` set only when previously null.
 *
 * `c` is the row as returned by the CAS update — already carries the new
 * `assignedUserId` and `status`.
 */
export function workflowConversationSnapshotAfterAssign(
  c: Parameters<typeof workflowConversationSnapshot>[0],
  previousAssignedUserId: string | null,
): WorkflowConversationSnapshot {
  const newAssignedUserId = c.assignedUserId;
  const assigneeChanged = newAssignedUserId !== previousAssignedUserId;
  const countsAsAssignment = assigneeChanged && newAssignedUserId !== null;
  const now = new Date();
  return workflowConversationSnapshot({
    ...c,
    ...(countsAsAssignment
      ? {
          assignmentsCount: (c.assignmentsCount ?? 0) + 1,
          lastAssignedAt: now,
          ...(c.firstAssignedAt == null
            ? { firstAssignedAt: now, firstAssignedUserId: newAssignedUserId }
            : {}),
        }
      : {}),
  });
}

/**
 * Build a {@link WorkflowConversationSnapshot} for a `conversation.status_changed`
 * publish, predicting the analytics writes that `trackOnStatusChanged` (in
 * lib/conversations/analytics.ts) will apply. Workflow-dispatch reads from the
 * snapshot so the post-everything values are visible without a fresh DB read.
 *
 * Predicted fields:
 *   - newStatus === "closed":  `closedAt` = now, `closedByUserId` = `changedByUserId`,
 *     and `closedCategory` / `closedSummary` from the event (when supplied).
 *   - previousStatus === "closed" (reopen): nullify all four close fields.
 *
 * `c` is the row state with the NEW status already applied (callers pass the
 * row from their CAS-update return, OR the pre-flip row with the new status
 * spread in).
 */
export function workflowConversationSnapshotAfterStatusChange(
  c: Parameters<typeof workflowConversationSnapshot>[0],
  args: {
    previousStatus: ConversationStatus;
    changedByUserId: string | null;
    closedCategory?: string | null;
    closedSummary?: string | null;
  },
): WorkflowConversationSnapshot {
  const newStatus = c.status;
  const now = new Date();
  let closeOverrides: Partial<Parameters<typeof workflowConversationSnapshot>[0]> = {};
  if (newStatus === "closed") {
    closeOverrides = {
      closedAt: now,
      closedByUserId: args.changedByUserId,
      ...(args.closedCategory !== undefined ? { closedCategory: args.closedCategory } : {}),
      ...(args.closedSummary !== undefined ? { closedSummary: args.closedSummary } : {}),
    };
  } else if (args.previousStatus === "closed") {
    closeOverrides = {
      closedAt: null,
      closedByUserId: null,
      closedCategory: null,
      closedSummary: null,
    };
  }
  return workflowConversationSnapshot({
    ...c,
    ...closeOverrides,
  });
}

export function workflowContactSnapshot(c: {
  id: string;
  phoneNumber: string | null;
  identityChannel?: Channel | null;
  externalContactId?: string | null;
  name: string;
  email?: string | null;
  stageId?: string | null;
  tags?: Array<{ id: string; name?: string }>;
  customFields?: unknown;
  firstName?: string | null;
  lastName?: string | null;
  language?: string | null;
  countryCode?: string | null;
  avatarUrl?: string | null;
  location?: string | null;
  createdAt?: Date | string | null;
  // PR 2.4 inputs — all optional.
  lastInboundAt?: Date | string | null;
  stage?: { name: string } | null;
}): WorkflowContactSnapshot {
  const tags = c.tags ?? [];
  const tagIds = tags.map((t) => t.id);
  const tagNamesRaw = tags
    .map((t) => t.name)
    .filter((n): n is string => typeof n === "string");
  // tagNames is only meaningful when EVERY tag came with a name; mixing
  // some-with some-without would produce a misaligned parallel array that
  // breaks `tagNames[i] == tagIds[i]` assumptions.
  const tagNames = tagNamesRaw.length === tags.length ? tagNamesRaw : undefined;
  const lastInboundAtIso =
    c.lastInboundAt instanceof Date
      ? c.lastInboundAt.toISOString()
      : c.lastInboundAt ?? null;
  // Inline window-state compute — same 24h / closing-soon logic as
  // @ccp/shared/utils/window's computeWindowStatus, but duplicated here to
  // avoid pulling the whole shared helper into the events module. Drift is
  // a non-issue because both anchor on a hardcoded 24h / 4h pair.
  const windowState = computeWindowStateFromIso(lastInboundAtIso ?? null);
  return {
    id: c.id,
    phoneNumber: c.phoneNumber,
    identityChannel: c.identityChannel ?? null,
    externalContactId: c.externalContactId ?? null,
    name: c.name,
    email: c.email ?? null,
    stageId: c.stageId ?? null,
    tagIds,
    customFields: normalizeCustomFields(c.customFields),
    firstName: c.firstName ?? null,
    lastName: c.lastName ?? null,
    language: c.language ?? null,
    countryCode: c.countryCode ?? null,
    avatarUrl: c.avatarUrl ?? null,
    location: c.location ?? null,
    createdAt:
      c.createdAt instanceof Date
        ? c.createdAt.toISOString()
        : c.createdAt ?? undefined,
    ...(lastInboundAtIso !== null ? { lastInboundAt: lastInboundAtIso } : {}),
    windowState,
    ...(tagNames ? { tagNames } : {}),
    stageName: c.stage?.name ?? null,
  };
}

const WINDOW_MS = 24 * 60 * 60 * 1000;
const WINDOW_CLOSING_SOON_MS = 4 * 60 * 60 * 1000;

function computeWindowStateFromIso(
  iso: string | null,
): "open" | "closing-soon" | "closed" | "never" {
  if (!iso) return "never";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "never";
  const remaining = ms + WINDOW_MS - Date.now();
  if (remaining <= 0) return "closed";
  if (remaining <= WINDOW_CLOSING_SOON_MS) return "closing-soon";
  return "open";
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
