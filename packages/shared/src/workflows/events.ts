import type {
  ConversationStatus,
  MediaKind,
  ProviderName,
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
   *  Always present — every message row carries a non-null provider — so
   *  authors can branch "is this from WhatsApp" without inferring it from
   *  the contact. The contact-level `identityProvider` is null for phone-
   *  keyed (WhatsApp) contacts, so this is the reliable per-message source. */
  provider: ProviderName;
  direction: "in" | "out";
  body: string;
  mediaKind: MediaKind | null;
  mediaCaption: string | null;
  timestamp: string;
  senderUserId: string | null;
}

export interface WorkflowConversationSnapshot {
  id: string;
  /** Channel this thread lives on (`meta_cloud` = WhatsApp). Source of truth
   *  for the conversation's channel — see Conversation.provider. */
  provider: ProviderName;
  status: ConversationStatus;
  assignedUserId: string | null;
  unreadCount: number;
  lastMessageAt: string;
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
