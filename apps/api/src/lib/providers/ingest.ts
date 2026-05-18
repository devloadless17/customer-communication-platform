import "server-only";

import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { ensureDefaultStage } from "@/lib/queries";
import type {
  WorkflowContactSnapshot,
  WorkflowConversationSnapshot,
  WorkflowMessageSnapshot,
} from "@/lib/workflows/events";
import type {
  NormalizedEvent,
  NormalizedInboundMessage,
  NormalizedStatusUpdate,
} from "@ccp/shared/providers/types";
import type {
  Contact,
  Conversation,
  ConversationStatus,
  ConversationWithRefs,
  MediaKind,
  Message,
  ProviderName,
  ReplySnapshot,
} from "@ccp/shared/types";

/**
 * Provider-agnostic ingest pipeline.
 *
 *   normalized event → dedupe → upsert contact/conversation → create message
 *                    → bump conversation summary → emit `message:new`
 *
 * One entry point per route. Routes never touch the DB or Socket.io directly.
 *
 * `teamId` is resolved by the caller (the per-team webhook URL contains it,
 * so the route trusts it). Status updates ignore teamId — they look up the
 * existing message row by externalId, which already carries its own team.
 */

export async function ingestEvents(
  teamId: string,
  provider: ProviderName,
  events: NormalizedEvent[],
): Promise<void> {
  if (events.length === 0) return;

  // Process events in parallel. They're independent at the DB layer (each
  // has its own externalId-keyed dedupe gate via the P2002 catch), so the
  // sequential `for await` here was pure latency tax — Meta's webhook
  // timeout is ~5s and a 10-event batch at ~6 DB roundtrips each was
  // 800ms-1.5s blocking the 200. Each event is wrapped in its own try
  // so one bad row doesn't make Meta retry the whole batch.
  await Promise.all(
    events.map(async (evt) => {
      try {
        if (evt.kind === "message") {
          await ingestInboundMessage(teamId, provider, evt);
        } else {
          await ingestStatusUpdate(teamId, provider, evt);
        }
      } catch (err) {
        // Structured log — fields chosen so a flood of identical errors is
        // greppable as a single event in ops (key = teamId+kind+code).
        // Stack included so a real bug isn't hidden, but never the raw
        // body / phone number (those live in `rawPayload` on the message
        // row for forensic queries that go through DB, not log search).
        const externalId =
          "externalId" in evt ? evt.externalId : undefined;
        console.error(
          JSON.stringify({
            event: "ingest.event_failed",
            severity: "error",
            teamId,
            provider,
            kind: evt.kind,
            externalId,
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          }),
        );
        // Swallow — Meta retries the whole batch on a non-200, and the
        // unique-index gate makes successful sibling events safe to re-run.
        // The detached automation dispatch, however, would fire twice on a
        // retry. Returning 200 to Meta even when a single event blows up
        // is the lesser evil.
      }
    }),
  );
}

async function ingestStatusUpdate(
  teamId: string,
  provider: ProviderName,
  evt: NormalizedStatusUpdate,
): Promise<void> {
  // (teamId, provider, externalId) is the compound unique key post the
  // multi-channel refactor. teamId + provider come from the webhook route
  // (the URL is per-team and the route is per-provider); the wire payload
  // carries only the externalId.
  const existing = await db.message.findUnique({
    where: {
      teamId_provider_externalId: {
        teamId,
        provider,
        externalId: evt.externalId,
      },
    },
    select: { id: true, teamId: true, conversationId: true, status: true },
  });
  // Status arriving for an unknown message: classic race where Meta delivers
  // `sent`/`delivered`/`read` for an outbound BEFORE our create-message path
  // has committed the row. Park the status in a short-TTL replay map; when
  // the message row is created (`createOutboundMessageIdempotent` below)
  // it drains the parked status and applies it. After TTL we drop — at that
  // point either the create failed permanently or Meta's clock is way off.
  if (!existing) {
    parkUnknownWamidStatus(teamId, provider, evt.externalId, evt.status);
    return;
  }

  // `failed` is terminal and must transition from ANY non-failed state —
  // Meta can deliver a failure async after a `delivered`/`read`. The
  // monotonic rank-guard below was silently dropping these and leaving
  // the agent unaware the send actually broke.
  if (
    evt.status !== "failed" &&
    statusRank(evt.status) <= statusRank(existing.status as Message["status"])
  ) {
    return;
  }

  await db.message.update({
    where: { id: existing.id },
    data: { status: evt.status },
  });

  await publish({
    type: "message.status_changed",
    teamId: existing.teamId,
    conversationId: existing.conversationId,
    messageId: existing.id,
    status: evt.status,
  });
}

/**
 * Park-and-replay table for status updates that arrived before the message
 * row was committed. Keyed by `(teamId|provider|externalId)`; entries
 * self-expire after TTL so memory stays bounded even if the create never
 * happens. Bounded LRU-ish via insertion-order eviction on cap.
 *
 * Process-local — fine for a single api container. If we ever run two
 * api processes, an outbound created on instance A whose status webhook
 * lands on instance B would lose the replay; revisit when that's a real
 * possibility (move to Redis).
 */
const UNKNOWN_WAMID_TTL_MS = 5 * 60_000;
const UNKNOWN_WAMID_MAX = 1_000;
const unknownWamidStatuses = new Map<
  string,
  { status: Message["status"]; exp: number }
>();

function parkKey(
  teamId: string,
  provider: ProviderName,
  externalId: string,
): string {
  return `${teamId}|${provider}|${externalId}`;
}

function parkUnknownWamidStatus(
  teamId: string,
  provider: ProviderName,
  externalId: string,
  status: Message["status"],
): void {
  const now = Date.now();
  // Opportunistic eviction of expired entries.
  if (unknownWamidStatuses.size >= UNKNOWN_WAMID_MAX) {
    for (const [k, v] of unknownWamidStatuses) {
      if (v.exp <= now) unknownWamidStatuses.delete(k);
    }
    // If still over cap, drop oldest.
    if (unknownWamidStatuses.size >= UNKNOWN_WAMID_MAX) {
      const oldest = unknownWamidStatuses.keys().next().value;
      if (oldest !== undefined) unknownWamidStatuses.delete(oldest);
    }
  }
  const key = parkKey(teamId, provider, externalId);
  const existing = unknownWamidStatuses.get(key);
  // If a higher-rank status is already parked, keep it — except `failed`
  // which always wins (terminal). Mirrors the live status guard above.
  if (existing && status !== "failed") {
    if (statusRank(status) <= statusRank(existing.status)) return;
  }
  unknownWamidStatuses.set(key, { status, exp: now + UNKNOWN_WAMID_TTL_MS });
}

/**
 * Called from the outbound create path immediately after the Message row
 * commits. If a status update arrived for this wamid before us, apply it
 * now so the row isn't stuck at the create-time default.
 */
export async function drainParkedStatus(
  teamId: string,
  provider: ProviderName,
  externalId: string,
  messageId: string,
  conversationId: string,
): Promise<void> {
  const key = parkKey(teamId, provider, externalId);
  const parked = unknownWamidStatuses.get(key);
  if (!parked) return;
  unknownWamidStatuses.delete(key);
  if (parked.exp <= Date.now()) return;
  await db.message.update({
    where: { id: messageId },
    data: { status: parked.status },
  });
  await publish({
    type: "message.status_changed",
    teamId,
    conversationId,
    messageId,
    status: parked.status,
  });
}

/** Conversation-list preview text for media-only messages (no caption). */
export function mediaPreview(kind: import("@ccp/shared/types").MediaKind | undefined): string {
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

function statusRank(s: Message["status"]): number {
  switch (s) {
    case "failed":
      return -1;
    case "sent":
      return 0;
    case "delivered":
      return 1;
    case "read":
      return 2;
  }
}

async function ingestInboundMessage(
  teamId: string,
  provider: ProviderName,
  evt: NormalizedInboundMessage,
): Promise<void> {
  // Rule #3 dedupe gate. Cheap pre-check; the compound unique
  // (teamId, provider, externalId) is the actual race guard via the P2002
  // catch below.
  const existing = await db.message.findUnique({
    where: {
      teamId_provider_externalId: {
        teamId,
        provider,
        externalId: evt.externalId,
      },
    },
    select: { id: true },
  });
  if (existing) return;

  // Resolve the quoted-reply target (if any). We only set the FK when the
  // original lives in OUR DB — Meta sometimes references messages older than
  // our subscription (no history sync, CLAUDE.md), in which case the reply
  // arrives without a quote anchor and we just drop the link.
  let replySnapshot: ReplySnapshot | null = null;
  if (evt.replyToExternalId) {
    replySnapshot = await loadReplySnapshotByExternalId(evt.replyToExternalId, {
      teamId,
      provider,
    });
  }

  // Name policy: set on CREATE, sticky after.
  //
  // We used to refresh the name from Meta's wa profile on every inbound, but
  // that clobbered names an agent had typed in manually ("Ahmad" got
  // overwritten by the customer's WhatsApp display name "احمد م." or
  // similar). The right semantic for a CRM-style inbox is: the agent owns
  // the contact name; if Meta sends a profile name on first contact we use
  // it as a sensible default, but subsequent profile changes don't override.
  // Resolved on every inbound — the helper short-circuits to a cheap
  // findFirst when a default already exists, so the cost is one indexed
  // lookup. We pass it as the `create` stageId so brand-new contacts land
  // in the team's default; existing rows pass through `update` (empty) and
  // keep whatever stage they're already in.
  const defaultStageId = await ensureDefaultStage(teamId);

  // Contact + conversation resolution must be transactional. Without a tx,
  // two simultaneous first-time inbounds from the same brand-new phone both
  // see `findFirst({ status: { not: "closed" } }) === null` and both
  // `conversation.create()` succeed — producing duplicate conversation rows
  // for one contact. The contact upsert is already race-safe via the
  // `teamId_phoneNumber` unique, but the conversation lookup-then-create
  // pattern is the classic check-then-act race.
  //
  // We use `Serializable` because the read of "is there an open conversation?"
  // must be conflict-protected against another tx's create. Postgres returns
  // P2034 (serialization failure) on conflict; we retry once. Two retries is
  // a sensible ceiling — by then the contention is real, not a fluke.
  const { contact, conversation, isNewConversation, reopened } = await runWithSerializableRetry(
    async () => {
      const contact = await db.contact.upsert({
        where: { teamId_phoneNumber: { teamId, phoneNumber: evt.contactPhone } },
        create: {
          teamId,
          phoneNumber: evt.contactPhone,
          name: evt.contactName ?? evt.contactPhone,
          stageId: defaultStageId,
        },
        update: {
          // Intentionally empty: do NOT touch the name OR the stage. The
          // agent's manually entered name (or the first-contact profile
          // name) stays put, and a contact who progressed past the default
          // stage isn't pulled back to it just because they sent another
          // message.
        },
      });

      // Strict invariant: one contact = one conversation, forever. If the
      // contact has any prior conversation (including closed), reuse it.
      // Closed → pending on a new inbound, so the thread "reopens" in the
      // agent's inbox rather than fragmenting history across multiple rows.
      // Only when a contact has literally never had a conversation do we
      // create one.
      const existingConvo = await db.conversation.findFirst({
        where: { teamId, contactId: contact.id },
        orderBy: { lastMessageAt: "desc" },
      });
      const isNewConversation = !existingConvo;
      let conversation = existingConvo;
      let reopened = false;
      if (!conversation) {
        conversation = await db.conversation.create({
          data: {
            teamId,
            contactId: contact.id,
            // New chats land in `pending` so they sit in the triage column
            // until an agent claims them (→ open) or closes them out.
            status: "pending",
            lastMessageAt: evt.timestamp,
            lastMessagePreview: "",
          },
        });
      } else if (conversation.status === "closed") {
        // Reopen. We bump to `pending` (matches the new-thread default) so
        // the conversation re-enters the triage column instead of jumping
        // straight to `open`, which would imply an agent has it.
        conversation = await db.conversation.update({
          where: { id: conversation.id },
          data: { status: "pending" },
        });
        reopened = true;
      }
      return { contact, conversation, isNewConversation, reopened };
    },
  );

  const preview = (evt.body.trim() || mediaPreview(evt.media?.kind)).slice(0, 200);

  // When media is still being fetched in the background (the webhook now
  // ingests-fast and downloads after returning to Meta), we persist the
  // kind/mime/caption/filename/duration so the bubble can render a typed
  // placeholder immediately. The mediaKey + mediaUrl + mediaSizeBytes columns
  // stay null until the binary lands and the webhook UPDATEs the row.
  const mediaPending = Boolean(
    evt.media && !(evt.media.storageKey && evt.media.storageUrl),
  );

  let createdId: string;
  try {
    const created = await db.message.create({
      data: {
        teamId,
        conversationId: conversation.id,
        externalId: evt.externalId,
        senderUserId: null,
        body: evt.body,
        direction: "in",
        provider,
        status: "delivered",
        rawPayload: evt.rawPayload as Prisma.InputJsonValue,
        timestamp: evt.timestamp,
        ...(replySnapshot ? { replyToMessageId: replySnapshot.id } : {}),
        ...(evt.media
          ? {
              mediaKind: evt.media.kind,
              mediaMimeType: evt.media.mimeType,
              mediaCaption: evt.body || null,
              mediaFilename: evt.media.filename ?? null,
              mediaDurationMs: evt.media.durationMs ?? null,
              ...(evt.media.storageKey && evt.media.storageUrl
                ? {
                    mediaKey: evt.media.storageKey,
                    mediaUrl: evt.media.storageUrl,
                    mediaSizeBytes: evt.media.sizeBytes ?? null,
                  }
                : {}),
            }
          : {}),
      },
    });
    createdId = created.id;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Race: another worker won the insert. Drop without side effects.
      return;
    }
    throw err;
  }

  // Two independent post-create writes — issue them in parallel so the
  // socket-emit (downstream of this function) starts ~20-40ms sooner.
  //   1. conversation bump (lastMessageAt + preview + unread/incoming counters)
  //   2. contact.lastInboundAt denorm (read by getConversationWithRefs in the
  //      thread-open hot path; monotonic guard so a delayed older event can't
  //      roll the column backwards)
  await Promise.all([
    db.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: evt.timestamp,
        lastMessagePreview: preview,
        unreadCount: { increment: 1 },
        incomingMessagesCount: { increment: 1 },
      },
    }),
    db.contact.updateMany({
      where: {
        id: contact.id,
        OR: [{ lastInboundAt: null }, { lastInboundAt: { lt: evt.timestamp } }],
      },
      data: { lastInboundAt: evt.timestamp },
    }),
  ]);

  const message: Message = {
    id: createdId,
    teamId,
    conversationId: conversation.id,
    externalId: evt.externalId,
    senderUserId: null,
    body: evt.body,
    direction: "in",
    provider,
    status: "delivered",
    // raw_payload stays in the DB row (created above) but is deliberately
    // left off the socket payload — no client needs the verbatim Meta body.
    timestamp: evt.timestamp.toISOString(),
    ...(replySnapshot
      ? { replyToMessageId: replySnapshot.id, replyTo: replySnapshot }
      : {}),
    ...(evt.media
      ? {
          media: {
            kind: evt.media.kind,
            // Still served through our route so the team-ownership check
            // runs before the 302 to the CDN. 404s while mediaPending is
            // true; the bubble checks that flag and renders a placeholder
            // instead of attempting to load the URL.
            url: `/api/media/${createdId}`,
            mimeType: evt.media.mimeType,
            sizeBytes: evt.media.sizeBytes ?? 0,
            ...(evt.body ? { caption: evt.body } : {}),
            ...(evt.media.filename ? { filename: evt.media.filename } : {}),
            ...(evt.media.durationMs != null ? { durationMs: evt.media.durationMs } : {}),
          },
          ...(mediaPending ? { mediaPending: true } : {}),
        }
      : {}),
  };

  // Build the ConversationWithRefs payload only when the convo is brand-new,
  // so clients that don't yet have it can splice the row in without refetch.
  const newConversation: ConversationWithRefs | undefined = isNewConversation
    ? {
        conversation: toDomainConversation({
          ...conversation,
          lastMessageAt: evt.timestamp,
          lastMessagePreview: preview,
          unreadCount: 1,
        }),
        contact: toDomainContact(contact),
        assignedUser: null,
        messages: [],
        notes: [],
        // The webhook event we're processing IS an inbound, so the 24h
        // window opens right now.
        lastInboundAt: evt.timestamp.toISOString(),
      }
    : undefined;

  const conversationSnapshot = toWorkflowConversation({
    ...conversation,
    lastMessageAt: evt.timestamp,
    unreadCount: (conversation.unreadCount ?? 0) + 1,
  });
  const contactSnapshot = toWorkflowContact(contact);
  const workflowMessage = toWorkflowMessage({
    id: createdId,
    conversationId: conversation.id,
    externalId: evt.externalId,
    senderUserId: null,
    body: evt.body,
    direction: "in",
    mediaKind: evt.media?.kind ?? null,
    mediaCaption: evt.media && evt.body ? evt.body : null,
    timestamp: evt.timestamp,
  });
  // Recent thread context for the workflow `message_received` trigger.
  // Loaded HERE (not in the subscriber) so the event payload is complete and
  // any downstream subscriber — including Phase 3's outbound webhook
  // deliverer — gets the same context without a second DB round-trip.
  const recentMessages = await loadRecentForWorkflow(conversation.id, createdId);

  // Single publish — socket fanout, audit, analytics, and workflow dispatch
  // all run as subscribers in registration order (see lib/events/subscribers).
  // The `reopened` flag lets socket-fanout emit the secondary
  // `conversation:status → pending` event that previously lived inline here.
  //
  // We deliberately do NOT await: socket-fanout is sync (microseconds) and
  // fires before the next line; workflow-dispatch hits Pg + Redis, which on
  // a degraded backend could stall the webhook 200 long enough that Meta
  // retries the whole batch. Matches the prior code's `void (async () => …)`
  // semantics — errors are captured per-subscriber inside the bus.
  void publish({
    type: "message.received",
    teamId,
    conversationId: conversation.id,
    message,
    contact: contactSnapshot,
    conversation: conversationSnapshot,
    workflowMessage,
    isNewConversation,
    reopened,
    ...(newConversation ? { newConversation } : {}),
    preview,
    lastMessageAt: evt.timestamp.toISOString(),
    unreadDelta: 1,
    recentMessages,
  }).catch((err) => {
    console.error(
      `[ingest] publish(message.received) failed for team=${teamId} msg=${createdId}:`,
      err instanceof Error ? err.message : err,
    );
  });
}

// ---------------------------------------------------------------------------
// Workflow payload mappers — kept local. Each maps a DB-shaped object to
// the trimmed snapshot the workflows subsystem consumes. Three mappers, no
// hidden behavior — fine to copy here vs. building a shared utility.
// ---------------------------------------------------------------------------

function toWorkflowMessage(m: {
  id: string;
  conversationId: string;
  externalId: string;
  direction: "in" | "out";
  body: string;
  mediaKind: import("@ccp/shared/types").MediaKind | null;
  mediaCaption: string | null;
  timestamp: Date;
  senderUserId: string | null;
}): WorkflowMessageSnapshot {
  return {
    id: m.id,
    conversationId: m.conversationId,
    externalId: m.externalId,
    direction: m.direction,
    body: m.body,
    mediaKind: m.mediaKind,
    mediaCaption: m.mediaCaption,
    timestamp: m.timestamp.toISOString(),
    senderUserId: m.senderUserId,
  };
}

function toWorkflowConversation(c: {
  id: string;
  status: string;
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
    status: c.status as WorkflowConversationSnapshot["status"],
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

function toWorkflowContact(c: {
  id: string;
  phoneNumber: string | null;
  identityProvider?: ProviderName | null;
  externalContactId?: string | null;
  name: string;
  email?: string | null;
  stageId?: string | null;
  tags?: Array<{ id: string }>;
  customFields?: unknown;
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
  };
}

/** Pull the most recent N messages on the conversation, excluding the trigger
 *  message itself. Surfaced in MessageReceivedPayload.recentMessages so a
 *  downstream AI flow has short-term context without a callback. */
async function loadRecentForWorkflow(
  conversationId: string,
  excludeMessageId: string,
): Promise<WorkflowMessageSnapshot[]> {
  const rows = await db.message.findMany({
    where: { conversationId, NOT: { id: excludeMessageId } },
    orderBy: { timestamp: "desc" },
    take: 10,
    select: {
      id: true,
      conversationId: true,
      externalId: true,
      direction: true,
      body: true,
      mediaKind: true,
      mediaCaption: true,
      timestamp: true,
      senderUserId: true,
    },
  });
  return rows
    .map((r) => toWorkflowMessage({
      id: r.id,
      conversationId: r.conversationId,
      externalId: r.externalId,
      direction: r.direction as "in" | "out",
      body: r.body,
      mediaKind: r.mediaKind as import("@ccp/shared/types").MediaKind | null,
      mediaCaption: r.mediaCaption,
      timestamp: r.timestamp,
      senderUserId: r.senderUserId,
    }))
    .reverse(); // newest last
}

// ---------------------------------------------------------------------------
// Local mappers — duplicated from lib/queries.ts on purpose. queries.ts is
// `server-only` and concerned with read paths; ingest is also server-only,
// but pulling that import would couple two modules that should evolve
// independently. Three lines each, no risk of drift.
// ---------------------------------------------------------------------------

function toDomainConversation(c: {
  id: string;
  teamId: string;
  contactId: string;
  assignedUserId: string | null;
  status: string;
  unreadCount: number;
  lastMessageAt: Date;
  lastMessagePreview: string;
}): Conversation {
  return {
    id: c.id,
    teamId: c.teamId,
    contactId: c.contactId,
    assignedUserId: c.assignedUserId,
    status: c.status as ConversationStatus,
    unreadCount: c.unreadCount,
    lastMessageAt: c.lastMessageAt.toISOString(),
    lastMessagePreview: c.lastMessagePreview,
  };
}

function toDomainContact(c: {
  id: string;
  teamId: string;
  phoneNumber: string | null;
  identityProvider?: ProviderName | null;
  externalContactId?: string | null;
  name: string;
  avatarUrl: string | null;
  email?: string | null;
  location?: string | null;
  customFields?: unknown;
  source?: "inbound" | "manual";
}): Contact {
  return {
    id: c.id,
    teamId: c.teamId,
    phoneNumber: c.phoneNumber,
    identityProvider: c.identityProvider ?? null,
    externalContactId: c.externalContactId ?? null,
    name: c.name,
    avatarUrl: c.avatarUrl ?? undefined,
    email: c.email ?? undefined,
    location: c.location ?? undefined,
    customFields: normalizeCustomFields(c.customFields),
    // Webhook-driven contacts default to 'inbound' on the schema; the row
    // we read back may not always include it (legacy callers), so treat
    // missing as inbound.
    source: c.source ?? "inbound",
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

/**
 * Build a ReplySnapshot from the original message (looked up by externalId or
 * id). Used by ingest (inbound replies, externalId lookup) and the outbound
 * routes (where the caller already has the local id).
 */
export async function loadReplySnapshotByExternalId(
  externalId: string,
  scope: { teamId: string; provider: ProviderName },
): Promise<ReplySnapshot | null> {
  // Post the (teamId, provider, externalId) compound unique migration,
  // externalId alone isn't unique; pass the scope explicitly so cross-team
  // / cross-channel replies can't accidentally resolve to a different row.
  const row = await db.message.findUnique({
    where: {
      teamId_provider_externalId: {
        teamId: scope.teamId,
        provider: scope.provider,
        externalId,
      },
    },
    select: replySnapshotSelect,
  });
  return row ? toReplySnapshot(row) : null;
}

export async function loadReplySnapshotById(
  id: string,
): Promise<ReplySnapshot | null> {
  const row = await db.message.findUnique({
    where: { id },
    select: replySnapshotSelect,
  });
  return row ? toReplySnapshot(row) : null;
}

const replySnapshotSelect = {
  id: true,
  body: true,
  direction: true,
  mediaKind: true,
  sender: { select: { name: true } },
} as const;

function toReplySnapshot(row: {
  id: string;
  body: string;
  direction: string;
  mediaKind: string | null;
  sender: { name: string } | null;
}): ReplySnapshot {
  return {
    id: row.id,
    // Truncate so a giant pasted body doesn't bloat every reply emission.
    body: row.body.slice(0, 200),
    direction: row.direction as ReplySnapshot["direction"],
    senderName: row.sender?.name ?? null,
    ...(row.mediaKind ? { mediaKind: row.mediaKind as MediaKind } : {}),
  };
}

/**
 * Run `work` in a Serializable transaction, retrying once on Postgres
 * `40001` (serialization failure). Two concurrent webhook handlers ingesting
 * the first inbound from the same brand-new phone can race the
 * findFirst→create on `Conversation` — Serializable + a retry is the
 * cleanest fix without changing the schema (a partial unique on
 * `(teamId, contactId) WHERE status != 'closed'` would also work but
 * requires a migration).
 */
async function runWithSerializableRetry<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await db.$transaction(work, { isolationLevel: "Serializable" });
    } catch (err) {
      const isSerializationFailure =
        err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034";
      if (!isSerializationFailure || attempt === 1) throw err;
      // Brief jitter before retry to break the symmetric-conflict cycle.
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 20));
    }
  }
  // Unreachable — the loop either returns or throws.
  throw new Error("runWithSerializableRetry: exhausted retries");
}

