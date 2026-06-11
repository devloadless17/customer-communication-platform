import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { normalizeStringMap } from "@/lib/normalize-string-map";
import { publish } from "@/lib/events/bus";
import { publishInTx } from "@/lib/events/outbox";
import { ingestCallEvent } from "@/lib/providers/ingest-call";
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
import type {
  NormalizedEvent,
  NormalizedInboundMessage,
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
} from "@ccp/shared/types";
import { mediaPreviewLabel } from "@ccp/shared/types";
import { getCountryFromPhone } from "@ccp/shared/utils";

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
      } else if (evt.kind === "template_status") {
        await ingestTemplateStatusUpdate(teamId, evt);
      } else if (evt.kind === "call") {
        // Kill-switch: WhatsApp calling is in-flight and reaches browsers via
        // realtime WebRTC signaling. DISABLE_WHATSAPP_CALLING=1 (wired in
        // docker-compose api.environment) lets ops dark-stop call ingest WITHOUT
        // a redeploy if a signaling bug surfaces — call webhooks become a no-op
        // (logged) while message ingest keeps flowing. Default OFF (calling on),
        // so this is a pure opt-out lever, no behavior change unless set.
        if (process.env.DISABLE_WHATSAPP_CALLING === "1") {
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
    await parkUnknownWamidStatus(teamId, channel, evt.externalId, evt.status);
    return;
  }

  // Decide whether `incoming` should overwrite `current`, applying both guards:
  //   - `failed` is terminal: as TARGET it wins from any non-failed state
  //     (Meta can fail a message async after delivered/read and the agent must
  //     see it); as SOURCE it's sticky (a late delivered/read can't revert a
  //     failed back to green — rank alone would allow it since rank(failed)=-1).
  //   - Otherwise the monotonic rank guard (sent < delivered < read) wins.
  const winsOver = (incoming: Message["status"], current: Message["status"]): boolean => {
    if (current === "failed") return false; // failed is terminal — nothing overwrites it
    if (incoming === "failed") return true; // failure overwrites any non-failed
    return statusRank(incoming) > statusRank(current as Message["status"]);
  };

  if (!winsOver(evt.status, existing.status as Message["status"])) return;

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
    if (!winsOver(evt.status, current.status as Message["status"])) return; // lost legitimately
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
  if (!evt.status) return; // unmappable event value — nothing to write

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
    data: { status: evt.status },
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

async function parkUnknownWamidStatus(
  teamId: string,
  channel: Channel,
  externalId: string,
  status: Message["status"],
): Promise<void> {
  const key = parkKey(teamId, channel, externalId);
  const redis = getRedisConnection();
  try {
    if (status === "failed") {
      // Terminal — overwrite anything already parked.
      await redis.set(key, status, "PX", UNKNOWN_WAMID_TTL_MS);
      return;
    }
    const existing = await redis.get(key);
    if (existing) {
      // Don't downgrade — `failed` stays put, lower ranks lose to higher.
      if (existing === "failed") return;
      if (statusRank(status) <= statusRank(existing as Message["status"])) return;
    }
    await redis.set(key, status, "PX", UNKNOWN_WAMID_TTL_MS);
  } catch (err) {
    // Redis hiccup must not abort the webhook 200. Losing one parked status
    // is recoverable — Meta typically resends the next-rank event soon after.
    console.error(
      `[ingest] parkUnknownWamidStatus failed for ${key}: ${err instanceof Error ? err.message : err}`,
    );
  }
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
  let parked: Message["status"] | null = null;
  try {
    const raw = await redis.getdel(key);
    parked = raw as Message["status"] | null;
  } catch (err) {
    console.error(
      `[ingest] drainParkedStatus(${key}) failed: ${err instanceof Error ? err.message : err}`,
    );
    return;
  }
  if (!parked) return;
  await db.message.update({
    where: { id: messageId },
    data: { status: parked },
  });
  await publish({
    type: "message.status_changed",
    teamId,
    conversationId,
    contactId,
    messageId,
    status: parked,
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
  const { contact, conversation, isNewContact, wasRevived, isNewConversation, reopened } = await runWithSerializableRetry(
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
      // findFirst (not findUnique) because the WhatsApp phone unique moved
      // to a partial index — no Prisma key to look up by. We still see both
      // active AND soft-deleted rows so the revive path works, since the
      // partial unique constrains across deletedAt too (the tombstone holds
      // the slot; see schema comment on Contact phoneNumber).
      //
      // TODO(multi-channel / F4 in docs/architecture-review-2026-05-25.md):
      // This lookup keys on `phoneNumber` ONLY and does NOT filter by channel.
      // Correct today because WhatsApp is the only channel. BEFORE shipping a
      // second channel (Telegram/Instagram), this MUST switch to the
      // channel-aware identity: for phone channels keep `phoneNumber`, for
      // non-phone channels look up by the compound unique
      // `(teamId, identityChannel, externalContactId)`. Otherwise a Telegram
      // contact sharing a phone with a WhatsApp contact resolves to the wrong
      // row. The SCHEMA is already correct (partial phone unique + compound
      // unique) — only THIS query needs the switch. Don't ship channel #2
      // without it.
      const existingContact = await tx.contact.findFirst({
        where: { teamId, phoneNumber: evt.contactPhone },
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

      const { firstName, lastName } = splitContactName(evt.contactName ?? evt.contactPhone);
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
        });
      } else {
        contact = await tx.contact.create({
          data: {
            teamId,
            // Explicit channel stamp — every new contact carries its channel.
            identityChannel: channel,
            phoneNumber: evt.contactPhone,
            name: evt.contactName ?? evt.contactPhone,
            // Populate the new webhook-facing fields on create. Splitting the
            // name + deriving the country code on first contact matches what
            // the migration does for backfill — both paths converge on the
            // same shape so webhook receivers don't see partial rows.
            firstName,
            lastName,
            countryCode: getCountryFromPhone(evt.contactPhone),
            stageId: defaultStageId,
          },
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
      let reopened = false;
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
        // Reopen. We bump to `pending` (matches the new-thread default) so
        // the conversation re-enters the triage column instead of jumping
        // straight to `open`, which would imply an agent has it.
        conversation = await tx.conversation.update({
          where: { id: conversation.id },
          data: { status: "pending" },
        });
        reopened = true;
      }
      return { contact, conversation, isNewContact, wasRevived, isNewConversation, reopened };
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
      // Monotonicity guard. Meta delivers at-least-once with NO ordering
      // guarantee — retries and webhook replay can land an OLDER message
      // after a newer one. Read the current summary inside the tx and only
      // ADVANCE lastMessageAt/lastMessagePreview when this message is the
      // newest the conversation has seen; otherwise leave the summary alone
      // so a late older inbound can't clobber the list preview (the bug that
      // left "Cont" pinned after "A"/"P" arrived). unreadCount +
      // incomingMessagesCount still increment for EVERY inbound regardless of
      // order — they're counts, not a "latest" pointer. Mirrors the outbound
      // guard in commitOutboundEvent / send-text-internal, which the inbound
      // path was missing. `>=` (not `>`) so a brand-new conversation, whose
      // create set lastMessageAt = this same evt.timestamp, still writes its
      // first preview.
      const summaryBefore = await tx.conversation.findUnique({
        where: { id: conversation.id },
        select: { lastMessageAt: true, lastMessagePreview: true },
      });
      const advancesSummary =
        !summaryBefore || evt.timestamp >= summaryBefore.lastMessageAt;
      const bumped = await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          ...(advancesSummary
            ? { lastMessageAt: evt.timestamp, lastMessagePreview: preview }
            : {}),
          unreadCount: { increment: 1 },
          incomingMessagesCount: { increment: 1 },
        },
        select: { unreadCount: true },
      });

      // The realtime frame + workflow snapshot must carry the EFFECTIVE newest
      // summary, not this (possibly older) message's, so an out-of-order
      // inbound never pushes a stale preview to the inbox list.
      const effectiveLastMessageAt =
        advancesSummary || !summaryBefore
          ? evt.timestamp
          : summaryBefore.lastMessageAt;
      const effectivePreview =
        advancesSummary || !summaryBefore ? preview : summaryBefore.lastMessagePreview;
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
                lastMessageAt: evt.timestamp,
                lastMessagePreview: preview,
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
  closedCategory?: string | null;
  closedSummary?: string | null;
  assignmentsCount?: number;
  incomingMessagesCount?: number;
  outgoingMessagesCount?: number;
  responsesCount?: number;
}): WorkflowConversationSnapshot {
  return {
    id: c.id,
    channel: c.channel,
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

