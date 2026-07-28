import type {
  ConversationStatus,
  MediaKind,
  Channel,
} from "../types";

/**
 * Snapshot shapes for workflow event payloads — leaner than full DB rows,
 * just the fields workflow authors filter on or feed an AI.
 *
 * Lives in the shared package because they're referenced by
 * `packages/shared/src/events/types.ts` (the domain-event taxonomy that
 * both NestJS publishers and the FE realtime client need to type
 * payloads). The factory functions that build these snapshots from
 * Prisma rows stay server-side at `lib/workflows/events.ts` (and will
 * move into `apps/api/src/workflows/` in step 5).
 *
 * Adding fields is non-breaking (downstream parses JSON); removing them
 * IS breaking — hence the `version: 1` marker used by serializers.
 */

export interface WorkflowMessageSnapshot {
  id: string;
  conversationId: string;
  externalId: string;
  /** Channel this message came through (`meta_cloud` = WhatsApp today).
   *  Always present — every message row carries a non-null channel — so
   *  authors can branch "is this from WhatsApp" without inferring it from
   *  the contact. The contact-level `identityChannel` is null for phone-
   *  keyed (WhatsApp) contacts, so this is the reliable per-message source. */
  channel: Channel;
  direction: "in" | "out";
  body: string;
  mediaKind: MediaKind | null;
  mediaCaption: string | null;
  /**
   * Interactive reply payload — set when this inbound message is the customer
   * tapping a button / list option. `id` is what the `message_received` trigger's
   * `option_id` condition resolves to. Absent for plain text / media messages.
   */
  interactive?: { kind: string; id: string; title: string };
  timestamp: string;
  senderUserId: string | null;
}

export interface WorkflowConversationSnapshot {
  id: string;
  /** Channel this thread lives on (`meta_cloud` = WhatsApp). Source of truth
   *  for the conversation's channel — see Conversation.channel. */
  channel: Channel;
  /**
   * WHICH of the workspace's accounts on that channel this thread belongs to
   * (the `ChannelConnection` id) — the specific WhatsApp number, Facebook Page
   * or Instagram handle the customer is talking to.
   *
   * `channel` alone is not enough to act on a multi-account workspace. It is
   * what lets a workflow branch on "this came in on the Sales number" and what
   * the outbound-webhook envelope reports as `channel.id`; before this existed
   * that envelope resolved the workspace's DEFAULT account for the channel, so
   * every partner integration was told the wrong number.
   *
   * Null when the thread predates account binding or the channel has no
   * connected account (webchatwidget keeps its config elsewhere).
   */
  channelConnectionId?: string | null;
  status: ConversationStatus;
  assignedUserId: string | null;
  /** AI Autopilot state. Surfaced as `ai_enabled` on the message.received /
   *  message.sent outbound webhook. Optional / defaults true. */
  aiEnabled?: boolean;
  unreadCount: number;
  lastMessageAt: string;
  firstAssignedAt: string | null;
  firstAssignedUserId: string | null;
  lastAssignedAt: string | null;
  firstResponseAt: string | null;
  firstResponseByUserId: string | null;
  closedAt: string | null;
  closedByUserId: string | null;
  /** API-key actor that closed the conversation (mirrors closedByUserId for
   *  /v1 + workflow closes). Null on reopen / user-driven closes. */
  closedByApiKeyId?: string | null;
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
  identityChannel: Channel | null;
  externalContactId: string | null;
  name: string;
  email: string | null;
  stageId: string | null;
  tagIds: string[];
  customFields: Record<string, string>;
  // Additive fields — populated where the snapshot builder has the data;
  // legacy callers leave them undefined. The outbound-webhooks mapper reads
  // these via cast in `contactFromSnapshot`.
  firstName?: string | null;
  lastName?: string | null;
  language?: string | null;
  countryCode?: string | null;
  avatarUrl?: string | null;
  location?: string | null;
  createdAt?: string;
}
