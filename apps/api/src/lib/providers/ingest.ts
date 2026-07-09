import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { runWithConcurrency } from "@/common/concurrency";
import { captureRemoteContactAvatar } from "@/lib/blob-storage/avatar";
import { getProviderBinding } from "@/lib/providers";
import { normalizeStringMap } from "@/lib/normalize-string-map";
import { publish } from "@/lib/events/bus";
import { kickOutbox, publishInTx } from "@/lib/events/outbox";
import { commitOutboundSend } from "@/lib/messaging/commit-outbound-send";
import { createOutboundMessageIdempotent } from "@/lib/messages/idempotent-create";
import { ingestCallEvent } from "@/lib/providers/ingest-call";
import { resolveCustomerId } from "@/lib/identity/identity-service";
import { ensureDefaultStage } from "@/lib/queries";
import {
  mapReplySnapshot,
  REPLY_TO_INCLUDE,
  toContactWire,
} from "@/lib/queries/_shared";
import {
  enqueueWorkflowInboundResume,
  getRedisConnection,
} from "@/lib/workflows/queue";
import type {
  WorkflowContactSnapshot,
  WorkflowConversationSnapshot,
  WorkflowMessageSnapshot,
} from "@/lib/workflows/events";
import { workflowConversationSnapshotAfterStatusChange } from "@/lib/workflows/events";
import { findAndConsumeAwaitingReplies } from "@/lib/workflows/resume-on-inbound";
import { sessionKindFromFlags } from "@ccp/shared/events/types";
import type {
  NormalizedContactSync,
  NormalizedEvent,
  NormalizedInboundMessage,
  NormalizedMessageCorrection,
  NormalizedOutboundEcho,
  NormalizedReaction,
  NormalizedReadWatermark,
  NormalizedStatusUpdate,
  NormalizedTemplateStatusUpdate,
} from "@ccp/shared/providers/types";
import type {
  Conversation,
  ConversationStatus,
  ConversationWithRefs,
  MediaKind,
  Message,
  Channel,
  ReplySnapshot,
  SocialProfile,
} from "@ccp/shared/types";
import { mediaPreviewLabel } from "@ccp/shared/types";
import { getCountryFromPhone } from "@ccp/shared/utils";
import { isPhoneChannel } from "@ccp/shared/providers/capabilities";

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
  channel: Channel,
  events: NormalizedEvent[],
): Promise<void> {
  if (events.length === 0) return;

  // Process events with BOUNDED parallelism. They're independent at the
  // DB layer (each has its own externalId-keyed dedupe gate via the P2002
  // catch), so a sequential `for await` would be pure latency tax. But
  // unbounded Promise.all on a 30-message Meta batch = 30 parallel
  // serializable transactions, which exhausts the Prisma pool (default
  // 25) and surfaces as P2024 → Meta retries → next batch is also 30 ×
  // serializable in a tighter race. Cap at 8 concurrent lanes so the
  // pool has headroom for unrelated REST traffic. Each event is wrapped
  // in its own try so one bad row doesn't make Meta retry the whole
  // batch.
  const INGEST_CONCURRENCY = 8;
  const queue = events.slice();
  const lanes = Math.min(INGEST_CONCURRENCY, queue.length);
  const runOne = async (evt: NormalizedEvent): Promise<void> => {
    try {
      if (evt.kind === "message") {
        await ingestInboundMessage(teamId, channel, evt);
      } else if (evt.kind === "echo") {
        // WhatsApp Coexistence: a message the owner sent from the phone app.
        await ingestOutboundEcho(teamId, channel, evt);
      } else if (evt.kind === "contact_sync") {
        // WhatsApp Coexistence: the owner's phone address book changed.
        await ingestContactSync(teamId, channel, evt);
      } else if (evt.kind === "reaction") {
        await ingestReaction(teamId, channel, evt);
      } else if (evt.kind === "message_correction") {
        await ingestMessageCorrection(teamId, channel, evt);
      } else if (evt.kind === "read_watermark") {
        await ingestReadWatermark(teamId, channel, evt);
      } else if (evt.kind === "template_status") {
        await ingestTemplateStatusUpdate(teamId, evt);
      } else if (evt.kind === "call") {
        // Kill-switch: calling (WhatsApp + Messenger) reaches browsers via
        // realtime WebRTC signaling. DISABLE_CALLING=1 (wired in docker-compose
        // api.environment) lets ops dark-stop call ingest for EVERY channel
        // WITHOUT a redeploy if a signaling bug surfaces — call webhooks become a
        // no-op (logged) while message ingest keeps flowing. Default OFF (calling
        // on), a pure opt-out lever. `DISABLE_WHATSAPP_CALLING` is still honored
        // for back-compat with an already-deployed env.
        if (
          process.env.DISABLE_CALLING === "1" ||
          process.env.DISABLE_WHATSAPP_CALLING === "1"
        ) {
          console.warn(
            JSON.stringify({
              event: "ingest.call_skipped_killswitch",
              severity: "warn",
              teamId,
              channel,
            }),
          );
        } else {
          await ingestCallEvent(teamId, channel, evt);
        }
      } else {
        await ingestStatusUpdate(teamId, channel, evt);
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
            channel,
            kind: evt.kind,
            externalId,
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          }),
        );
        // Transient infra faults (pool timeout, deadlock, DB unreachable)
        // must NOT be swallowed: re-throw so `ingestEvents` rejects, the
        // webhook controller returns 503, and Meta RE-DELIVERS the batch.
        // Every event is deduped on (teamId, channel, externalId) so re-
        // ingest is safe. The old code swallowed these and returned 200 —
        // Meta then never retried and the inbound customer message was lost
        // forever (Meta has no history sync). A retry can re-fire a sibling's
        // detached automation dispatch; that double-fire is the lesser evil
        // vs. silently dropping a customer message, and matches the webhook
        // controller's own transient→503 intent (which was previously
        // unreachable because this catch ate the error first).
        if (isTransientDbError(err)) throw err;
        // Genuine per-event poison (parse drift, invariant violation) stays
        // swallowed so a permanently-bad payload can't make Meta retry-storm.
      }
  };
  const runners = Array.from({ length: lanes }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) return;
      await runOne(next);
    }
  });
  await Promise.all(runners);
  // All inbound rows + their outbox events are now committed. Kick the drainer
  // to dispatch realtime + outbound-webhook fan-out NOW (~1ms) instead of
  // waiting out its poll — this is the inbound message → webhook/realtime path.
  // Pure latency win: if the drainer is mid-tick or unregistered, the poll
  // still drains these rows on its next cycle.
  kickOutbox();
}

/**
 * Transient DB faults that warrant asking Meta to re-deliver the batch
 * rather than silently dropping the event. Mirrors the codes the webhook
 * controller maps to 503, plus P2034 (write conflict / deadlock — retryable).
 * Anything else (parse drift, invariant violations, non-Prisma bugs) is
 * permanent per-event poison: swallowed so Meta doesn't retry-storm a payload
 * that will never succeed.
 */
export function isTransientDbError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return (
      err.code === "P2024" /* pool timeout */ ||
      err.code === "P2034" /* write conflict / deadlock */ ||
      err.code === "P1001" /* server unreachable */ ||
      err.code === "P1002" /* connection timeout */ ||
      err.code === "P1008" /* operation timeout */
    );
  }
  // DB unreachable at connect time surfaces as an init error, not a known
  // request error — also transient.
  return err instanceof Prisma.PrismaClientInitializationError;
}

/**
 * A customer reacted to (or un-reacted from) one of our messages. Find the
 * target message by its provider id and patch its `reaction` column, then fan
 * out `message.reaction_changed` to the thread. Idempotent: re-delivery of the
 * same reaction is a no-op (the value-equality guard), and a reaction to a
 * message we don't have (we never stored it, or it predates us) is dropped —
 * there's nothing to attach it to. UI-only: no workflow / outbound-webhook
 * fanout (a 👍 isn't a business event).
 */
async function ingestReaction(
  teamId: string,
  channel: Channel,
  evt: NormalizedReaction,
): Promise<void> {
  const target = await db.message.findUnique({
    where: {
      teamId_channel_externalId: {
        teamId,
        channel,
        externalId: evt.targetExternalId,
      },
    },
    select: { id: true, conversationId: true, reaction: true },
  });
  // Reaction to a message we don't have a row for — nothing to attach it to.
  if (!target) return;
  // No change (re-delivery, or a second identical reaction) — skip the write
  // AND the fanout so we don't churn a no-op socket frame.
  if (target.reaction === evt.emoji) return;

  await db.message.update({
    where: { id: target.id },
    data: { reaction: evt.emoji },
  });

  await publish({
    type: "message.reaction_changed",
    teamId,
    conversationId: target.conversationId,
    messageId: target.id,
    emoji: evt.emoji,
  });
}

/**
 * Apply a customer message unsend/edit (WhatsApp revoke·edit, Messenger/
 * Instagram unsend). Finds the target Message by (teamId, channel,
 * targetExternalId) and either tombstones it (`deletedAt`, body PRESERVED for
 * the record) or updates its body (`editedAt` + new body), then fans out
 * `message.updated` so viewers patch the bubble. Idempotent: a re-delivered
 * delete/edit that matches the current state is a no-op (skips the socket
 * churn). UI-only — no workflow/webhook fanout (a customer editing their own
 * message isn't a business event).
 */
async function ingestMessageCorrection(
  teamId: string,
  channel: Channel,
  evt: NormalizedMessageCorrection,
): Promise<void> {
  const target = await db.message.findUnique({
    where: {
      teamId_channel_externalId: { teamId, channel, externalId: evt.targetExternalId },
    },
    select: { id: true, conversationId: true, body: true, deletedAt: true },
  });
  // Correction for a message we never stored — nothing to patch.
  if (!target) return;
  // Already tombstoned (re-delivery) — skip write + fanout.
  if (evt.action === "delete" && target.deletedAt) return;

  const now = evt.timestamp;
  if (evt.action === "delete") {
    await db.message.update({
      where: { id: target.id },
      data: { deletedAt: now },
    });
    await publish({
      type: "message.updated",
      teamId,
      conversationId: target.conversationId,
      messageId: target.id,
      deletedAt: now.toISOString(),
      editedAt: null,
      body: null,
    });
    return;
  }
  // Edit: replace the body (no-op if identical) + mark edited.
  const newBody = evt.newBody ?? "";
  if (target.body === newBody) return;
  await db.message.update({
    where: { id: target.id },
    data: { body: newBody, editedAt: now },
  });
  await publish({
    type: "message.updated",
    teamId,
    conversationId: target.conversationId,
    messageId: target.id,
    deletedAt: null,
    editedAt: now.toISOString(),
    body: newBody,
  });
}

/**
 * Apply a social read watermark (Messenger / Instagram): mark every outbound
 * message to this customer at/before the watermark as `read` — the "Seen" state.
 * Reuses ingestStatusUpdate per matched message so the rank/CAS guard, the
 * monotonic status guard, and the realtime `message:status` fanout all apply
 * exactly as WhatsApp's per-message read path does.
 */
async function ingestReadWatermark(
  teamId: string,
  channel: Channel,
  evt: NormalizedReadWatermark,
): Promise<void> {
  const extId = evt.externalContactId;
  if (!extId) return;
  const contact = await db.contact.findFirst({
    where: { teamId, identityChannel: channel, externalContactId: extId, deletedAt: null },
    select: { id: true },
  });
  if (!contact) return;
  const conversation = await db.conversation.findFirst({
    where: { teamId, contactId: contact.id },
    select: { id: true },
  });
  if (!conversation) return;
  // Outbound messages the customer just saw that aren't already `read`.
  const msgs = await db.message.findMany({
    where: {
      teamId,
      conversationId: conversation.id,
      direction: "out",
      timestamp: { lte: evt.watermark },
      status: { in: ["sent", "delivered"] },
    },
    select: { externalId: true },
  });
  for (const m of msgs) {
    if (!m.externalId) continue;
    await ingestStatusUpdate(teamId, channel, {
      kind: "status",
      externalId: m.externalId,
      status: "read",
      timestamp: evt.watermark,
      rawPayload: evt.rawPayload,
    });
  }
}

async function ingestStatusUpdate(
  teamId: string,
  channel: Channel,
  evt: NormalizedStatusUpdate,
): Promise<void> {
  // (teamId, channel, externalId) is the compound unique key post the
  // multi-channel refactor. teamId + channel come from the webhook route
  // (the URL is per-team and the route is per-channel); the wire payload
  // carries only the externalId.
  const existing = await db.message.findUnique({
    where: {
      teamId_channel_externalId: {
        teamId,
        channel,
        externalId: evt.externalId,
      },
    },
    select: {
      id: true,
      teamId: true,
      conversationId: true,
      status: true,
      direction: true,
      conversation: { select: { contactId: true } },
    },
  });
  // Status arriving for an unknown message: classic race where Meta delivers
  // `sent`/`delivered`/`read` for an outbound BEFORE our create-message path
  // has committed the row. Park the status in Redis with a short TTL; when
  // the message row is created (`createOutboundMessageIdempotent` below)
  // it drains the parked status and applies it. After TTL we drop — at that
  // point either the create failed permanently or Meta's clock is way off.
  if (!existing) {
    await parkUnknownWamidStatus(teamId, channel, evt.externalId, {
      status: evt.status,
      errorCode: evt.errorCode,
      errorTitle: evt.errorTitle,
      errorDetail: evt.errorDetail,
    });
    return;
  }

  // Delivery/read/failed status only ever concerns a message WE sent. Instagram
  // read receipts target a specific `mid`; guard against a mid ever resolving to
  // an inbound row so a status write can't corrupt a customer message.
  if (existing.direction !== "out") return;

  // `statusWinsOver` (module-level, shared with drainParkedStatus) applies both
  // the terminal-`failed` rule and the monotonic rank guard (sent < delivered
  // < read).
  if (!statusWinsOver(evt.status, existing.status as Message["status"])) return;

  // CAS the write against the status we just read. A single Meta batch (or two
  // near-simultaneous deliveries) can carry both `delivered` and `read` for the
  // same wamid; processed on different ingest lanes, both findUnique the row at
  // `sent`, both pass the guard, and a bare `update` lets whichever commits LAST
  // win — so a late `delivered` could regress a row already at `read`. Pinning
  // `status` in the WHERE means only the first writer at that pinned status
  // lands. The LOSER, however, must NOT silently drop a higher status: if
  // `delivered` wins the CAS race, the concurrent `read` lane's CAS misses
  // (row is no longer `sent`) — without a re-check the customer's read receipt
  // would be lost and the ticks stay grey forever. So on a CAS miss we re-read
  // the now-current status and re-evaluate: if our status STILL wins we retry
  // against the new pin; if it lost legitimately (e.g. a `delivered` arriving
  // after `read` already committed) we return. The loop is bounded by the rank
  // ladder (sent→delivered→read = at most 3 states), so a small fixed cap can't
  // spin. Failure diagnostics ride the same write — only set on a `failed`
  // transition that carried a reason; a later non-failed status can't reach a
  // failed row (terminal), so they never need clearing back to null.
  let pinnedStatus: Message["status"] = existing.status as Message["status"];
  let written = { count: 0 };
  for (let attempt = 0; attempt < 4; attempt++) {
    written = await db.message.updateMany({
      where: { id: existing.id, status: pinnedStatus },
      data: {
        status: evt.status,
        ...(evt.status === "failed"
          ? {
              statusErrorCode: evt.errorCode ?? null,
              statusErrorTitle: evt.errorTitle ?? null,
              statusErrorDetail: evt.errorDetail ?? null,
            }
          : {}),
      },
    });
    if (written.count > 0) break;
    // CAS miss — a concurrent lane moved the row. Re-read and re-decide.
    const current = await db.message.findUnique({
      where: { id: existing.id },
      select: { status: true },
    });
    if (!current) return; // row vanished (hard delete) — nothing to do
    if (!statusWinsOver(evt.status, current.status as Message["status"])) return; // lost legitimately
    pinnedStatus = current.status as Message["status"];
  }
  if (written.count === 0) return;

  await publish({
    type: "message.status_changed",
    teamId: existing.teamId,
    conversationId: existing.conversationId,
    contactId: existing.conversation.contactId,
    messageId: existing.id,
    status: evt.status,
    // Stamp the transition time at publish so the webhook status_changed wire
    // can emit a `timestamp` and downstream sorting reflects when the status
    // actually flipped (the status webhook carries no provider timestamp).
    occurredAt: new Date().toISOString(),
    ...(evt.status === "failed" && evt.errorCode !== undefined
      ? { errorCode: evt.errorCode }
      : {}),
    ...(evt.status === "failed" && evt.errorTitle !== undefined
      ? { errorTitle: evt.errorTitle }
      : {}),
    ...(evt.status === "failed" && evt.errorDetail !== undefined
      ? { errorDetail: evt.errorDetail }
      : {}),
  });
}

/**
 * Apply a `message_template_status_update` webhook to the local catalog. Meta
 * sends these when a template is approved, paused for quality, disabled, or
 * rejected — keeping the local `MessageTemplate.status` fresh AUTOMATICALLY so a
 * Meta-paused template can't silently mass-fail a scheduled broadcast and a
 * newly-approved one becomes sendable without a manual "Sync" click.
 *
 * Match priority: Meta's template id (externalId) first, then (name, language)
 * — a template synced before externalId existed, or a manual-Manager template
 * we haven't fetched yet, still matches on the natural key. We only WRITE when
 * the event mapped to a known status (`status !== null`); an unmappable future
 * `event` value is a no-op (the next manual/automatic sync reconciles it).
 *
 * We update in place rather than upsert — a status-update for a template we've
 * never synced has no body/components/category to create a complete row from,
 * so we let the catalog sync own row creation and only flip status here.
 */
async function ingestTemplateStatusUpdate(
  teamId: string,
  evt: NormalizedTemplateStatusUpdate,
): Promise<void> {
  // A status update sets `status`; a category update sets `category`; both flip
  // the local row. Nothing to write when neither mapped to a known enum value.
  const data: Prisma.MessageTemplateUpdateManyMutationInput = {};
  if (evt.status) data.status = evt.status;
  if (evt.category) data.category = evt.category;
  if (Object.keys(data).length === 0) return;

  // Prefer matching on Meta's template id (externalId); fall back to the
  // natural (name, language) key. Build the narrowest WHERE we can.
  const where: Prisma.MessageTemplateWhereInput = { teamId };
  if (evt.externalId) {
    where.externalId = evt.externalId;
  } else if (evt.name) {
    where.name = evt.name;
    if (evt.language) where.language = evt.language;
  } else {
    return; // no identity to match on (parser already guards, belt-and-braces)
  }

  const result = await db.messageTemplate.updateMany({
    where,
    data,
  });
  if (result.count === 0) return; // template not in our catalog yet — sync owns creation

  // Refresh every open /settings/whatsapp + broadcast-form tab so the new
  // status (e.g. a now-paused template) surfaces without a manual reload. Reuses
  // the same catalog-changed event syncTemplates publishes.
  await publish({
    type: "team.catalog_changed",
    teamId,
    scope: "whatsapp-templates",
  });
}

/**
 * Park-and-replay table for status updates that arrived before the message
 * row was committed. Keyed by `(teamId|channel|externalId)` and stored in
 * Redis with a 15-minute TTL so:
 *   - state survives process restart (deploys + crashes)
 *   - two api processes can park on A and drain on B without losing replay
 *   - memory is Redis's problem, not the Node heap's
 *
 * The TTL is intentionally generous (15min vs the prior 5min in-mem cap) so
 * a longer-than-expected outbound create — DB hiccup, Meta send hanging
 * pre-row — still drains its status when the row finally lands. `failed`
 * always wins (terminal); other transitions only upgrade by rank. Race
 * between two simultaneous parks for the same wamid is accepted (Meta sends
 * status updates ~1/sec/message at most; converges on the next event).
 */
const UNKNOWN_WAMID_TTL_MS = 15 * 60_000;

function parkKey(
  teamId: string,
  channel: Channel,
  externalId: string,
): string {
  return `ccp:parked-status:${teamId}|${channel}|${externalId}`;
}

/**
 * What we stash in Redis for an unknown-wamid status. A bare status string used
 * to be enough, but a parked `failed` must carry its `errors[0]` diagnostics —
 * Meta sends `failed` exactly once, so if the row didn't exist yet the drain is
 * the ONLY place those fields can be persisted. Stored as JSON now; the parser
 * still accepts a bare string for anything parked by an older process.
 */
type ParkedStatus = {
  status: Message["status"];
  errorCode?: number;
  errorTitle?: string;
  errorDetail?: string;
};

function serializeParkedStatus(parked: ParkedStatus): string {
  // JSON.stringify drops undefined error fields, so a non-failed park stays
  // compact ({"status":"delivered"}).
  return JSON.stringify(parked);
}

function parseParkedStatus(raw: string): ParkedStatus {
  // Backward-compat: an older process parked the bare status string.
  if (raw.startsWith("{")) {
    try {
      const obj = JSON.parse(raw) as ParkedStatus;
      if (obj && typeof obj.status === "string") return obj;
    } catch {
      // Fall through to bare-string handling.
    }
  }
  return { status: raw as Message["status"] };
}

async function parkUnknownWamidStatus(
  teamId: string,
  channel: Channel,
  externalId: string,
  parked: ParkedStatus,
): Promise<void> {
  const key = parkKey(teamId, channel, externalId);
  const redis = getRedisConnection();
  const { status } = parked;
  try {
    if (status === "failed") {
      // Terminal — overwrite anything already parked.
      await redis.set(key, serializeParkedStatus(parked), "PX", UNKNOWN_WAMID_TTL_MS);
    } else {
      const existing = await redis.get(key);
      if (existing) {
        // Don't downgrade — `failed` stays put, lower ranks lose to higher.
        const existingStatus = parseParkedStatus(existing).status;
        if (existingStatus === "failed") return;
        if (statusRank(status) <= statusRank(existingStatus)) return;
      }
      await redis.set(key, serializeParkedStatus(parked), "PX", UNKNOWN_WAMID_TTL_MS);
    }
    // Close the park-vs-drain race: the outbound Message row may have committed
    // (and already run drainParkedStatus against an empty key) in the window
    // between the findUnique miss in ingestStatusUpdate and this SET landing,
    // stranding the status we just parked until its 15-min TTL. For
    // delivered/read the next-rank webhook would heal it, but Meta sends
    // `failed` exactly once — without this the message stays 'sent' forever.
    // Re-read the row; if it now exists, drain immediately through the shared
    // CAS path (GETDEL makes the double-drain-with-create-path safe).
    await drainParkIfRowCommitted(teamId, channel, externalId);
  } catch (err) {
    // Redis hiccup must not abort the webhook 200. Losing one parked status
    // is recoverable — Meta typically resends the next-rank event soon after.
    console.error(
      `[ingest] parkUnknownWamidStatus failed for ${key}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Park-side half of the park-vs-drain race guard (called from
 * `parkUnknownWamidStatus` right after the SET lands). If the outbound Message
 * row has committed since ingestStatusUpdate's findUnique missed, its
 * `drainParkedStatus` may have run against an empty key already — so re-read
 * the row and, if present, drain now. GETDEL inside `drainParkedStatus` makes
 * this safe against a concurrent create-path drain (only one wins the key).
 */
async function drainParkIfRowCommitted(
  teamId: string,
  channel: Channel,
  externalId: string,
): Promise<void> {
  const row = await db.message.findUnique({
    where: {
      teamId_channel_externalId: { teamId, channel, externalId },
    },
    select: {
      id: true,
      conversationId: true,
      conversation: { select: { contactId: true } },
    },
  });
  if (!row) return;
  await drainParkedStatus(
    teamId,
    channel,
    externalId,
    row.id,
    row.conversationId,
    row.conversation.contactId,
  );
}

/**
 * Called from the outbound create path immediately after the Message row
 * commits. If a status update arrived for this wamid before us, apply it
 * now so the row isn't stuck at the create-time default. Uses GETDEL so the
 * read-and-clear is atomic — two near-simultaneous create paths can't both
 * apply the same parked status.
 */
export async function drainParkedStatus(
  teamId: string,
  channel: Channel,
  externalId: string,
  messageId: string,
  conversationId: string,
  contactId: string,
): Promise<void> {
  const key = parkKey(teamId, channel, externalId);
  const redis = getRedisConnection();
  let parked: ParkedStatus | null = null;
  try {
    const raw = await redis.getdel(key);
    parked = raw ? parseParkedStatus(raw) : null;
  } catch (err) {
    console.error(
      `[ingest] drainParkedStatus(${key}) failed: ${err instanceof Error ? err.message : err}`,
    );
    return;
  }
  if (!parked) return;
  // Apply the SAME rank/CAS guard as ingestStatusUpdate. A bare update here
  // could regress a row a concurrent live webhook already advanced: the parked
  // status was captured earlier, so by drain time the row may already be at a
  // HIGHER rank (e.g. parked=`delivered` but a live `read` landed first). Pin
  // the write on the status we read and re-decide on a CAS miss, so only a
  // genuinely-winning parked status lands. Bounded by the rank ladder
  // (sent→delivered→read = 3 states).
  const existing = await db.message.findUnique({
    where: { id: messageId },
    select: { status: true },
  });
  if (!existing) return; // row vanished (hard delete) — nothing to drain onto
  let pinnedStatus = existing.status as Message["status"];
  let written = { count: 0 };
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!statusWinsOver(parked.status, pinnedStatus)) return; // parked lost — discard it
    written = await db.message.updateMany({
      where: { id: messageId, status: pinnedStatus },
      data: {
        status: parked.status,
        // Persist failure diagnostics on the drained `failed` transition —
        // same guarded write as the live path (ingestStatusUpdate above).
        ...(parked.status === "failed"
          ? {
              statusErrorCode: parked.errorCode ?? null,
              statusErrorTitle: parked.errorTitle ?? null,
              statusErrorDetail: parked.errorDetail ?? null,
            }
          : {}),
      },
    });
    if (written.count > 0) break;
    const current = await db.message.findUnique({
      where: { id: messageId },
      select: { status: true },
    });
    if (!current) return;
    pinnedStatus = current.status as Message["status"];
  }
  if (written.count === 0) return;
  await publish({
    type: "message.status_changed",
    teamId,
    conversationId,
    contactId,
    messageId,
    status: parked.status,
    // Stamped at drain (when the parked status is actually applied) — same
    // role as the live-status publish above.
    occurredAt: new Date().toISOString(),
    ...(parked.status === "failed" && parked.errorCode !== undefined
      ? { errorCode: parked.errorCode }
      : {}),
    ...(parked.status === "failed" && parked.errorTitle !== undefined
      ? { errorTitle: parked.errorTitle }
      : {}),
    ...(parked.status === "failed" && parked.errorDetail !== undefined
      ? { errorDetail: parked.errorDetail }
      : {}),
  });
}

/**
 * Conversation-list preview text for media-only messages (no caption).
 * Delegates to the shared `mediaPreviewLabel` so the server and the client's
 * optimistic list bump can never drift apart. Kept as a named re-export here
 * because call sites across the api (messages.service, broadcast-runner, …)
 * already import `mediaPreview` from this module.
 */
export function mediaPreview(kind: MediaKind | undefined): string {
  return mediaPreviewLabel(kind);
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

/**
 * Status transition guard shared by live status ingest (`ingestStatusUpdate`)
 * AND parked-status drain (`drainParkedStatus`):
 *   - `failed` is terminal: as TARGET it wins from any non-failed state; as
 *     SOURCE it's sticky (a late delivered/read can't revert a failed).
 *   - Otherwise the monotonic rank guard (sent < delivered < read) wins.
 */
function statusWinsOver(
  incoming: Message["status"],
  current: Message["status"],
): boolean {
  if (current === "failed") return false; // failed is terminal — nothing overwrites it
  if (incoming === "failed") return true; // failure overwrites any non-failed
  return statusRank(incoming) > statusRank(current);
}

async function ingestInboundMessage(
  teamId: string,
  channel: Channel,
  evt: NormalizedInboundMessage,
): Promise<void> {
  // Rule #3 dedupe gate. Cheap pre-check; the compound unique
  // (teamId, channel, externalId) is the actual race guard via the P2002
  // catch below.
  const existing = await db.message.findUnique({
    where: {
      teamId_channel_externalId: {
        teamId,
        channel,
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
      channel,
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
  // for one contact. The contact race is backstopped by the partial unique
  // `Contact_teamId_phoneNumber_whatsapp_key` (raw SQL — WhatsApp/null
  // identityChannel only, so Instagram/Telegram can store the same phone
  // across distinct accounts); the conversation lookup-then-create pattern
  // is the classic check-then-act race that Serializable resolves.
  //
  // We use `Serializable` because the read of "is there an open conversation?"
  // must be conflict-protected against another tx's create. Postgres returns
  // P2034 (serialization failure) on conflict; we retry once. P2002 (unique
  // violation from a parallel insert outracing predicate locking) is also
  // retried by the wrapper for the same reason. Two retries is a sensible
  // ceiling — by then the contention is real, not a fluke.
  // `conversation` is reassigned in tx2 when a reopen flips closed→pending so
  // all downstream snapshots see the post-reopen state — hence `let` (INB-1).
  // eslint-disable-next-line prefer-const
  let { contact, conversation, isNewContact, wasRevived, isNewConversation, needsReopen } = await runWithSerializableRetry(
    async (tx) => {
      // Pre-existence check — the signal "did this inbound just create a
      // brand-new contact row?" We need it to publish `contact.created`
      // BEFORE `message.received` so n8n flows triggered on "On Contact
      // created → Send welcome" see the contact existed first.
      //
      // Every Prisma call inside this block uses `tx`, NOT the global
      // `db`. Using `db` would run on a pooled connection OUTSIDE the
      // Serializable transaction — the isolation level would silently
      // become Read Committed and the duplicate-Conversation race the
      // wrapper exists to prevent would still bite.
      //
      // Channel-aware contact identity (multi-channel / F4). Phone channels
      // (WhatsApp) resolve by `phoneNumber`; non-phone channels (Messenger,
      // Instagram, …) resolve by the compound unique
      // `(teamId, identityChannel, externalContactId)`, where the id is the
      // provider's opaque per-account id (PSID / IGSID) — NEVER a phone. This
      // keeps a Messenger contact that happens to share digits with a WhatsApp
      // number from resolving to the wrong row.
      //
      // findFirst (not findUnique) so we also see soft-deleted rows and can
      // revive them: for phone the partial unique holds the slot across
      // deletedAt; for external the full compound unique does the same.
      const isPhone = isPhoneChannel(channel);
      // Phone channels resolve by phone; BSUID forward-compat: when Meta omits
      // the phone (2026), fall back to the business-scoped id. Exactly one is
      // the resolve key.
      const identityLabel = isPhone
        ? evt.contactPhone ?? evt.bsuid
        : evt.externalContactId;
      if (!identityLabel) {
        // Defensive: a message with neither identity is unroutable. Drop it
        // (the outer per-event handler logs + continues) rather than creating a
        // bogus contact.
        throw new Error(
          `ingest: inbound ${channel} message ${evt.externalId} has no contact identity`,
        );
      }
      const existingContact = await tx.contact.findFirst({
        where: isPhone
          ? evt.contactPhone
            ? { teamId, phoneNumber: evt.contactPhone }
            : { teamId, identityChannel: channel, bsuid: evt.bsuid }
          : { teamId, identityChannel: channel, externalContactId: evt.externalContactId },
        select: { id: true, deletedAt: true },
      });
      const isNewContact = !existingContact;
      // A soft-deleted row being revived (deletedAt → null just below) is a
      // fresh directory appearance to every subscriber, exactly like the
      // manual + /v1 revive paths (which both republish contact.created).
      // Capture it so the post-commit publish fires for revives too —
      // otherwise a returning customer's contact silently never reaches
      // workflows / audit / partners until their next manual edit.
      const wasRevived = !!existingContact?.deletedAt;

      const { firstName, lastName } = splitContactName(evt.contactName ?? identityLabel);
      let contact;
      if (existingContact) {
        // Revive a soft-deleted contact: they're messaging again, so they
        // belong back in the directory. The soft-deleted row still holds
        // this phone's unique slot (one contact = one phone), so the lookup
        // lands on it — clearing the tombstone reconnects them to their
        // preserved conversation history. No-op when already active.
        //
        // Everything else is intentionally untouched: do NOT touch the name
        // OR the stage. The agent's manually entered name (or the
        // first-contact profile name) stays put, and a contact who
        // progressed past the default stage isn't pulled back to it just
        // because they sent another message.
        contact = await tx.contact.update({
          where: { id: existingContact.id },
          data: { deletedAt: null },
          // Load tags as `{ id }` so the `message.received` contact snapshot
          // (toWorkflowContact below) emits the RETURNING contact's real
          // tagIds — without this the relation is absent and tagIds is [].
          include: { tags: { select: { id: true } } },
        });
      } else {
        contact = await tx.contact.create({
          data: {
            teamId,
            // Explicit channel stamp — every new contact carries its channel.
            identityChannel: channel,
            // Exactly one identity is set, keyed on the channel kind: phone
            // channels store `phoneNumber` (+ derived country code); non-phone
            // channels store the opaque `externalContactId` (PSID / IGSID) and
            // leave phone/country null.
            phoneNumber: isPhone ? evt.contactPhone ?? null : null,
            externalContactId: isPhone ? null : evt.externalContactId,
            // BSUID forward-compat (phone channels only, null today).
            bsuid: isPhone ? evt.bsuid ?? null : null,
            username: isPhone ? evt.username ?? null : null,
            name: evt.contactName ?? identityLabel,
            // Populate the new webhook-facing fields on create. Splitting the
            // name + deriving the country code on first contact matches what
            // the migration does for backfill — both paths converge on the
            // same shape so webhook receivers don't see partial rows.
            firstName,
            lastName,
            countryCode: isPhone ? getCountryFromPhone(evt.contactPhone!) : null,
            stageId: defaultStageId,
            // Unified Customer (§6): resolve which person this contact belongs to
            // through the single identity authority. On a deterministic strong
            // key (exact phone/email already linked to a Customer) it adopts that
            // person IMMEDIATELY — cross-channel merge at ingest, not sweeper-
            // delayed; otherwise it mints a fresh Customer. Runs in `tx` so the
            // Customer rolls back with the contact if the create aborts. The
            // drift sweeper stays the backstop for keys that appear later.
            customerId: await resolveCustomerId(
              teamId,
              {
                phoneNumber: isPhone ? evt.contactPhone ?? null : null,
                email: null,
                name: evt.contactName ?? identityLabel,
              },
              tx,
            ),
          },
          // Same `{ id }` tags shape as the returning-contact path so the
          // snapshot mapper reads the relation uniformly (a brand-new contact
          // simply has none yet — emits [], which is correct).
          include: { tags: { select: { id: true } } },
        });
      }

      // Strict invariant: one contact = one conversation, forever. If the
      // contact has any prior conversation (including closed), reuse it.
      // Closed → pending on a new inbound, so the thread "reopens" in the
      // agent's inbox rather than fragmenting history across multiple rows.
      // Only when a contact has literally never had a conversation do we
      // create one.
      const existingConvo = await tx.conversation.findFirst({
        where: { teamId, contactId: contact.id },
        orderBy: { lastMessageAt: "desc" },
      });
      const isNewConversation = !existingConvo;
      let conversation = existingConvo;
      // INB-1: only DETECT a reopen here; do NOT flip closed→pending in this
      // (separate) transaction. The actual CAS flip + the `status_changed`
      // publish are co-committed with the message in tx2, so a tx2 failure
      // rolls the flip back too — otherwise tx1's committed flip would make a
      // redelivery see status='pending', skip `reopened`, and PERMANENTLY drop
      // the reopen event (the workflow "conversation opened" trigger + partner
      // webhook + list-splice). Mirrors ingest-call.ts's detect-in-tx1 /
      // flip-and-publish-in-tx2 split.
      let needsReopen = false;
      if (!conversation) {
        conversation = await tx.conversation.create({
          data: {
            teamId,
            contactId: contact.id,
            // The thread's channel is the channel whose webhook created it.
            channel,
            // New chats land in `pending` so they sit in the triage column
            // until an agent claims them (→ open) or closes them out.
            status: "pending",
            lastMessageAt: evt.timestamp,
            lastMessagePreview: "",
          },
        });
      } else if (conversation.status === "closed") {
        // Returning customer replying to a closed thread → mark for reopen in
        // tx2 (do NOT mutate here).
        needsReopen = true;
      }
      return { contact, conversation, isNewContact, wasRevived, isNewConversation, needsReopen };
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

  // Atomic landing for the inbound: message + conversation summary +
  // contact.lastInboundAt + the `message.received` outbox row all commit
  // together, or none of them do. Previously these ran as a sequential
  // create + Promise.all UPDATE followed by a fire-and-forget `publish()`;
  // a crash between the commit and the publish lost the realtime emit
  // forever (Meta's webhook retry hit the P2002 dedupe and returned
  // silently, never re-firing the event). Writing the event row inside
  // the SAME tx via `publishInTx` closes that window — if the tx
  // commits, the drainer WILL eventually dispatch it; if the tx rolls
  // back, both the message AND the event vanish together.
  try {
    const txResult = await db.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          teamId,
          conversationId: conversation.id,
          externalId: evt.externalId,
          senderUserId: null,
          body: evt.body,
          direction: "in",
          channel,
          status: "delivered",
          rawPayload: evt.rawPayload as Prisma.InputJsonValue,
          timestamp: evt.timestamp,
          // Structured non-media content (location pin / contact card) → rich bubble.
          ...(evt.structured
            ? { structured: evt.structured as unknown as Prisma.InputJsonValue }
            : {}),
          // Ad / deep-link attribution (Click-to-WhatsApp) → "from your ad" chip.
          ...(evt.attribution
            ? { attribution: evt.attribution as unknown as Prisma.InputJsonValue }
            : {}),
          ...(replySnapshot ? { replyToMessageId: replySnapshot.id } : {}),
          ...(evt.media
            ? {
                mediaKind: evt.media.kind,
                mediaMimeType: evt.media.mimeType,
                mediaCaption: evt.body || null,
                mediaFilename: evt.media.filename ?? null,
                mediaDurationMs: evt.media.durationMs ?? null,
                mediaVoice: evt.media.voice ?? null,
                ...(evt.media.storageKey && evt.media.storageUrl
                  ? {
                      mediaKey: evt.media.storageKey,
                      mediaUrl: evt.media.storageUrl,
                      mediaSizeBytes: evt.media.sizeBytes ?? null,
                    }
                  : {}),
                ...(evt.media.thumbnailStorageKey && evt.media.thumbnailStorageUrl
                  ? {
                      mediaThumbnailKey: evt.media.thumbnailStorageKey,
                      mediaThumbnailUrl: evt.media.thumbnailStorageUrl,
                    }
                  : {}),
              }
            : {}),
        },
      });

      // INB-1: perform the closed→pending reopen flip HERE (tx2), co-committed
      // with the message + the `status_changed` outbox row. CAS on
      // `status='closed'` so two racing inbound messages can't both "win" the
      // reopen: the loser's updateMany matches 0 rows. We reassign the local
      // `conversation` to the post-reopen shape whenever a reopen is needed (so
      // every downstream snapshot — message.received, workflow — is consistent),
      // but only the CAS WINNER (`reopened`) publishes status_changed / splices
      // the list row, so the event fires exactly once.
      let reopened = false;
      if (needsReopen) {
        const flip = await tx.conversation.updateMany({
          where: { id: conversation.id, status: "closed" },
          data: { status: "pending" },
        });
        reopened = flip.count > 0;
        // Closed threads already have the assignee cleared (see the close path),
        // so null is the correct post-reopen value.
        conversation = { ...conversation, status: "pending", assignedUserId: null };
      }

      // Run the two denorm updates SEQUENTIALLY, not via Promise.all. Prisma
      // does not serialise parallel queries inside a $transaction — they
      // ride the same connection but a throw on one isn't guaranteed to
      // abort the in-flight other before the transaction wrapper sees it.
      // Sequential write inside the same tx means the rollback boundary is
      // the only escape: either both denorms commit or neither does.
      // (Latency cost is one extra round-trip; ~1ms on a local pool.)
      // Capture the post-increment `unreadCount` from the UPDATE itself so
      // the published value reflects the actual DB state. The previous code
      // published `(conversation.unreadCount ?? 0) + 1`, derived from the
      // snapshot read in the OUTER tx — under two concurrent inbounds for
      // the same conversation both events published the same `snapshot+1`
      // while DB ended up at `snapshot+2`, drifting every client's unread
      // badge low by 1. The atomic `{ increment }` handles the DB write
      // correctly; we just need to broadcast the truth.
      // Monotonicity guard as a real CAS (not read-then-write). Meta delivers
      // at-least-once with NO ordering guarantee — retries, webhook replay, or a
      // single batch fanned across ingest lanes can land an OLDER message after
      // a newer one. A prior read-then-write (findUnique the summary, decide in
      // JS, then update) let two concurrent inbounds for the SAME conversation
      // both read the stale pre-batch lastMessageAt, both decide "advance", and
      // let whichever UPDATE committed LAST win — regressing the list preview +
      // sort to the older message (the bug that left "Cont" pinned after
      // "A"/"P" arrived). The WHERE-guarded updateMany makes the advance atomic:
      // only a message at-or-after the row's CURRENT lastMessageAt writes the
      // summary, so a late older inbound matches 0 rows and can't clobber it.
      // Mirrors the WHERE-guarded `contact.lastInboundAt` bump just below and
      // the outbound guard in commitOutboundEvent / send-text-internal. `lte`
      // (not `lt`) so a brand-new conversation, whose create set lastMessageAt
      // to this same evt.timestamp, still writes its first preview.
      await tx.conversation.updateMany({
        where: { id: conversation.id, lastMessageAt: { lte: evt.timestamp } },
        data: {
          lastMessageAt: evt.timestamp,
          lastMessagePreview: preview,
          lastMessageDirection: "in" as const,
        },
      });
      // unreadCount + incomingMessagesCount increment for EVERY inbound
      // regardless of order — they're counts, not a "latest" pointer. Read the
      // EFFECTIVE summary back from the same UPDATE so the realtime frame +
      // workflow snapshot carry the newest values that actually committed (this
      // message's, or a concurrent newer inbound's that won the CAS above) — an
      // out-of-order inbound never pushes a stale preview to the inbox list. The
      // absolute post-increment `unreadCount` likewise comes from the DB, not a
      // `snapshot+1` (which drifted low when two webhooks raced pre-commit).
      const bumped = await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          unreadCount: { increment: 1 },
          incomingMessagesCount: { increment: 1 },
        },
        select: {
          unreadCount: true,
          lastMessageAt: true,
          lastMessagePreview: true,
        },
      });
      const effectiveLastMessageAt = bumped.lastMessageAt;
      const effectivePreview = bumped.lastMessagePreview;
      await tx.contact.updateMany({
        where: {
          id: contact.id,
          OR: [{ lastInboundAt: null }, { lastInboundAt: { lt: evt.timestamp } }],
        },
        data: { lastInboundAt: evt.timestamp },
      });

      // Build the message.received payload inside the tx so all reads
      // (recentMessages) see the row we just wrote and stay consistent
      // with what commits. Then write the outbox row so the drainer can
      // dispatch atomically with the entity write.
      const messagePayload = buildMessageDomain({
        createdId: created.id,
        teamId,
        channel,
        conversation,
        evt,
        replySnapshot,
        mediaPending,
      });
      // Carry a full splice-in row for the inbox LIST in BOTH cases where a
      // row needs to (re)enter a teammate's loaded slice live:
      //   - a brand-new conversation (first contact / first inbound), and
      //   - a REOPEN (customer reply flips a closed thread back to pending).
      // Without the reopen row the team-wide `conversation:status` frame can't
      // splice into a list that doesn't already hold the row (it carries no
      // row payload), and `onMessageNew` bails at idx===-1 — so a reopened
      // thread stayed invisible in a teammate's default Active view until a
      // reconnect/refocus/nav. Brand-new threads appeared instantly; reopens
      // didn't. Closing clears the assignee server-side (see lib/conversations
      // mutations close path), so `assignedUser: null` matches the post-reopen
      // DB state; `messages: []` is fine — the list row needs no thread body.
      const newConversation: ConversationWithRefs | undefined =
        isNewConversation || reopened
          ? {
              conversation: toDomainConversation({
                ...conversation,
                // A reopen flips closed→pending and (per the close path) the
                // assignee was cleared; reflect both so the spliced row matches
                // the Active filter and renders unassigned, regardless of
                // whether `conversation` here predates the in-tx status update.
                ...(reopened ? { status: "pending", assignedUserId: null } : {}),
                channel,
                lastMessageAt: evt.timestamp,
                lastMessagePreview: preview,
                lastMessageDirection: "in",
                unreadCount: reopened ? bumped.unreadCount : 1,
              }),
              contact: toContactWire(contact),
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
        lastMessageAt: effectiveLastMessageAt,
        unreadCount: bumped.unreadCount,
      });
      const contactSnapshot = toWorkflowContact(contact);
      const workflowMessage = toWorkflowMessage({
        id: created.id,
        conversationId: conversation.id,
        externalId: evt.externalId,
        // Inbound message's channel == the channel whose webhook we're
        // ingesting (the `channel` arg to ingestInboundMessage).
        channel,
        senderUserId: null,
        // Inbound: the sender IS the contact — surface their name for
        // `$var.message.sender_name`.
        senderName: contactSnapshot.name,
        body: evt.body,
        direction: "in",
        mediaKind: evt.media?.kind ?? null,
        mediaCaption: evt.media && evt.body ? evt.body : null,
        timestamp: evt.timestamp,
        // Surface the button / list tap so the message_received trigger's
        // `option_id` condition + `$var.message.interactive.*` tokens resolve.
        interactive: evt.interactiveReply ?? null,
      });
      // tx-scoped read so the snapshot sees the just-inserted row's
      // consistency snapshot, not a global-pool query that might miss
      // sibling concurrent inserts mid-flight.
      const recentMessages = await loadRecentForWorkflow(
        conversation.id,
        created.id,
        tx,
      );

      // A reopen (closed → pending on inbound) is a real customer event, not
      // a side-effect of the message arriving. The earlier shape carried it
      // ONLY as `message.received { reopened: true }` plus an inline socket
      // emit in fanout-rules.ts; every other subscriber (audit timeline,
      // analytics, workflow dispatch, outbound webhooks) saw nothing. The
      // workflow `On Conversation opened` trigger and the partner-side
      // `conversation.status_changed` outbound webhook BOTH silently failed
      // to fire on a customer reply-after-close. Publishing the dedicated
      // event in the SAME tx, BEFORE message.received, ensures both
      // subscribers see the reopen first. `changedByUserId: null` (system —
      // the customer reopened it by replying). `silent: false` (real event,
      // partners want to know).
      if (reopened) {
        // Snapshot with new status applied + close fields predicted-nulled
        // (the analytics subscriber will do the same write). Workflow
        // dispatch reads from THIS snapshot instead of a fresh DB read.
        const reopenSnapshot = workflowConversationSnapshotAfterStatusChange(
          {
            ...conversation,
            status: "pending",
            lastMessageAt: effectiveLastMessageAt,
            unreadCount: bumped.unreadCount,
          },
          { previousStatus: "closed", changedByUserId: null },
        );
        await publishInTx(tx, {
          type: "conversation.status_changed",
          teamId,
          conversationId: conversation.id,
          previousStatus: "closed",
          newStatus: "pending",
          changedByUserId: null,
          contact: contactSnapshot,
          conversation: reopenSnapshot,
        });
      }

      // Where this inbound sits in the contact's chatting session. Sessions are
      // bounded by conversation close, so the reopen flag (known post-CAS) is
      // the session boundary: new convo → first_ever, reopened-from-closed →
      // returning_session, otherwise continued.
      const sessionKind = sessionKindFromFlags(isNewConversation, reopened);

      await publishInTx(tx, {
        type: "message.received",
        teamId,
        conversationId: conversation.id,
        message: messagePayload,
        contact: contactSnapshot,
        conversation: conversationSnapshot,
        workflowMessage,
        isNewConversation,
        reopened,
        sessionKind,
        ...(newConversation ? { newConversation } : {}),
        preview: effectivePreview,
        lastMessageAt: effectiveLastMessageAt.toISOString(),
        // Absolute team-wide unread post-increment, read from the UPDATE
        // return above so two concurrent inbounds publish distinct values
        // (snapshot+1 was the source of an off-by-one drift when two
        // webhooks landed before either's outer tx committed).
        unreadCount: bumped.unreadCount,
        recentMessages,
      });

      // ask_question resume: if any workflow run is paused awaiting this
      // contact's reply, drop the body onto run.pendingAnswer + delete the
      // awaiting row inside the same tx. The actual BullMQ resume enqueue
      // happens AFTER the tx commits (below) so the worker doesn't pick
      // up the run before the message row is visible.
      const resumeRunIds = await findAndConsumeAwaitingReplies(tx, {
        teamId,
        contactId: contact.id,
        answer: {
          body: evt.body,
          messageId: created.id,
          timestamp: evt.timestamp.toISOString(),
          // Structured interactive reply id when the contact tapped a button
          // or list row. Lets the ask_question step's downstream Branch
          // (preset: message_contains) match on the stable machine id
          // instead of the user-facing title.
          ...(evt.interactiveReply
            ? {
                optionId: evt.interactiveReply.id,
                optionKind: evt.interactiveReply.kind,
              }
            : {}),
        },
      });

      return { messageId: created.id, resumeRunIds };
    });
    // Post-commit: kick each awaiting run. Failure here just delays the
    // resume until the timeout job fires (it'll see pendingAnswer set and
    // take the `answered` edge), so a Redis blip is recoverable rather
    // than catastrophic.
    if (txResult?.resumeRunIds?.length) {
      for (const runId of txResult.resumeRunIds) {
        try {
          await enqueueWorkflowInboundResume(runId, txResult.messageId);
        } catch (err) {
          console.error("[ingest][ask_question_resume]", { runId, err });
        }
      }
    }
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Race: another worker won the insert. Drop without side effects —
      // the tx rolled back, so no outbox row was written either. The
      // winning worker will publish on its own commit.
      return;
    }
    throw err;
  }

  // The message.received event was already written to the outbox INSIDE
  // the tx above — the drainer will dispatch it (~100ms p99).
  //
  // `contact.created` stays on the synchronous publish path because the
  // contact upsert is in a different tx (runWithSerializableRetry above)
  // that doesn't thread `tx` to its body, so we can't `publishInTx` from
  // here. Its lost-event window is small in absolute volume (one per new
  // phone number per team) and downstream receivers are expected to dedupe
  // by id — acceptable for now; migrate when the contact tx is rewritten.
  //
  // Ordering: contact.created dispatches BEFORE message.received because
  // its synchronous publish fires immediately, and the message.received
  // outbox row only dispatches after the drainer's next tick (~100ms).
  // Subscribers (incl. outbound webhook) see contact-then-message order.
  // Fires for a genuinely-new contact AND for a revived soft-deleted one
  // (a returning customer is a fresh directory appearance — same as the
  // manual + /v1 revive paths). The two flags are mutually exclusive.
  if (isNewContact || wasRevived) {
    try {
      await publish({
        type: "contact.created",
        teamId,
        contact: toContactWire(contact),
        source: "inbound",
        createdByUserId: null,
      });
    } catch (err) {
      console.error(
        `[ingest] publish(contact.created) failed for team=${teamId} contact=${contact.id}:`,
        err instanceof Error ? err.message : err,
      );
      // The customer-visible message arrival already happened (outbox row
      // committed); contact.created is the secondary signal here.
    }
  }
}

// WhatsApp Coexistence: the "who read it" attribution on the conversation.read
// event a phone-app reply publishes. There's no acting agent — the owner read +
// replied on their phone — so we stamp a stable sentinel rather than a user id.
// Consumers use readByUserId only as a cross-tab "not me" nudge; a sentinel
// clears the badge for everyone, which is the intent.
const COEXISTENCE_ECHO_READER = "whatsapp-business-app";

/**
 * Build the outbound-message media block for a `message.sent` payload. Mirrors
 * the media arm of buildMessageDomain but for an echo/outbound row. `pending`
 * is true until the binary lands (completePendingMedia patches + emits
 * message.media_ready, exactly like inbound media).
 */
function buildEchoMediaBlock(
  createdId: string,
  media: NormalizedOutboundEcho["media"],
  body: string,
): Message["media"] | undefined {
  if (!media) return undefined;
  return {
    kind: media.kind,
    url: `/api/media/${createdId}`,
    mimeType: media.mimeType,
    sizeBytes: media.sizeBytes ?? 0,
    ...(body ? { caption: body } : {}),
    ...(media.filename ? { filename: media.filename } : {}),
    ...(media.durationMs != null ? { durationMs: media.durationMs } : {}),
    ...(media.voice ? { voice: true } : {}),
  };
}

/**
 * WhatsApp Coexistence: a message the owner sent from the WhatsApp Business App
 * on their phone, mirrored to us via `smb_message_echoes` (or the live-echo arm
 * of `history`). We land it as a `direction:"out"`, `senderUserId:null`,
 * `origin:"business_app"` row in the customer's conversation so the shared inbox
 * matches the phone.
 *
 * Contract vs. inbound:
 *   - dedup returns EARLY (an echo re-delivery, or an echo of a message our own
 *     API already sent, both collide on the wamid — no phantom, no double bump);
 *   - the conversation is resolved/created (an echo can OPEN a brand-new thread
 *     if the owner started the chat from the phone) and REOPENED if closed;
 *   - it does NOT increment unread — instead it CLEARS it (the owner replying is
 *     proof they saw the customer's messages, mirroring markReadOnAgentSend);
 *   - it does NOT send a Meta read receipt (the phone already did on the owner's
 *     side) and does NOT re-trigger the `message_received` automations (this is
 *     an OUTBOUND message — `message.sent` drives the same subscribers a normal
 *     agent send would).
 */
async function ingestOutboundEcho(
  teamId: string,
  channel: Channel,
  evt: NormalizedOutboundEcho,
): Promise<void> {
  // Rule #3 dedupe. The outbound idempotent-create below is the race backstop;
  // this cheap pre-check short-circuits the common re-delivery / echo-of-our-
  // own-send case before we touch the contact/conversation resolution.
  const existing = await db.message.findUnique({
    where: {
      teamId_channel_externalId: { teamId, channel, externalId: evt.externalId },
    },
    select: { id: true },
  });
  if (existing) return;

  const defaultStageId = await ensureDefaultStage(teamId);
  // Channel-agnostic identity: WhatsApp Coexistence echoes carry `contactPhone`,
  // social native-inbox echoes carry `externalContactId` (customer PSID/IGSID).
  const isPhone = isPhoneChannel(channel);
  const identityLabel = isPhone ? evt.contactPhone : evt.externalContactId;
  if (!identityLabel) {
    throw new Error(
      `ingest: outbound echo ${evt.externalId} on ${channel} has no contact identity`,
    );
  }
  const { firstName, lastName } = splitContactName(identityLabel);

  const { contact, conversation, isNewContact, wasRevived, isNewConversation } =
    await runWithSerializableRetry(async (tx) => {
      const found = await tx.contact.findFirst({
        where: isPhone
          ? { teamId, phoneNumber: evt.contactPhone }
          : { teamId, identityChannel: channel, externalContactId: evt.externalContactId },
        include: { tags: { select: { id: true } } },
      });
      const isNewContact = !found;
      const wasRevived = !!found?.deletedAt;
      let contact = found;
      if (found?.deletedAt) {
        // The owner is chatting this contact again → revive the tombstoned row
        // (same as the inbound + manual revive paths). Name/stage untouched.
        contact = await tx.contact.update({
          where: { id: found.id },
          data: { deletedAt: null },
          include: { tags: { select: { id: true } } },
        });
      } else if (!found) {
        contact = await tx.contact.create({
          data: {
            teamId,
            identityChannel: channel,
            phoneNumber: isPhone ? evt.contactPhone : null,
            externalContactId: isPhone ? null : evt.externalContactId,
            name: identityLabel,
            firstName,
            lastName,
            countryCode: isPhone ? getCountryFromPhone(evt.contactPhone!) : null,
            stageId: defaultStageId,
            // Same unified-Customer resolution as the inbound path — an echo can
            // be the FIRST time we see a contact (owner messaged them natively
            // before they replied). Runs in `tx` so it rolls back atomically.
            customerId: await resolveCustomerId(
              teamId,
              {
                phoneNumber: isPhone ? evt.contactPhone ?? null : null,
                email: null,
                name: identityLabel,
              },
              tx,
            ),
          },
          include: { tags: { select: { id: true } } },
        });
      }

      // One conversation per contact. Reuse the existing thread (reopening a
      // closed one — there's fresh activity); create it only when the owner
      // started a brand-new chat from the phone.
      const existingConvo = await tx.conversation.findFirst({
        where: { teamId, contactId: contact!.id },
        orderBy: { lastMessageAt: "desc" },
      });
      const isNewConversation = !existingConvo;
      let conversation = existingConvo;
      if (!conversation) {
        conversation = await tx.conversation.create({
          data: {
            teamId,
            contactId: contact!.id,
            channel,
            // A phone-initiated thread lands in triage like any other new
            // conversation until an agent claims it.
            status: "pending",
            lastMessageAt: evt.timestamp,
            lastMessagePreview: "",
          },
        });
      } else if (conversation.status === "closed") {
        // Reopen: the owner is chatting this contact again. CAS so a racing
        // inbound reopen doesn't double-flip; either way the thread ends pending.
        await tx.conversation.updateMany({
          where: { id: conversation.id, status: "closed" },
          data: { status: "pending", assignedUserId: null },
        });
        conversation = { ...conversation, status: "pending", assignedUserId: null };
      }
      return { contact: contact!, conversation, isNewContact, wasRevived, isNewConversation };
    });

  // Strict-monotonic timestamp so a phone reply landing in the same second as
  // the inbound it answers still sorts AFTER it (same rule as send-text-internal).
  const messageTimestamp =
    conversation.lastMessageAt && conversation.lastMessageAt >= evt.timestamp
      ? new Date(conversation.lastMessageAt.getTime() + 1)
      : evt.timestamp;

  const mediaPending = Boolean(
    evt.media && !(evt.media.storageKey && evt.media.storageUrl),
  );

  const created = await createOutboundMessageIdempotent({
    teamId,
    conversationId: conversation.id,
    externalId: evt.externalId,
    senderUserId: null,
    origin: "business_app",
    body: evt.body,
    direction: "out",
    channel,
    status: "sent",
    rawPayload: evt.rawPayload as Prisma.InputJsonValue,
    timestamp: messageTimestamp,
    ...(evt.media
      ? {
          mediaKind: evt.media.kind,
          mediaMimeType: evt.media.mimeType,
          mediaCaption: evt.body || null,
          mediaFilename: evt.media.filename ?? null,
          mediaDurationMs: evt.media.durationMs ?? null,
          mediaVoice: evt.media.voice ?? null,
          ...(evt.media.storageKey && evt.media.storageUrl
            ? {
                mediaKey: evt.media.storageKey,
                mediaUrl: evt.media.storageUrl,
                mediaSizeBytes: evt.media.sizeBytes ?? null,
              }
            : {}),
        }
      : {}),
  });

  const preview = (evt.body.trim() || mediaPreview(evt.media?.kind)).slice(0, 200);
  const mediaBlock = buildEchoMediaBlock(created.id, evt.media, evt.body);
  const message: Message = {
    id: created.id,
    teamId,
    conversationId: conversation.id,
    externalId: evt.externalId,
    senderUserId: null,
    origin: "business_app",
    body: evt.body,
    direction: "out",
    channel,
    status: "sent",
    timestamp: messageTimestamp.toISOString(),
    ...(mediaBlock
      ? { media: mediaBlock, ...(mediaPending ? { mediaPending: true } : {}) }
      : {}),
  };

  // Splice-in row so a brand-new / reopened phone-initiated thread appears in a
  // teammate's loaded list without a refetch (same mechanism the inbound path
  // uses on first contact). unreadCount 0 — we clear it just below.
  const newConversation: ConversationWithRefs | undefined = isNewConversation
    ? {
        conversation: toDomainConversation({
          ...conversation,
          channel,
          lastMessageAt: messageTimestamp,
          lastMessagePreview: preview,
          lastMessageDirection: "out",
          unreadCount: 0,
        }),
        contact: toContactWire(contact),
        assignedUser: null,
        messages: [],
        notes: [],
        lastInboundAt: null,
      }
    : undefined;

  // Bump the conversation summary + publish `message.sent` (drives the thread
  // bubble, the list preview, workflows chained on outbound, and outbound
  // webhooks) — the same commit every agent/automation send goes through.
  await commitOutboundSend({
    conversationId: conversation.id,
    bumpTimestamp: messageTimestamp,
    preview,
    event: {
      type: "message.sent",
      teamId,
      conversationId: conversation.id,
      contactId: contact.id,
      message,
      preview,
      senderUserId: null,
      ...(newConversation ? { newConversation } : {}),
    },
    onMissing: () => {
      // Conversation vanished mid-ingest (rare). Nothing to bump; the row is
      // already written. Swallow — no optimistic UI is waiting on this.
    },
  });

  // Clear team-wide unread: the owner read the thread on their phone to reply.
  // CAS so a concurrent inbound bump isn't clobbered; publish conversation.read
  // ONLY on the 1→0 transition so the list badge converges (the message.sent
  // frame above doesn't touch list unread). Best-effort — a miss re-syncs on the
  // next inbound. NO Meta read receipt (the phone already sent it).
  try {
    const cleared = await db.conversation.updateMany({
      where: { id: conversation.id, teamId, unreadCount: { gt: 0 } },
      data: { unreadCount: 0 },
    });
    if (cleared.count > 0) {
      await publish({
        type: "conversation.read",
        teamId,
        conversationId: conversation.id,
        readByUserId: COEXISTENCE_ECHO_READER,
      });
    }
  } catch (err) {
    console.error(
      `[ingest] echo mark-read failed for conversation=${conversation.id}:`,
      err instanceof Error ? err.message : err,
    );
  }

  // A brand-new / revived contact is a fresh directory appearance — same as the
  // inbound + manual revive paths.
  if (isNewContact || wasRevived) {
    try {
      await publish({
        type: "contact.created",
        teamId,
        contact: toContactWire(contact),
        source: "inbound",
        createdByUserId: null,
      });
    } catch (err) {
      console.error(
        `[ingest] publish(contact.created) failed for echo team=${teamId} contact=${contact.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/**
 * WhatsApp Coexistence `smb_app_state_sync`: the owner's phone address book
 * changed. We use it ONLY to give a name to a contact that ALREADY exists in
 * the inbox and doesn't yet have an agent-set one. Deliberately conservative:
 *   - never CREATES a contact (an address-book entry who never messaged us isn't
 *     an inbox contact — creating one would bloat the directory and break the
 *     "Contact = a channel identity we converse with" rule);
 *   - never CLOBBERS a real name (the agent owns the name — same "sticky after
 *     create" policy as inbound);
 *   - `remove` is ignored (removing someone from the phone book doesn't delete
 *     an inbox contact with real conversation history).
 */
async function ingestContactSync(
  teamId: string,
  channel: Channel,
  evt: NormalizedContactSync,
): Promise<void> {
  if (evt.action === "remove" || !evt.fullName) return;

  const contact = await db.contact.findFirst({
    where: { teamId, phoneNumber: evt.phone, identityChannel: channel },
    include: { tags: { select: { id: true } } },
  });
  if (!contact) return;

  // "No agent-set name" = blank, or still the phone-number default we stamp on
  // first contact. Anything else is a real name we must not overwrite.
  const current = contact.name?.trim() ?? "";
  const hasRealName = current !== "" && current !== evt.phone;
  if (hasRealName) return;

  const { firstName, lastName } = splitContactName(evt.fullName);
  const updated = await db.contact.update({
    where: { id: contact.id },
    data: { name: evt.fullName, firstName, lastName },
    include: { tags: { select: { id: true } } },
  });

  try {
    await publish({
      type: "contact.updated",
      teamId,
      contact: toContactWire(updated),
      previousStageId: updated.stageId,
      fieldChanges: [],
      changedByUserId: null,
      workflowContact: toWorkflowContact(updated),
      // Naming from the phone book is not a business event partners subscribe
      // to — keep it out of workflow re-triggers + outbound webhooks. It's a
      // local display refresh only.
      silent: true,
    });
  } catch (err) {
    console.error(
      `[ingest] publish(contact.updated) failed for state_sync team=${teamId} contact=${contact.id}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Give social contacts (Messenger / Instagram) a real display name. Their
 * inbound webhooks carry NO name, so a fresh contact is created with its opaque
 * id (PSID / IGSID) as the name. This runs DETACHED after the webhook 200s: for
 * each still-id-named contact in the batch, fetch the profile name via the
 * provider and update it — same conservative policy as the WhatsApp phone-book
 * sync (`ingestContactSync`): never CREATE (the contact already exists from
 * ingest), never CLOBBER an agent-set name, publish `silent` (a display refresh,
 * not a business event). Fail-soft throughout — any provider/DB/creds error
 * leaves the id-as-name fallback untouched. No-op for phone channels (they get
 * the name from the webhook) or providers without `fetchContactProfile`.
 */
export async function enrichSocialContactNames(
  teamId: string,
  channel: Channel,
  externalContactIds: string[],
  opts?: { forceAvatar?: boolean },
): Promise<void> {
  if (isPhoneChannel(channel)) return;
  const unique = [...new Set(externalContactIds.filter((id) => !!id))];
  if (unique.length === 0) return;

  let binding;
  try {
    binding = getProviderBinding(channel);
  } catch {
    return;
  }
  const fetchProfile = binding.provider.fetchContactProfile;
  if (!fetchProfile) return;

  let config;
  try {
    config = await binding.getSendConfig(teamId);
  } catch {
    return; // not connected / creds missing — skip, keep the id fallback
  }

  await runWithConcurrency(unique, 4, async (extId) => {
    try {
      const contact = await db.contact.findFirst({
        where: { teamId, identityChannel: channel, externalContactId: extId },
        include: { tags: { select: { id: true } } },
      });
      if (!contact) return;

      const profile = await fetchProfile(extId, config);

      // Build the patch: fill a name still equal to the id default (never
      // overwrite a real one an agent/prior enrichment set); retain the IG
      // @username; store a profile picture when the contact has none yet.
      const current = contact.name?.trim() ?? "";
      const data: Prisma.ContactUpdateInput = {};
      if ((current === "" || current === extId) && profile.name && profile.name !== extId) {
        data.name = profile.name;
        const { firstName, lastName } = splitContactName(profile.name);
        data.firstName = firstName;
        data.lastName = lastName;
      }
      if (profile.username && contact.username !== profile.username) {
        data.username = profile.username;
      }
      // Meta's `profile_pic` is a short-lived signed CDN URL that 403s once it
      // expires — so download it into R2 and store the same-origin serve path,
      // never the raw URL. On a normal inbound we capture only ONCE (cheap: no
      // per-message re-download once we hold a `/api/contacts/…` avatar). A
      // forced sync (the panel's Refresh button) re-downloads and, via the
      // content-hash `?v`, updates only when the picture ACTUALLY changed —
      // that's what lets a customer's new IG photo flow through.
      const hasCapturedAvatar = contact.avatarUrl?.startsWith("/api/contacts/");
      if (profile.avatarUrl && (opts?.forceAvatar || !hasCapturedAvatar)) {
        const captured = await captureRemoteContactAvatar(
          contact.id,
          profile.avatarUrl,
          contact.avatarUrl,
        );
        if (captured && captured !== contact.avatarUrl) data.avatarUrl = captured;
      }
      // Instagram richer signals (follower count / verified / follow-relationship).
      // Change-gated like every other field so an unchanged profile doesn't
      // republish a `contact.updated` frame on every inbound. Absent on
      // Messenger, so this is a no-op there.
      if (profile.socialProfile) {
        const cur = (contact.socialProfile ?? {}) as SocialProfile;
        const next = profile.socialProfile;
        if (
          cur.followerCount !== next.followerCount ||
          cur.isVerified !== next.isVerified ||
          cur.followsBusiness !== next.followsBusiness ||
          cur.businessFollows !== next.businessFollows
        ) {
          data.socialProfile = next as Prisma.InputJsonValue;
        }
      }
      if (Object.keys(data).length === 0) return; // nothing new to persist

      const updated = await db.contact.update({
        where: { id: contact.id },
        data,
        include: { tags: { select: { id: true } } },
      });
      await publish({
        type: "contact.updated",
        teamId,
        contact: toContactWire(updated),
        previousStageId: updated.stageId,
        fieldChanges: [],
        changedByUserId: null,
        workflowContact: toWorkflowContact(updated),
        silent: true,
      });
    } catch (err) {
      console.error(
        `[ingest] social name enrichment failed team=${teamId} channel=${channel} id=${extId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  });
}

/**
 * WhatsApp Coexistence `history` backfill — ONE historical message (inbound or a
 * business echo). Runs on the `coexistence-history` BullMQ worker, NOT the live
 * webhook path, because a phase can carry thousands of messages.
 *
 * Deliberately QUIET vs. live ingest — these are OLD, already-handled messages:
 *   - NO unread increment (a 6-month backfill must not light up the triage badge);
 *   - NO workflow / outbound-webhook fanout (an old message must not fire "on
 *     inbound" automations);
 *   - NO per-message socket frame (a bulk import would flood every open client —
 *     the imported threads surface on the next list fetch / thread open);
 *   - conversations created here land `closed` (archived context, out of triage)
 *     — a later LIVE message reopens them via the normal inbound path.
 * Idempotent by wamid, so chunk re-delivery is safe.
 */
export interface HistoricalMessageInput {
  externalId: string;
  contactPhone: string;
  body: string;
  media?: NormalizedOutboundEcho["media"];
  timestamp: Date;
  direction: "in" | "out";
  rawPayload: Record<string, unknown>;
}

export async function ingestHistoricalMessage(
  teamId: string,
  channel: Channel,
  msg: HistoricalMessageInput,
): Promise<void> {
  const existing = await db.message.findUnique({
    where: {
      teamId_channel_externalId: { teamId, channel, externalId: msg.externalId },
    },
    select: { id: true },
  });
  if (existing) return;

  const defaultStageId = await ensureDefaultStage(teamId);
  const { firstName, lastName } = splitContactName(msg.contactPhone);

  const conversation = await runWithSerializableRetry(async (tx) => {
    const found = await tx.contact.findFirst({
      where: { teamId, phoneNumber: msg.contactPhone },
      select: { id: true },
    });
    let contactId = found?.id;
    if (!contactId) {
      const createdContact = await tx.contact.create({
        data: {
          teamId,
          identityChannel: channel,
          phoneNumber: msg.contactPhone,
          name: msg.contactPhone,
          firstName,
          lastName,
          countryCode: getCountryFromPhone(msg.contactPhone),
          stageId: defaultStageId,
          // Historical inbound sets lastInboundAt so the 24h-window UI is
          // accurate for a thread that only exists via backfill.
          ...(msg.direction === "in" ? { lastInboundAt: msg.timestamp } : {}),
        },
        select: { id: true },
      });
      contactId = createdContact.id;
    } else if (msg.direction === "in") {
      await tx.contact.updateMany({
        where: {
          id: contactId,
          OR: [{ lastInboundAt: null }, { lastInboundAt: { lt: msg.timestamp } }],
        },
        data: { lastInboundAt: msg.timestamp },
      });
    }

    const existingConvo = await tx.conversation.findFirst({
      where: { teamId, contactId },
      orderBy: { lastMessageAt: "desc" },
    });
    if (existingConvo) return existingConvo;
    // Backfilled-only threads land closed — archived context, not triage.
    return tx.conversation.create({
      data: {
        teamId,
        contactId,
        channel,
        status: "closed",
        lastMessageAt: msg.timestamp,
        lastMessagePreview: "",
      },
    });
  });

  await createOutboundMessageIdempotent({
    teamId,
    conversationId: conversation.id,
    externalId: msg.externalId,
    senderUserId: null,
    origin: msg.direction === "out" ? "business_app" : "api",
    body: msg.body,
    direction: msg.direction,
    channel,
    status: msg.direction === "out" ? "sent" : "delivered",
    rawPayload: msg.rawPayload as Prisma.InputJsonValue,
    timestamp: msg.timestamp,
    ...(msg.media
      ? {
          mediaKind: msg.media.kind,
          mediaMimeType: msg.media.mimeType,
          mediaCaption: msg.body || null,
          mediaFilename: msg.media.filename ?? null,
          mediaDurationMs: msg.media.durationMs ?? null,
          mediaVoice: msg.media.voice ?? null,
        }
      : {}),
  });

  // Advance the summary ONLY when this historical message is newer than what the
  // thread already shows (chunks arrive out of order). Monotonic guard mirrors
  // the live paths; no unread change, no socket frame.
  await db.conversation.updateMany({
    where: { id: conversation.id, lastMessageAt: { lte: msg.timestamp } },
    data: {
      lastMessageAt: msg.timestamp,
      lastMessagePreview: (msg.body.trim() || mediaPreview(msg.media?.kind)).slice(0, 200),
      lastMessageDirection: msg.direction,
    },
  });
}

/**
 * Build the domain-shape Message for the inbound `message.received` event.
 * Pure compute — called from inside the ingest transaction so the payload
 * stays consistent with what just committed. Extracted so the inline tx
 * body stays readable.
 */
function buildMessageDomain(args: {
  createdId: string;
  teamId: string;
  channel: Channel;
  conversation: { id: string };
  evt: NormalizedInboundMessage;
  replySnapshot: ReplySnapshot | null;
  mediaPending: boolean;
}): Message {
  const { createdId, teamId, channel, conversation, evt, replySnapshot, mediaPending } = args;
  return {
    id: createdId,
    teamId,
    conversationId: conversation.id,
    externalId: evt.externalId,
    senderUserId: null,
    body: evt.body,
    direction: "in",
    channel,
    status: "delivered",
    // raw_payload stays in the DB row (created above) but is deliberately
    // left off the socket payload — no client needs the verbatim Meta body.
    timestamp: evt.timestamp.toISOString(),
    // Structured interactive reply (button / list tap) when the contact
    // tapped an option. `kind` is the parser value ("button_reply" |
    // "list_reply"), `id` the stable author id, `title` the localized label.
    // Absent on plain text / media inbounds.
    ...(evt.interactiveReply ? { interactive: evt.interactiveReply } : {}),
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
            ...(evt.media.voice ? { voice: true } : {}),
            // Video poster URL — served through the same /api/media/thumb/<id>
            // auth-redirect path so the team-ownership check still gates it.
            ...(evt.media.thumbnailStorageUrl
              ? { thumbnailUrl: `/api/media/${createdId}/thumb` }
              : {}),
          },
          ...(mediaPending ? { mediaPending: true } : {}),
        }
      : {}),
  };
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
  channel: Channel;
  direction: "in" | "out";
  body: string;
  mediaKind: import("@ccp/shared/types").MediaKind | null;
  mediaCaption: string | null;
  timestamp: Date;
  senderUserId: string | null;
  /** Display name of whoever sent it — contact name for inbound. Drives
   *  `$var.message.sender_name`; empty when the call site doesn't supply it. */
  senderName?: string | null;
  /** Structured interactive reply (button / list tap). Drives the
   *  `option_id` workflow condition + `$var.message.interactive.*` tokens.
   *  Absent on plain text / media inbounds. */
  interactive?: { kind: string; id: string; title: string } | null;
  /** Public CDN URL of the attachment, when already downloaded. Null while the
   *  2-phase inbound media upload is still in flight (the trigger message is
   *  re-hydrated in the runner; recent-history messages carry it directly). */
  mediaUrl?: string | null;
}): WorkflowMessageSnapshot {
  return {
    id: m.id,
    conversationId: m.conversationId,
    externalId: m.externalId,
    channel: m.channel,
    direction: m.direction,
    body: m.body,
    mediaKind: m.mediaKind,
    mediaCaption: m.mediaCaption,
    timestamp: m.timestamp.toISOString(),
    senderUserId: m.senderUserId,
    ...(m.senderName != null ? { senderName: m.senderName } : {}),
    ...(m.interactive != null ? { interactive: m.interactive } : {}),
    ...(m.mediaUrl != null ? { mediaUrl: m.mediaUrl } : {}),
    hasMedia: m.mediaKind != null,
  };
}

function toWorkflowConversation(c: {
  id: string;
  channel: Channel;
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
  closedByApiKeyId?: string | null;
  closedCategory?: string | null;
  closedSummary?: string | null;
  assignmentsCount?: number;
  incomingMessagesCount?: number;
  outgoingMessagesCount?: number;
  responsesCount?: number;
  aiEnabled?: boolean;
}): WorkflowConversationSnapshot {
  return {
    id: c.id,
    channel: c.channel,
    status: c.status as WorkflowConversationSnapshot["status"],
    assignedUserId: c.assignedUserId,
    // Surfaced as `ai_enabled` on the message.received outbound webhook (the
    // n8n gate). Without this it defaulted to true and a paused conversation
    // still reported ai_enabled:true. Defaults true only when truly absent.
    aiEnabled: c.aiEnabled ?? true,
    unreadCount: c.unreadCount,
    lastMessageAt: c.lastMessageAt.toISOString(),
    firstAssignedAt: c.firstAssignedAt?.toISOString() ?? null,
    firstAssignedUserId: c.firstAssignedUserId ?? null,
    lastAssignedAt: c.lastAssignedAt?.toISOString() ?? null,
    firstResponseAt: c.firstResponseAt?.toISOString() ?? null,
    firstResponseByUserId: c.firstResponseByUserId ?? null,
    closedAt: c.closedAt?.toISOString() ?? null,
    closedByUserId: c.closedByUserId ?? null,
    closedByApiKeyId: c.closedByApiKeyId ?? null,
    closedCategory: c.closedCategory ?? null,
    closedSummary: c.closedSummary ?? null,
    assignmentsCount: c.assignmentsCount ?? 0,
    incomingMessagesCount: c.incomingMessagesCount ?? 0,
    outgoingMessagesCount: c.outgoingMessagesCount ?? 0,
    responsesCount: c.responsesCount ?? 0,
  };
}

export function toWorkflowContact(c: {
  id: string;
  phoneNumber: string | null;
  identityChannel?: Channel | null;
  externalContactId?: string | null;
  name: string;
  email?: string | null;
  stageId?: string | null;
  tags?: Array<{ id: string }>;
  customFields?: unknown;
  // The five new webhook-facing fields. All optional so legacy callers that
  // hand-roll a contact-shaped object (workflow steps, AI mock harnesses)
  // don't have to know about them.
  firstName?: string | null;
  lastName?: string | null;
  language?: string | null;
  countryCode?: string | null;
  avatarUrl?: string | null;
  location?: string | null;
  createdAt?: Date | string | null;
}): WorkflowContactSnapshot {
  return {
    id: c.id,
    phoneNumber: c.phoneNumber,
    identityChannel: c.identityChannel ?? null,
    externalContactId: c.externalContactId ?? null,
    name: c.name,
    email: c.email ?? null,
    stageId: c.stageId ?? null,
    tagIds: (c.tags ?? []).map((t) => t.id),
    customFields: normalizeStringMap(c.customFields),
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
  };
}

/**
 * Split a single-line contact name into firstName + lastName at the first
 * space. Matches the migration's backfill heuristic so the inbound webhook
 * path and the SQL backfill converge on the same shape.
 *
 *   "Mahdi Talal"        → { firstName: "Mahdi", lastName: "Talal" }
 *   "Mary Anne Smith"    → { firstName: "Mary",  lastName: "Anne Smith" } (lossy)
 *   "Mahdi"              → { firstName: "Mahdi", lastName: null }
 *   "" / null / phone    → { firstName: null,    lastName: null } — caller falls
 *                          back to the literal `name` field.
 */
export function splitContactName(name: string | null | undefined): {
  firstName: string | null;
  lastName: string | null;
} {
  const trimmed = name?.trim();
  if (!trimmed) return { firstName: null, lastName: null };
  const idx = trimmed.indexOf(" ");
  if (idx === -1) return { firstName: trimmed, lastName: null };
  return {
    firstName: trimmed.slice(0, idx),
    lastName: trimmed.slice(idx + 1).trim() || null,
  };
}

/** Pull the most recent N messages on the conversation, excluding the trigger
 *  message itself. Surfaced in MessageReceivedPayload.recentMessages so a
 *  downstream AI flow has short-term context without a callback. */
async function loadRecentForWorkflow(
  conversationId: string,
  excludeMessageId: string,
  // Optional tx — pass it when the caller is already inside a $transaction
  // (e.g. the inbound-ingest atomic block, which writes the outbox row in
  // the same tx and needs the recentMessages snapshot to be consistent
  // with what just committed). Without tx, runs on the global pool.
  client: { message: typeof db.message } = db,
): Promise<WorkflowMessageSnapshot[]> {
  const rows = await client.message.findMany({
    where: { conversationId, NOT: { id: excludeMessageId } },
    orderBy: { timestamp: "desc" },
    take: 10,
    select: {
      id: true,
      conversationId: true,
      externalId: true,
      channel: true,
      direction: true,
      body: true,
      mediaKind: true,
      mediaCaption: true,
      mediaUrl: true,
      timestamp: true,
      senderUserId: true,
    },
  });
  return rows
    .map((r) => toWorkflowMessage({
      id: r.id,
      conversationId: r.conversationId,
      externalId: r.externalId,
      channel: r.channel,
      direction: r.direction as "in" | "out",
      body: r.body,
      mediaKind: r.mediaKind as import("@ccp/shared/types").MediaKind | null,
      mediaCaption: r.mediaCaption,
      mediaUrl: r.mediaUrl,
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
  lastMessageDirection?: "in" | "out" | null;
  // Channel this thread lives on — drives the inbox row's channel badge. Must be
  // carried on the realtime new-conversation frame or the spliced-in row renders
  // as whatsapp (the type's absent-default) for messenger/instagram threads.
  channel: Channel;
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
    lastMessageDirection: c.lastMessageDirection ?? null,
    channel: c.channel,
  };
}


/**
 * Build a ReplySnapshot from the original message (looked up by externalId or
 * id). Used by ingest (inbound replies, externalId lookup) and the outbound
 * routes (where the caller already has the local id).
 */
export async function loadReplySnapshotByExternalId(
  externalId: string,
  scope: { teamId: string; channel: Channel },
): Promise<ReplySnapshot | null> {
  // Post the (teamId, channel, externalId) compound unique migration,
  // externalId alone isn't unique; pass the scope explicitly so cross-team
  // / cross-channel replies can't accidentally resolve to a different row.
  const row = await db.message.findUnique({
    where: {
      teamId_channel_externalId: {
        teamId: scope.teamId,
        channel: scope.channel,
        externalId,
      },
    },
    select: REPLY_TO_INCLUDE.select,
  });
  return mapReplySnapshot(row);
}

export async function loadReplySnapshotById(
  teamId: string,
  id: string,
): Promise<ReplySnapshot | null> {
  const row = await db.message.findFirst({
    where: { id, teamId },
    select: REPLY_TO_INCLUDE.select,
  });
  return mapReplySnapshot(row);
}

/**
 * Run `work` in a Serializable transaction, retrying once on Postgres
 * `40001` (serialization failure) OR `23505` (unique violation). Two
 * concurrent webhook handlers ingesting the first inbound from the same
 * brand-new phone can race the findFirst→create on both `Contact` (partial
 * unique on phone) and `Conversation` (full unique on (teamId, contactId)).
 * Serializable + a retry is the cleanest fix. In practice Postgres usually
 * fires P2034 first via predicate locking, but the unique-index backstop
 * can race ahead — we retry both signals so the loser's tx restarts cleanly
 * and finds the row the winner committed.
 */
export async function runWithSerializableRetry<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await db.$transaction(work, { isolationLevel: "Serializable" });
    } catch (err) {
      const isRaceRetryable =
        err instanceof Prisma.PrismaClientKnownRequestError &&
        (err.code === "P2034" || err.code === "P2002");
      if (!isRaceRetryable || attempt === 1) throw err;
      // Brief jitter before retry to break the symmetric-conflict cycle.
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 20));
    }
  }
  // Unreachable — the loop either returns or throws.
  throw new Error("runWithSerializableRetry: exhausted retries");
}

