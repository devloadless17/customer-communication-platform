import { Prisma } from "@prisma/client";
import type { BroadcastDeliveryState } from "@prisma/client";

import { db } from "@/lib/db";
import { runWithConcurrency } from "@/common/concurrency";
import { captureRemoteContactAvatar } from "@/lib/blob-storage/avatar";
import { getProviderBinding } from "@/lib/providers";
import {
  persistWhatsappHealth,
  resolveWhatsappHealthAccount,
} from "@/lib/providers/meta-health";
import { classifyMetaStatusError } from "@/lib/providers/meta-send-error";
import { normalizeStringMap } from "@/lib/normalize-string-map";
import { publish } from "@/lib/events/bus";
import { kickOutbox, publishInTx } from "@/lib/events/outbox";
import { commitOutboundSend } from "@/lib/messaging/commit-outbound-send";
import {
  createOutboundMessageIdempotent,
  createOutboundMessageIdempotentDetailed,
} from "@/lib/messages/idempotent-create";
import { ingestCallEvent } from "@/lib/providers/ingest-call";
import { reconcileCanonicalWaId } from "@/lib/identity/canonical-wa-id";
import { syncTemplateCatalog } from "@/lib/templates/catalog-sync";
import { resumeOnReopen } from "@/lib/ai/conversation-state";
import { routeMessageToTicket } from "@/lib/tickets/mutations";
import { applyContactShareFromReply } from "@/lib/identity/contact-share";
import {
  applyOptOut,
  attributeInboundToBroadcast,
  clearOptOut,
} from "@/lib/broadcast-attribution";
import { resolveCustomerId, findExistingCustomerIdByStrongKey } from "@/lib/identity/identity-service";
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
  NormalizedContactNumberChange,
  NormalizedEvent,
  NormalizedInboundMessage,
  NormalizedMessageCorrection,
  NormalizedMessageFeedback,
  NormalizedOutboundEcho,
  NormalizedReaction,
  NormalizedReadWatermark,
  NormalizedDeliveredWatermark,
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
import { isPhoneChannel, isSocialContactPlaceholder } from "@ccp/shared/providers/capabilities";

/**
 * Provider-agnostic ingest pipeline.
 *
 *   normalized event → dedupe → upsert contact/conversation → create message
 *                    → bump conversation summary → emit `message:new`
 *
 * One entry point per route. Routes never touch the DB or Socket.io directly.
 *
 * `workspaceId` is resolved by the caller (the per-team webhook URL contains it,
 * so the route trusts it) and keys EVERY lookup — status updates included,
 * which resolve on the compound (workspaceId, channel, externalId) unique.
 */

export async function ingestEvents(
  workspaceId: string,
  channel: Channel,
  events: NormalizedEvent[],
  /**
   * The ChannelConnection that RECEIVED these events. Stamped onto the
   * conversation so replies go back out the same account — re-stamped on every
   * inbound, because a customer who messages a different number of yours has
   * moved the live thread (and its 24h window) to THAT account.
   *
   * ONE account for the whole array, so callers MUST partition a webhook batch
   * first — `groupEventsByInboundAccount` — and call once per group. Meta batches
   * changes for several of a workspace's accounts into a single POST, and passing
   * one account for a mixed batch re-pointed the sibling's threads at the wrong
   * number.
   *
   * `undefined`/null means the events name no receiving account: WhatsApp's
   * account-level notification class, whose subject each branch below resolves
   * per-event from the payload's own hints.
   */
  channelConnectionId?: string | null,
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
  // Group events by the CONTACT they touch so same-contact events run
  // SEQUENTIALLY (one lane) while different contacts still parallelize. The N
  // media siblings of one multi-attachment message — or a rapid burst from one
  // person — otherwise ran concurrently across lanes and issued competing
  // `contact.update()`s on the same row, which Serializable-conflict (P2034);
  // under load the per-event retries exhaust and a perfectly valid message 503s
  // (→ Meta redelivery). Events with no contact key (status / template / etc.)
  // get a unique bucket and parallelize exactly as before. Sequential order
  // within a contact also pins the primary message ahead of its media siblings.
  const groups = new Map<string, NormalizedEvent[]>();
  events.forEach((evt, i) => {
    // Key on whichever contact identity the event carries — phone channels
    // (WhatsApp) set `contactPhone`, non-phone channels (Messenger/Instagram)
    // set `externalContactId`, and a BSUID-only inbound sets `bsuid`. Keying
    // only on externalContactId would leave WhatsApp — the primary channel — in
    // per-event `u:` buckets, so a rapid same-person burst would still
    // Serializable-conflict on contact.update(). Events with no contact identity
    // (status / template_status) fall to the unique bucket and parallelize.
    const key =
      "externalContactId" in evt && evt.externalContactId
        ? `c:${evt.externalContactId}`
        : "contactPhone" in evt && evt.contactPhone
          ? `p:${evt.contactPhone}`
          : "bsuid" in evt && evt.bsuid
            ? `b:${evt.bsuid}`
            : `u:${i}`;
    const g = groups.get(key);
    if (g) g.push(evt);
    else groups.set(key, [evt]);
  });
  const groupQueue = [...groups.values()];
  const lanes = Math.min(INGEST_CONCURRENCY, groupQueue.length);
  const runOne = async (evt: NormalizedEvent): Promise<void> => {
    try {
      if (evt.kind === "message") {
        await ingestInboundMessage(workspaceId, channel, evt, channelConnectionId);
      } else if (evt.kind === "echo") {
        // WhatsApp Coexistence: a message the owner sent from the phone app.
        // The account is threaded through: a thread this creates would
        // otherwise carry NO `channelConnectionId`, and since the
        // account-unresolved guard landed that makes it unsendable from the
        // inbox in any multi-account workspace until the customer happens to
        // send an inbound. The owner starting a brand-new chat on their phone
        // is exactly when that bites.
        await ingestOutboundEcho(workspaceId, channel, evt, channelConnectionId);
      } else if (evt.kind === "contact_sync") {
        // WhatsApp Coexistence: the owner's phone address book changed.
        await ingestContactSync(workspaceId, channel, evt);
      } else if (evt.kind === "reaction") {
        await ingestReaction(workspaceId, channel, evt);
      } else if (evt.kind === "message_correction") {
        await ingestMessageCorrection(workspaceId, channel, evt);
      } else if (evt.kind === "message_feedback") {
        await ingestMessageFeedback(workspaceId, channel, evt);
      } else if (evt.kind === "read_watermark") {
        await ingestReadWatermark(workspaceId, channel, evt);
      } else if (evt.kind === "delivered_watermark") {
        await ingestDeliveredWatermark(workspaceId, channel, evt);
      } else if (evt.kind === "contact_number_change") {
        await ingestContactNumberChange(workspaceId, channel, evt);
      } else if (evt.kind === "template_status") {
        await ingestTemplateStatusUpdate(workspaceId, evt);
      } else if (evt.kind === "template_components_changed") {
        await ingestTemplateComponentsChanged(workspaceId);
      } else if (evt.kind === "marketing_preference") {
        // Marketing opt-out / resume from Meta. Resolve the contact by phone
        // within this team, then set or clear consent.
        // EXACT match, deliberately. Both sides are digits-only through the
        // one normalizer (wa_id wire shape), and this toggles CONSENT — the
        // old `contains` could cross-match ("1234567890" is a substring of
        // "11234567890") and flip the wrong contact's opt-out. A miss fails
        // closed (no-op), and the wa_id-vs-stored-digits divergence cases
        // (BR/MX prefixes) are the canonical-wa-id reconciler's job now.
        const contact = await db.contact.findFirst({
          where: { workspaceId, phoneNumber: evt.contactPhone, deletedAt: null },
          select: { id: true },
        });
        if (contact) {
          if (evt.optedOut) {
            await applyOptOut(workspaceId, contact.id, "meta_preferences", evt.timestamp);
          } else {
            await clearOptOut(workspaceId, contact.id);
          }
        }
      } else if (evt.kind === "number_name_update") {
        // Display-name review concluded. Resolve WHICH number the same way
        // channel-health does; an unresolvable update is dropped with a warn
        // rather than stamped on an arbitrary sibling.
        // Payload hints FIRST, the arriving account only as a fallback. Each
        // hint (an exact display number, or a WABA holding exactly one of our
        // numbers) names this event's own subject, which is strictly more
        // specific than "the account this group arrived on". With the old order
        // a POST batching a `messages` change together with a name update wrote
        // the MESSAGE's number as the name-update subject.
        const nameTarget =
          (await resolveWhatsappHealthAccount(workspaceId, {
            ...(evt.displayPhoneNumber
              ? { displayPhoneNumber: evt.displayPhoneNumber }
              : {}),
            ...(evt.wabaId ? { wabaId: evt.wabaId } : {}),
          })) ??
          channelConnectionId;
        if (nameTarget) {
          // Meta's DECISION vocabulary (phone-number-name-update reference:
          // APPROVED | REJECTED | PENDING | DEFERRED) maps onto name_status's
          // richer set. The old binary mapping branded a merely-PENDING review
          // as DECLINED — an alarming false "no certificate" state while Meta
          // was still deciding. An unknown future decision writes NOTHING
          // (never-clobber; the periodic Graph poll remains the reconciler).
          const decision = evt.decision.toUpperCase();
          const nameStatus =
            decision === "APPROVED"
              ? "APPROVED"
              : decision === "REJECTED"
                ? "DECLINED"
                : decision === "PENDING" || decision === "DEFERRED"
                  ? "PENDING_REVIEW"
                  : null;
          const approved = decision === "APPROVED";
          await db.channelConnection.updateMany({
            where: { id: nameTarget, workspaceId, channel: "whatsapp" },
            data: {
              ...(nameStatus ? { nameStatus } : {}),
              // Only an approval changes the live name; a rejection keeps the
              // previous verified name in service.
              ...(approved && evt.requestedVerifiedName
                ? { verifiedName: evt.requestedVerifiedName }
                : {}),
              // A rejection's WHY (NAME_EMPLOYEE_ISSUE, NAME_NOT_CONSISTENT, …)
              // is the operator's fix guidance — stamp it as this number's
              // last-alert so the health panel explains the DECLINED badge.
              ...(decision === "REJECTED"
                ? {
                    lastAccountAlert: {
                      source: "phone_number_name_update",
                      event: evt.rejectionReason ?? "REJECTED",
                      detail: `Display name "${evt.requestedVerifiedName ?? "(unknown)"}" was rejected${evt.rejectionReason ? ` (${evt.rejectionReason})` : ""} — edit it in WhatsApp Manager per the display-name guidelines.`,
                      // Same field name persistWhatsappHealth stamps, so the
                      // slot's shape is uniform whichever path wrote it.
                      observedAt: new Date().toISOString(),
                    } as Prisma.InputJsonValue,
                  }
                : {}),
              // An APPROVAL is not the end of the flow, which is the part that is
              // easy to miss. Meta's display-name doc: "After the display name
              // change is approved, you must re-register the phone number… Wait for
              // the phone_number_name_update webhook with decision set to APPROVED.
              // Call POST /<PHONE_NUMBER_ID>/register." Until that happens the new
              // name is approved but NOT live on WhatsApp — and the operator has no
              // way to know, because every surface we render says APPROVED.
              //
              // Worse, it expires: "you have 14 days to re-register… If the 14-day
              // window expires without re-registration, you must submit the display
              // name for review again." So this is a deadline, not a nicety. Stamped
              // as the account alert (same slot as a rejection) so the settings
              // panel shows it beside the number, next to the Register action that
              // completes it.
              ...(approved
                ? {
                    lastAccountAlert: {
                      source: "phone_number_name_update",
                      event: "APPROVED_PENDING_REREGISTER",
                      detail:
                        `Display name "${evt.requestedVerifiedName ?? "(unknown)"}" was APPROVED, but it is ` +
                        `not live until this number is re-registered. Re-register it within 14 days — after ` +
                        `that the name has to go through review again.`,
                      observedAt: new Date().toISOString(),
                    } as Prisma.InputJsonValue,
                  }
                : {}),
            },
          });
        } else {
          console.warn(
            `[ingest] dropped unattributable phone_number_name_update for team=${workspaceId}` +
              `${evt.displayPhoneNumber ? ` number=${evt.displayPhoneNumber}` : ""}`,
          );
        }
      } else if (evt.kind === "channel_health") {
        // WhatsApp number messaging-limit tier / quality / throughput changed.
        // Account-level webhooks name no receiving number, so the controller
        // passes no channelConnectionId — resolve the subject from the hints
        // the payload DOES carry (its display number, or a WABA holding
        // exactly one of our numbers) before persisting. An unresolvable
        // per-number signal is dropped inside persistWhatsappHealth rather
        // than stamped onto an arbitrary sibling.
        // Hints FIRST (same reasoning as number_name_update above): a mixed
        // batch used to write number B's quality/tier onto number A because the
        // arriving account short-circuited this lookup.
        const healthTarget =
          (await resolveWhatsappHealthAccount(workspaceId, {
            ...(evt.phoneNumberId ? { phoneNumberId: evt.phoneNumberId } : {}),
            ...(evt.displayPhoneNumber
              ? { displayPhoneNumber: evt.displayPhoneNumber }
              : {}),
            ...(evt.wabaId ? { wabaId: evt.wabaId } : {}),
          })) ??
          channelConnectionId;
        await persistWhatsappHealth(workspaceId, {
          ...(evt.messagingTier !== undefined ? { messagingTier: evt.messagingTier } : {}),
          ...(evt.qualityRating !== undefined ? { qualityRating: evt.qualityRating } : {}),
          ...(evt.callingRestrictedUntil !== undefined
            ? {
                callingRestrictedUntil: evt.callingRestrictedUntil,
                callingRestrictionType: evt.callingRestrictionType ?? null,
                callingRestrictionReason: evt.callingRestrictionReason ?? null,
              }
            : {}),
          ...(evt.policyViolationType !== undefined
            ? { policyViolationType: evt.policyViolationType }
            : {}),
          ...(evt.callingQualityWarning !== undefined
            ? { callingQualityWarning: evt.callingQualityWarning }
            : {}),
          ...(evt.throughputLevel !== undefined
            ? { throughputLevel: evt.throughputLevel }
            : {}),
          ...(evt.utilityRestrictionType !== undefined
            ? {
                utilityRestrictionType: evt.utilityRestrictionType,
                utilityRestrictedUntil: evt.utilityRestrictedUntil ?? null,
              }
            : {}),
          ...(evt.bizMessagingRestrictionType !== undefined
            ? {
                bizMessagingRestrictionType: evt.bizMessagingRestrictionType,
                bizMessagingRestrictedUntil: evt.bizMessagingRestrictedUntil ?? null,
              }
            : {}),
          ...(evt.customerMessagingRestrictionType !== undefined
            ? {
                customerMessagingRestrictionType: evt.customerMessagingRestrictionType,
                customerMessagingRestrictedUntil:
                  evt.customerMessagingRestrictedUntil ?? null,
              }
            : {}),
          ...(evt.accountAlert !== undefined ? { accountAlert: evt.accountAlert } : {}),
        },
        // Attribute the signal to the account whose webhook delivered it.
        // Quality / throughput / calling restrictions are per-NUMBER, so a
        // workspace-wide write would mark every sibling number degraded.
        healthTarget ?? null,
        evt.wabaId ?? null);
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
              workspaceId,
              channel,
            }),
          );
        } else {
          await ingestCallEvent(workspaceId, channel, evt, channelConnectionId);
        }
      } else {
        await ingestStatusUpdate(workspaceId, channel, evt);
      }
    } catch (err) {
        // Structured log — fields chosen so a flood of identical errors is
        // greppable as a single event in ops (key = workspaceId+kind+code).
        // Stack included so a real bug isn't hidden, but never the raw
        // body / phone number (those live in `rawPayload` on the message
        // row for forensic queries that go through DB, not log search).
        const externalId =
          "externalId" in evt ? evt.externalId : undefined;
        console.error(
          JSON.stringify({
            event: "ingest.event_failed",
            severity: "error",
            workspaceId,
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
        // Every event is deduped on (workspaceId, channel, externalId) so re-
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
    while (groupQueue.length > 0) {
      const group = groupQueue.shift();
      if (group === undefined) return;
      // Sequential within a contact (primary before its media siblings) so
      // there's no same-row write conflict; distinct-contact groups run parallel.
      for (const evt of group) await runOne(evt);
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
      err.code === "P2024" /* pool timeout (Rust engine only — see below) */ ||
      err.code === "P2034" /* write conflict / deadlock */ ||
      err.code === "P2028" /* interactive-tx maxWait/timeout — rolled back, retry-safe */ ||
      err.code === "P1001" /* server unreachable */ ||
      err.code === "P1002" /* connection timeout */ ||
      err.code === "P1008" /* operation timeout */
    );
  }
  // DB unreachable at connect time surfaces as an init error, not a known
  // request error — also transient.
  if (err instanceof Prisma.PrismaClientInitializationError) return true;
  return isDriverTransientError(err);
}

/**
 * Transient faults raised by the `pg` DRIVER rather than by Prisma.
 *
 * This function exists because of a silent regression: pool exhaustion used to
 * arrive as `PrismaClientKnownRequestError` P2024, emitted by Prisma's own Rust
 * engine pool. Since the move to driver adapters (`@prisma/adapter-pg`, see
 * DbService) the pool is `pg-pool`, whose acquisition timeout is a BARE
 * `Error("timeout exceeded when trying to connect")` — no `.code`, not a Prisma
 * error class. So the P2024 branch above became unreachable, and a pool timeout
 * fell through to "permanent poison": the event was swallowed, the webhook
 * answered 200 {dropped}, and Meta — which has no history sync — never
 * redelivered. In other words, inbound customer messages were dropped precisely
 * when the system was busiest, which is the exact failure the surrounding
 * comments say must never happen.
 *
 * Matches on SQLSTATE where the driver provides one, and on message shape for
 * the pool/socket errors that carry no code. Erring toward "transient" is the
 * safe direction here: a redelivery is deduped by (workspaceId, channel, externalId),
 * whereas a wrong "permanent" verdict loses a customer's message for good.
 */
export function isDriverTransientError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;

  // SQLSTATE from node-postgres, when present.
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") {
    if (
      code === "53300" /* too_many_connections */ ||
      code === "53400" /* configuration_limit_exceeded */ ||
      code === "57P01" /* admin_shutdown (failover/restart) */ ||
      code === "57P02" /* crash_shutdown */ ||
      code === "57P03" /* cannot_connect_now (starting up) */ ||
      code === "08000" /* connection_exception */ ||
      code === "08001" /* sqlclient_unable_to_establish_sqlconnection */ ||
      code === "08003" /* connection_does_not_exist */ ||
      code === "08004" /* rejected */ ||
      code === "08006" /* connection_failure */ ||
      code === "40001" /* serialization_failure */ ||
      code === "40P01" /* deadlock_detected */ ||
      code === "55P03" /* lock_not_available */ ||
      code === "57014" /* query_canceled — our statement_timeout */ ||
      // Socket-level failures reaching us as errno strings.
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      code === "EPIPE" ||
      code === "EHOSTUNREACH" ||
      code === "ENOTFOUND"
    ) {
      return true;
    }
  }

  // THE DRIVER ADAPTER'S OWN ERROR CLASS. `@prisma/adapter-pg` raises
  // `DriverAdapterError` (from PgTransaction.onError) whose `message` is a bare
  // kind name like "TransactionWriteConflict" — no `.code`, no SQLSTATE, and
  // none of Prisma's text. So a serialization conflict that escapes
  // `runWithSerializableRetry` matched NOTHING above (P2034 and 40001 are both
  // covered, but neither is what arrives) and was classified as permanent
  // poison: swallowed, webhook answered 200, and Meta — which has no history
  // sync — never redelivered. An inbound customer message lost for good, under
  // load, which is exactly the failure the comments here say must never happen.
  //
  // This is the SECOND time this function was defeated by the error's SHAPE
  // changing rather than by a missing condition (the first was the pg-pool
  // timeout above). Measured by the B-M5 burst harness: a 500-webhook storm
  // reproducibly lost 1-2 messages this way, each answered 200 on its only
  // delivery. Checked BEFORE the message-text matching below because these
  // carry no code and no recognizable sentence.
  const cause = (err as { cause?: { kind?: unknown } }).cause;
  const causeKind = typeof cause?.kind === "string" ? cause.kind : "";
  if (
    (err as { name?: unknown }).name === "DriverAdapterError" &&
    (causeKind === "TransactionWriteConflict" ||
      causeKind === "SocketTimeout" ||
      causeKind === "ConnectionClosed")
  ) {
    return true;
  }

  const message = (err as { message?: unknown }).message;
  if (typeof message !== "string" || message.length === 0) return false;
  const m = message.toLowerCase();
  return (
    // Same driver-adapter errors matched by TEXT as well as by cause kind:
    // the adapter has moved this detail between `cause.kind` and `message`
    // across releases, and being wrong in the "permanent" direction costs a
    // customer message while being wrong the other way costs one deduped
    // redelivery. Match both.
    m === "transactionwriteconflict" ||
    m.includes("write conflict") ||
    m.includes("deadlock") ||
    m.includes("could not serialize") ||
    // pg-pool acquisition timeout — the regression this function was written for.
    m.includes("timeout exceeded when trying to connect") ||
    m.includes("connection terminated due to connection timeout") ||
    m.includes("connection terminated unexpectedly") ||
    m.includes("connection ended unexpectedly") ||
    m.includes("too many clients already") ||
    m.includes("the database system is starting up") ||
    m.includes("terminating connection due to administrator command") ||
    m.includes("cannot use a pool after calling end")
  );
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
  workspaceId: string,
  channel: Channel,
  evt: NormalizedReaction,
): Promise<void> {
  const target = await db.message.findUnique({
    where: {
      workspaceId_channel_externalId: {
        workspaceId,
        channel,
        externalId: evt.targetExternalId,
      },
    },
    select: { id: true, conversationId: true, reaction: true },
  });
  // Reaction to a message we don't have a row for — nothing to attach it to.
  // Log it (not silent): a reaction whose target mid never matches a stored
  // outbound message is the signature of a mid-format mismatch — the leading
  // diagnostic for "reactions don't work on <channel>" (e.g. Messenger). If this
  // NEVER logs on that channel, the webhook isn't arriving at all (a missing
  // `message_reactions` page subscription), which is the OTHER likely cause.
  if (!target) {
    console.warn(
      JSON.stringify({
        event: "reaction.target_not_found",
        severity: "info",
        channel,
        targetExternalId: evt.targetExternalId,
        hasEmoji: evt.emoji != null,
      }),
    );
    return;
  }
  // Canonicalize the emoji by dropping the VS16 presentation selector (U+FE0F)
  // so the comparisons below can't miss on `❤` vs `❤️` — Meta is inconsistent
  // about sending it. The bubble re-adds emoji presentation at render.
  const incoming = evt.emoji ? evt.emoji.replace(/\uFE0F/g, "") : null;

  let next: string | null;
  if (target.reaction === incoming) {
    // Identical reaction re-arriving. On SOCIAL channels this is the REMOVE:
    // Instagram (and Messenger) report an un-reaction as the SAME emoji tapped
    // again rather than an explicit empty/unreact, so a repeat of the current
    // reaction toggles it OFF — matching the apps' tap-again-to-remove. WhatsApp
    // sends an explicit empty-emoji remove and never re-sends the same glyph, so
    // its identical re-arrival stays a pure no-op (a Meta at-least-once
    // redelivery must not clear a still-present WhatsApp reaction).
    const isSocial = channel === "messenger" || channel === "instagram";
    if (isSocial && incoming != null) {
      next = null;
    } else {
      return; // genuine no-op (redelivery / already-cleared)
    }
  } else {
    next = incoming;
  }

  await db.message.update({
    where: { id: target.id },
    data: { reaction: next },
  });

  await publish({
    type: "message.reaction_changed",
    workspaceId,
    conversationId: target.conversationId,
    messageId: target.id,
    actor: "customer",
    emoji: next,
  });
}

/**
 * Apply a customer message unsend/edit (WhatsApp revoke·edit, Messenger/
 * Instagram unsend). Finds the target Message by (workspaceId, channel,
 * targetExternalId) and either tombstones it (`deletedAt`, body PRESERVED for
 * the record) or updates its body (`editedAt` + new body), then fans out
 * `message.updated` so viewers patch the bubble. Idempotent: a re-delivered
 * delete/edit that matches the current state is a no-op (skips the socket
 * churn). UI-only — no workflow/webhook fanout (a customer editing their own
 * message isn't a business event).
 */
async function ingestMessageCorrection(
  workspaceId: string,
  channel: Channel,
  evt: NormalizedMessageCorrection,
): Promise<void> {
  const target = await db.message.findUnique({
    where: {
      workspaceId_channel_externalId: { workspaceId, channel, externalId: evt.targetExternalId },
    },
    select: { id: true, conversationId: true, body: true, deletedAt: true, direction: true },
  });
  // Correction for a message we never stored — nothing to patch.
  if (!target) return;
  // Direction PIN. A customer edit/unsend applies ONLY to their own (inbound)
  // message — never to one WE sent — and, symmetrically, an owner-echo
  // correction (Coexistence Business-App revoke/edit, expectedDirection:"out")
  // applies only to OUTBOUND rows and must never tombstone a customer's
  // message. Without the pin, a malformed/replayed correction whose target
  // wamid resolves to the other side's row would silently rewrite it.
  if (target.direction !== (evt.expectedDirection ?? "in")) return;
  // Already tombstoned (re-delivery) — skip write + fanout.
  if (evt.action === "delete" && target.deletedAt) return;

  const now = evt.timestamp;
  if (evt.action === "delete") {
    await db.message.update({
      where: { id: target.id },
      data: { deletedAt: now },
    });
    // If this was the thread's newest message, the inbox-list preview now shows
    // deleted text — repoint it (DB) and carry the new preview on the event so
    // fanout pushes a live `conversation:preview` frame to the list.
    const listUpdate = await refreshPreviewSafely(workspaceId, target.conversationId, target.id);
    await publish({
      type: "message.updated",
      workspaceId,
      conversationId: target.conversationId,
      messageId: target.id,
      deletedAt: now.toISOString(),
      editedAt: null,
      body: null,
      ...(listUpdate
        ? { listPreview: listUpdate.preview, listPreviewAt: listUpdate.at }
        : {}),
    });
    return;
  }
  // Edit: replace the body (no-op if identical) + mark edited. ONLY when we have
  // the actual new text — an edit event whose new content the parser couldn't
  // extract (media-only caption edit / an unhandled shape) must NOT wipe the
  // stored body to empty; skip rather than corrupt (the original content stays).
  const newBody = evt.newBody;
  if (newBody === undefined || newBody === "") return;
  if (target.body === newBody) return;
  await db.message.update({
    where: { id: target.id },
    data: { body: newBody, editedAt: now },
  });
  // Keep the inbox-list preview in sync if this was the newest message, and
  // carry it on the event so fanout pushes a live `conversation:preview` frame.
  const listUpdate = await refreshPreviewSafely(workspaceId, target.conversationId, target.id);
  await publish({
    type: "message.updated",
    workspaceId,
    conversationId: target.conversationId,
    messageId: target.id,
    deletedAt: null,
    editedAt: now.toISOString(),
    body: newBody,
    ...(listUpdate
      ? { listPreview: listUpdate.preview, listPreviewAt: listUpdate.at }
      : {}),
  });
}

/**
 * A customer gave 👍/👎 feedback on a message the BUSINESS sent (Messenger
 * `response_feedback` — Meta's business-message feedback, NOT an emoji
 * reaction). Patch the target OUTBOUND message's `feedback` column and fan out
 * `message.updated` so the bubble shows the helpful/not-helpful chip live.
 * Idempotent: a re-delivery of the same value is a no-op. UI-only (like
 * reactions) — no workflow / outbound-webhook fanout.
 */
async function ingestMessageFeedback(
  workspaceId: string,
  channel: Channel,
  evt: NormalizedMessageFeedback,
): Promise<void> {
  const target = await db.message.findUnique({
    where: {
      workspaceId_channel_externalId: { workspaceId, channel, externalId: evt.targetExternalId },
    },
    select: { id: true, conversationId: true, feedback: true, direction: true },
  });
  // Feedback is the customer rating a message WE sent — only ever on outbound.
  if (!target || target.direction !== "out") return;
  if (target.feedback === evt.feedback) return; // unchanged — skip write + fanout
  await db.message.update({
    where: { id: target.id },
    data: { feedback: evt.feedback },
  });
  await publish({
    type: "message.updated",
    workspaceId,
    conversationId: target.conversationId,
    messageId: target.id,
    deletedAt: null,
    editedAt: null,
    body: null,
    feedback: evt.feedback,
  });
}

/**
 * `refreshPreviewIfNewestCorrected`, but a failure NEVER blocks the caller's
 * `message.updated` publish. The list preview is a denormalized convenience
 * (a drift sweeper + the next read both re-derive it); the realtime frame that
 * tombstones the bubble is not. Letting a transient DB error here throw would
 * skip the publish entirely — and the correction is already committed, so
 * Meta's redelivery hits the `deletedAt` / identical-body early return and the
 * frame is lost for good. Degrade to "no live preview frame" instead.
 */
async function refreshPreviewSafely(
  workspaceId: string,
  conversationId: string,
  correctedMessageId: string,
): Promise<{ preview: string; at: string } | null> {
  try {
    return await refreshPreviewIfNewestCorrected(workspaceId, conversationId, correctedMessageId);
  } catch (err) {
    console.error(
      `[ingest] list-preview refresh failed for team=${workspaceId} conversation=${conversationId}:`,
      err,
    );
    return null;
  }
}

/**
 * After a customer edit/unsend, repoint the conversation's denormalized
 * `lastMessagePreview` IFF the corrected message is still the thread's most
 * recent one — otherwise the inbox list keeps showing the old/deleted text.
 * Returns the recomputed preview + the newest message's ISO time when it DID
 * change (so the caller can push a live `conversation:preview` frame), or null
 * when the corrected message wasn't the newest (list needs no update).
 */
async function refreshPreviewIfNewestCorrected(
  workspaceId: string,
  conversationId: string,
  correctedMessageId: string,
): Promise<{ preview: string; at: string } | null> {
  const newest = await db.message.findFirst({
    where: { workspaceId, conversationId },
    orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    select: { id: true, body: true, deletedAt: true, mediaKind: true, timestamp: true },
  });
  if (!newest || newest.id !== correctedMessageId) return null; // not the last message
  const preview = newest.deletedAt
    ? "🚫 Message deleted"
    : (
        newest.body?.trim() ||
        mediaPreview((newest.mediaKind as MediaKind | null) ?? undefined)
      ).slice(0, 200);
  await db.conversation.updateMany({
    where: { id: conversationId, workspaceId },
    data: { lastMessagePreview: preview },
  });
  return { preview, at: newest.timestamp.toISOString() };
}

/**
 * Apply a social read watermark (Messenger / Instagram): mark every outbound
 * message to this customer at/before the watermark as `read` — the "Seen" state.
 * Reuses ingestStatusUpdate per matched message so the rank/CAS guard, the
 * monotonic status guard, and the realtime `message:status` fanout all apply
 * exactly as WhatsApp's per-message read path does.
 */
async function ingestReadWatermark(
  workspaceId: string,
  channel: Channel,
  evt: NormalizedReadWatermark,
): Promise<void> {
  const extId = evt.externalContactId;
  if (!extId) return;
  const contact = await db.contact.findFirst({
    where: { workspaceId, identityChannel: channel, externalContactId: extId, deletedAt: null },
    select: { id: true },
  });
  if (!contact) return;
  const conversation = await db.conversation.findFirst({
    where: { workspaceId, contactId: contact.id },
    select: { id: true },
  });
  if (!conversation) return;
  // Outbound messages the customer just saw that aren't already `read`. A social
  // "Seen" watermark can cover a whole burst; the old per-message loop did
  // N × (findUnique + update + publish). Instead: ONE updateMany (sent/delivered
  // → read is a forward-only transition, so the monotonic guard the per-message
  // path enforces is unnecessary here), then fan out per-message read frames
  // (the reducers key on messageId; the live hook RAF-coalesces the burst). This
  // collapses O(N) DB round-trips to 1 findMany + 1 updateMany on the webhook
  // hot path. Re-delivery is idempotent — the `status in (sent,delivered)`
  // predicate matches nothing the second time.
  const msgs = await db.message.findMany({
    where: {
      workspaceId,
      conversationId: conversation.id,
      direction: "out",
      timestamp: { lte: evt.watermark },
      status: { in: ["sent", "delivered"] },
    },
    select: { id: true },
  });
  if (msgs.length === 0) return;
  await db.message.updateMany({
    // Repeat the status predicate: between the findMany above and this write a
    // concurrent status webhook could have advanced a row (e.g. to failed, or a
    // later read), and an id-only updateMany would clobber it — regressing the
    // status at the DB level. Only promote rows still sent/delivered.
    where: { id: { in: msgs.map((m) => m.id) }, status: { in: ["sent", "delivered"] } },
    data: { status: "read" },
  });
  // Publish only what actually COMMITTED as read: rows the predicate skipped
  // (a concurrent lane advanced them, e.g. to `failed`) must not fan out a
  // phantom `read`. The browser's monotonic guard absorbed those, but
  // `message.status_changed` also feeds outbound webhooks — a partner has no
  // such guard and would record `read` for a message whose real state is
  // `failed`. One extra indexed read on a receipt path, not the send path.
  const committed = await db.message.findMany({
    where: { id: { in: msgs.map((m) => m.id) }, status: "read" },
    select: { id: true },
  });
  const occurredAt = new Date().toISOString();
  for (const m of committed) {
    await publish({
      type: "message.status_changed",
      workspaceId,
      channel,
      conversationId: conversation.id,
      contactId: contact.id,
      messageId: m.id,
      status: "read",
      occurredAt,
    });
  }
}

/**
 * Apply a Messenger delivery watermark: mark every outbound message to this
 * customer at/before the watermark as `delivered`. Twin of ingestReadWatermark,
 * but the transition is `sent` → `delivered` ONLY — a message already
 * `delivered` or `read` must never be downgraded (the `status: "sent"` predicate
 * enforces monotonicity + makes redelivery idempotent). Messenger's
 * `message_deliveries` webhook always carries a watermark even when `mids` is
 * omitted, so this catches deliveries the old per-mid path dropped.
 */
async function ingestDeliveredWatermark(
  workspaceId: string,
  channel: Channel,
  evt: NormalizedDeliveredWatermark,
): Promise<void> {
  const extId = evt.externalContactId;
  if (!extId) return;
  const contact = await db.contact.findFirst({
    where: { workspaceId, identityChannel: channel, externalContactId: extId, deletedAt: null },
    select: { id: true },
  });
  if (!contact) return;
  const conversation = await db.conversation.findFirst({
    where: { workspaceId, contactId: contact.id },
    select: { id: true },
  });
  if (!conversation) return;
  const msgs = await db.message.findMany({
    where: {
      workspaceId,
      conversationId: conversation.id,
      direction: "out",
      timestamp: { lte: evt.watermark },
      status: "sent",
    },
    select: { id: true },
  });
  if (msgs.length === 0) return;
  await db.message.updateMany({
    // Repeat the status predicate so a row a concurrent read-webhook already
    // advanced to `read`/`failed` between the findMany and this write isn't
    // regressed back to `delivered` (id-only would clobber it).
    where: { id: { in: msgs.map((m) => m.id) }, status: "sent" },
    data: { status: "delivered" },
  });
  // Publish only what COMMITTED as delivered — same rationale as the read
  // watermark: partners consuming message.status_changed have no monotonic
  // guard, so a row a concurrent lane pushed to `read`/`failed` must not fan
  // out a phantom `delivered`.
  const committed = await db.message.findMany({
    where: { id: { in: msgs.map((m) => m.id) }, status: "delivered" },
    select: { id: true },
  });
  const occurredAt = new Date().toISOString();
  for (const m of committed) {
    await publish({
      type: "message.status_changed",
      workspaceId,
      channel,
      conversationId: conversation.id,
      contactId: contact.id,
      messageId: m.id,
      status: "delivered",
      occurredAt,
    });
  }
}

async function ingestStatusUpdate(
  workspaceId: string,
  channel: Channel,
  evt: NormalizedStatusUpdate,
): Promise<void> {
  // (workspaceId, channel, externalId) is the compound unique key post the
  // multi-channel refactor. workspaceId + channel come from the webhook route
  // (the URL is per-team and the route is per-channel); the wire payload
  // carries only the externalId.
  const existing = await db.message.findUnique({
    where: {
      workspaceId_channel_externalId: {
        workspaceId,
        channel,
        externalId: evt.externalId,
      },
    },
    select: {
      id: true,
      workspaceId: true,
      conversationId: true,
      status: true,
      direction: true,
      // Campaign reporting: `broadcastId` + `conversation.contactId` form
      // (broadcastId, contactId) — already the @@unique on BroadcastRecipient —
      // so propagating this status to the campaign's recipient row needs NO
      // extra lookup and no index on the wamid. Null for every ordinary send,
      // which is what makes the propagation free for non-broadcast traffic.
      broadcastId: true,
      // contact.phoneNumber rides the same read so the canonical-wa_id
      // mismatch check below costs nothing on the (overwhelming) match case.
      conversation: {
        select: { contactId: true, contact: { select: { phoneNumber: true } } },
      },
    },
  });
  // Status arriving for an unknown message: classic race where Meta delivers
  // `sent`/`delivered`/`read` for an outbound BEFORE our create-message path
  // has committed the row. Park the status in Redis with a short TTL; when
  // the message row is created (`createOutboundMessageIdempotent` below)
  // it drains the parked status and applies it. After TTL we drop — at that
  // point either the create failed permanently or Meta's clock is way off.
  if (!existing) {
    await parkUnknownWamidStatus(workspaceId, channel, evt.externalId, {
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

  // Canonical-recipient reconcile: Meta's `recipient_id` is the wa_id it
  // actually delivered to, and for some regions (Brazil's mobile "9",
  // Mexico's legacy "1") it differs from the number we dialed. Left alone,
  // the customer's REPLY — which arrives FROM that wa_id — forks a duplicate
  // contact + thread. The equality check is free (phone rides the select
  // above); the reconcile itself fires only on a true mismatch, and is
  // fire-and-forget like the broadcast propagation below — an identity
  // normalization must never cost us a delivery receipt.
  if (
    channel === "whatsapp" &&
    evt.recipientId &&
    existing.conversation.contact.phoneNumber &&
    existing.conversation.contact.phoneNumber !== evt.recipientId
  ) {
    void reconcileCanonicalWaId(
      workspaceId,
      existing.conversation.contactId,
      evt.recipientId,
    ).catch((err) => {
      console.error("[ingest] canonical wa_id reconcile failed", err);
    });
  }

  // Campaign reporting: mirror this delivery outcome onto the broadcast's
  // recipient row. Before this existed, a message Meta accepted and then failed
  // to deliver stayed `status='sent'` on the recipient forever and counted as a
  // success — so "who never received it" was answered wrongly.
  //
  // Runs BEFORE the Message monotonic guard below, deliberately. Meta attaches
  // the `pricing` object to the `sent` status, and our Message is ALREADY `sent`
  // (the runner stamps it at send time), so that guard short-circuits — placing
  // this after it meant campaign cost was never captured at all. The recipient
  // has its own ladder + CAS, so it is safe to advance independently.
  //
  // Fire-and-forget, exactly like `applyContactShareFromReply`: a reporting
  // enrichment must never be able to cost us a delivery receipt. A plain `sent`
  // with no pricing is skipped — the runner already stamped that state, and
  // skipping drops roughly a third of the webhook write volume on a 100k campaign.
  if (existing.broadcastId && (evt.status !== "sent" || evt.pricing)) {
    void applyBroadcastDeliveryStatus(
      workspaceId,
      existing.broadcastId,
      existing.conversation.contactId,
      evt,
    ).catch((err) => {
      console.error("[ingest] broadcast delivery propagation failed", err);
    });
  }

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

  // 130403 = this business has BLOCKED the recipient (Block Users API). Seeing
  // it on a status webhook means the blocklist was changed OUTSIDE the app
  // (WhatsApp Manager) — mirror it onto the contact so the reply-box lock,
  // broadcast suppression, and the send guards reflect reality instead of
  // letting every subsequent send fail with the same error. Backstop only:
  // in-app blocks stamp `blockedAt` at block time. Guarded on `blockedAt:
  // null` so a redelivered status can't move an existing block's timestamp,
  // and fire-safe like the 131049/131050 mirrors — bookkeeping must never
  // cost us the status write (Meta would redeliver the whole batch).
  if (evt.status === "failed" && evt.errorCode === 130403) {
    await db.contact
      .updateMany({
        where: {
          workspaceId,
          id: existing.conversation.contactId,
          blockedAt: null,
        },
        data: { blockedAt: evt.timestamp ?? new Date() },
      })
      .catch((err) => {
        console.warn(
          `[status] could not mirror provider block for contact ${existing.conversation.contactId}:`,
          err instanceof Error ? err.message : err,
        );
      });
  }

  await publish({
    type: "message.status_changed",
    workspaceId: existing.workspaceId,
    channel,
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
 * Loaded at CALL time, not as a static import.
 *
 * `broadcast-runner` reaches this module transitively
 * (broadcast-runner → messages/idempotent-create → ingest, for
 * `drainParkedStatus`), so importing it at the top of this file would close a
 * cycle — which CLAUDE.md §17 forbids and which is a genuine module-init hazard,
 * not a style preference. The alternative was moving `drainParkedStatus` out of
 * here, but it is wired into this module's status-rank/CAS internals and
 * relocating stable code for an import graph is the worse trade.
 *
 * Deferring the resolution to the moment a template actually changes status
 * keeps the static graph acyclic: by then both modules are fully initialized.
 */
function loadBroadcastTemplateHalt() {
  return import("@/lib/broadcast-runner");
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
  workspaceId: string,
  evt: NormalizedTemplateStatusUpdate,
): Promise<void> {
  // A status update sets `status`; a category update sets `category` and/or the
  // ADVANCE-NOTICE `correctCategory`. Nothing to write when none mapped to a
  // known enum value.
  const data: Prisma.MessageTemplateUpdateManyMutationInput = {};
  if (evt.status) {
    data.status = evt.status;
    // Meta's `reason` (e.g. `INCORRECT_CATEGORY`) is what makes a rejection
    // actionable. Cleared on any status that arrives without one, so a stale
    // rejection reason can't hang off a since-approved template.
    data.statusReason = evt.reason ?? null;
    // Same lifecycle for the rich detail (rejection explanation + fix
    // recommendation, pause instance, disable timestamp) — cleared whenever a
    // status arrives without one, so recovered templates don't keep old advice.
    data.statusDetail = evt.statusDetail ?? Prisma.DbNull;
    // Archival starts a 28-day deletion countdown. This webhook is the EXACT
    // moment it began — a catalog sync can only tell us a template is already
    // archived, not when. Unarchiving restores the previous status and cancels
    // the deletion, so any non-archived status clears the deadline.
    data.archivedAt = evt.status === "archived" ? new Date() : null;
  }
  // UNARCHIVED restores "the previous status", which the webhook doesn't say —
  // so stop the deletion countdown NOW and let the catalog refetch (below)
  // learn the real status instead of guessing one.
  if (evt.unarchived) {
    data.archivedAt = null;
  }
  if (evt.qualityScore) {
    data.qualityScore = evt.qualityScore;
    // Meta's quality webhook carries no timestamp, so the observation time is
    // the best we have — and it is what the UI needs anyway ("as of when").
    data.qualityScoreAt = new Date();
  }
  if (evt.category) {
    data.category = evt.category;
    // Meta CLEARS the custom TTL when it reclassifies a template — the ranges
    // are per-category and don't overlap at the low end (a utility maximum of
    // 12h is exactly the marketing minimum), so the old value is not merely
    // stale, it is out of range for the new category. Keeping it would show a
    // TTL the template no longer has and offer it back as a valid edit.
    data.messageSendTtlSeconds = null;
  }
  if (evt.pendingCategory) {
    // Notice, not state. Equal to the applied category means "the move landed /
    // no longer impacted", which is exactly how Meta reports it too.
    data.correctCategory =
      evt.pendingCategory === (evt.category ?? undefined) ? null : evt.pendingCategory;
  }
  if (Object.keys(data).length === 0) return;

  // Prefer matching on Meta's template id (externalId); fall back to the
  // natural (name, language) key. Build the narrowest WHERE we can.
  const where: Prisma.MessageTemplateWhereInput = { workspaceId };
  // Templates are WABA-scoped, and two WABAs in one workspace can hold same-named
  // templates — without this bound, WABA B's rejection would flip WABA A's row on
  // the (name, language) fallback and halt A's campaigns. Kept on the externalId
  // arm too: Meta template ids are globally unique, so there it is free
  // belt-and-braces.
  //
  // EXACT match now. This used to be `{ in: [evt.wabaId, ""] }` because rows synced
  // before multi-account carried a `""` "unknown WABA" sentinel — so a real WABA's
  // webhook also flipped every unattributed row. The sentinel is gone (the FK is
  // NOT NULL), so the match is simply "this WABA".
  if (evt.wabaId) {
    where.wabaAccount = { externalWabaId: evt.wabaId };
  }
  if (evt.externalId) {
    where.externalId = evt.externalId;
  } else if (evt.name) {
    where.name = evt.name;
    if (evt.language) where.language = evt.language;
    // NEITHER a globally-unique externalId NOR a WABA in the payload, so the only
    // identity left is (name, language) — which is unique PER WABA, not per
    // workspace. Unbounded, one WABA's rejection would flip every same-named row in
    // the workspace and halt all of their campaigns via the pause below.
    //
    // This used to narrow to the legacy `""` rows. That sentinel no longer exists,
    // and there is no honest way to pick between two real WABAs, so DROP the event
    // with a warn instead of guessing. Meta always carries `entry[].id` (the WABA)
    // on template webhooks, so this is a degenerate payload, not a routine case.
    if (!evt.wabaId) {
      const wabaCount = await db.whatsappBusinessAccount.count({ where: { workspaceId } });
      if (wabaCount > 1) {
        console.warn(
          `[ingest] dropped template status for "${evt.name}" — no WABA in the payload ` +
            `and workspace ${workspaceId} holds ${wabaCount} WABAs; refusing to guess`,
        );
        return;
      }
    }
  } else {
    return; // no identity to match on (parser already guards, belt-and-braces)
  }

  // The affected rows are needed BY ID for the campaign halt below, and the
  // PREVIOUS status decides whether this is a transition worth acting on.
  const affected = await db.messageTemplate.findMany({
    where,
    select: { id: true, status: true, name: true },
  });
  if (affected.length === 0) return; // not in our catalog yet — sync owns creation

  const result = await db.messageTemplate.updateMany({
    where,
    data,
  });
  if (result.count === 0) return;

  // Meta's instruction for a paused template is to halt the campaigns that rely
  // on it — the API rejects those sends anyway. Doing it HERE, off the webhook,
  // is what makes it free: the runner's own breaker only trips after
  // PERMANENT_ERROR_PAUSE_THRESHOLD consecutive failures, so it burns that many
  // recipients first and only if the campaign is already mid-send.
  if (evt.status && evt.status !== "approved") {
    const { pauseBroadcastsForTemplate } = await loadBroadcastTemplateHalt();
    for (const row of affected) {
      await pauseBroadcastsForTemplate(
        workspaceId,
        row.id,
        `Template "${row.name}" is ${evt.status} at Meta — WhatsApp rejects sends until it is active again.`,
      );
    }
  }
  // …and the other half. Only campaigns WE parked for this template resume;
  // Meta: "resume these campaigns when the template's status has been set to
  // Active again."
  if (evt.status === "approved") {
    const { resumeBroadcastsForTemplate } = await loadBroadcastTemplateHalt();
    for (const row of affected) {
      if (row.status === "approved") continue; // no transition, nothing parked
      await resumeBroadcastsForTemplate(workspaceId, row.id);
    }
  }

  // UNARCHIVED: the row's status is still whatever it was (archived) because
  // the webhook doesn't carry the restored status — the throttled catalog
  // refetch is what learns it. Publishes its own catalog_changed on success.
  if (evt.unarchived) {
    await ingestTemplateComponentsChanged(workspaceId);
  }

  // Refresh every open /settings/whatsapp + broadcast-form tab so the new
  // status (e.g. a now-paused template) surfaces without a manual reload. Reuses
  // the same catalog-changed event syncTemplates publishes.
  await publish({
    type: "team.catalog_changed",
    workspaceId,
    scope: "whatsapp-templates",
  });
}

/**
 * Cooldown between webhook-driven catalog refetches, per workspace.
 *
 * Editing a template in WhatsApp Manager fires one
 * `message_template_components_update` per change, and bulk edits arrive in a
 * burst. A refetch pages the whole catalog, so firing one per webhook would turn
 * a tidy-up session into a Graph hammering. One refetch per window picks up every
 * edit in that burst — the sync is whole-catalog, not per-template, so there is
 * nothing to lose by coalescing.
 *
 * In-process only, and that is fine: this is a rate limiter, not a lock. A second
 * api instance doing one extra refetch is harmless; the sync itself is idempotent.
 */
const COMPONENTS_REFETCH_COOLDOWN_MS = 60_000;
const lastComponentsRefetch = new Map<string, number>();

/**
 * A template's components changed at Meta — refetch the catalog so the cached
 * `components` (which decide the entire send-time parameter shape) stop being
 * stale.
 *
 * Fail-soft: a Graph blip here must not fail the webhook, or Meta redelivers the
 * whole batch and we re-ingest messages. The periodic sweeper is the backstop.
 */
async function ingestTemplateComponentsChanged(workspaceId: string): Promise<void> {
  const now = Date.now();
  const last = lastComponentsRefetch.get(workspaceId) ?? 0;
  if (now - last < COMPONENTS_REFETCH_COOLDOWN_MS) return;
  lastComponentsRefetch.set(workspaceId, now);

  try {
    await syncTemplateCatalog(workspaceId);
    await publish({
      type: "team.catalog_changed",
      workspaceId,
      scope: "whatsapp-templates",
    });
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "meta.template_components_refetch_failed",
        workspaceId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * Park-and-replay table for status updates that arrived before the message
 * row was committed. Keyed by `(workspaceId|channel|externalId)` and stored in
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
  workspaceId: string,
  channel: Channel,
  externalId: string,
): string {
  return `ccp:parked-status:${workspaceId}|${channel}|${externalId}`;
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
  workspaceId: string,
  channel: Channel,
  externalId: string,
  parked: ParkedStatus,
): Promise<void> {
  const key = parkKey(workspaceId, channel, externalId);
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
    await drainParkIfRowCommitted(workspaceId, channel, externalId);
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
  workspaceId: string,
  channel: Channel,
  externalId: string,
): Promise<void> {
  const row = await db.message.findUnique({
    where: {
      workspaceId_channel_externalId: { workspaceId, channel, externalId },
    },
    select: {
      id: true,
      direction: true,
      conversationId: true,
      conversation: { select: { contactId: true } },
    },
  });
  if (!row) return;
  // Same direction guard the LIVE status path applies (see ingestStatusUpdate's
  // `direction !== "out"` bail): a parked status must never rewrite an INBOUND
  // row. Without this, a status webhook that parked (no row yet) and a later
  // inbound committing under the same wamid — abnormal wire, but exactly the
  // class the live guard cites (Instagram read receipts) — would let the drain
  // overwrite a customer message's status and publish a phantom
  // message.status_changed.
  if (row.direction !== "out") return;
  await drainParkedStatus(
    workspaceId,
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
  workspaceId: string,
  channel: Channel,
  externalId: string,
  messageId: string,
  conversationId: string,
  contactId: string,
): Promise<void> {
  const key = parkKey(workspaceId, channel, externalId);
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
    // `broadcastId` for the campaign-delivery propagation below. This path
    // matters more than it looks for reporting: a broadcast running at full
    // throughput is exactly the workload that races Meta's status webhook
    // ahead of our own Message insert, so a large campaign's delivery receipts
    // disproportionately arrive via the park/drain route rather than live.
    select: { status: true, broadcastId: true },
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

  // Same campaign propagation as the live path. Calling it from both is safe:
  // the whole thing is guard + CAS, so a double-apply is a no-op.
  if (existing.broadcastId && parked.status !== "sent") {  // parked statuses carry no pricing
    void applyBroadcastDeliveryStatus(workspaceId, existing.broadcastId, contactId, {
      kind: "status",
      externalId,
      status: parked.status,
      ...(parked.errorCode !== undefined ? { errorCode: parked.errorCode } : {}),
      ...(parked.errorTitle !== undefined ? { errorTitle: parked.errorTitle } : {}),
      ...(parked.errorDetail !== undefined ? { errorDetail: parked.errorDetail } : {}),
      timestamp: new Date(),
      rawPayload: {},
    }).catch((err) => {
      console.error("[ingest] broadcast delivery propagation (drain) failed", err);
    });
  }

  await publish({
    type: "message.status_changed",
    workspaceId,
    channel,
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

/**
 * Monotonic ladder for a broadcast recipient's DELIVERY state.
 *
 * Deliberately a SEPARATE ladder from `statusWinsOver`, not a reuse of it.
 * `statusWinsOver` ranks `MessageStatus`, which collapses two very different
 * terminal outcomes into one `failed`: "Meta rejected the API call" and "Meta
 * accepted it then couldn't deliver". The campaign funnel must tell those apart
 * (`failed_at_send` vs `undelivered`) because they mean different things to the
 * operator and land in different actionability buckets — one is a bad template
 * or credential, the other is a bad number. Sharing the function would force a
 * lossy mapping.
 *
 * The subtle rule is the second line. Meta batches `delivered` and `failed` for
 * the SAME wamid in one POST more often than you'd expect on marketing sends,
 * and lane ordering is not guaranteed. If the handset already acked (delivered
 * or read), a later "undelivered" is a duplicate/out-of-order artifact, NOT a
 * regression — accepting it would silently move a genuinely-received message
 * into the "never received" bucket and corrupt the headline number this whole
 * feature exists to get right.
 */
const DELIVERY_RANK: Record<BroadcastDeliveryState, number> = {
  pending: 0,
  sent: 1,
  // ALONGSIDE `sent`, not below it: a held message has already been accepted by
  // Meta (it has a wamid), it is just not en route yet. Equal rank means a plain
  // `sent` webhook can't erase the more specific fact, while `delivered`/`read`
  // and a terminal failure still advance past it — which is exactly the set of
  // transitions a held message can make.
  held: 1,
  delivered: 2,
  read: 3,
  failed_at_send: -1, // terminal
  undelivered: -1, // terminal
};

export function deliveryWinsOver(
  next: BroadcastDeliveryState,
  current: BroadcastDeliveryState,
): boolean {
  if (DELIVERY_RANK[current] < 0) return false; // already terminal — never leaves
  if (DELIVERY_RANK[next] < 0) {
    // A terminal failure may only overwrite a state where delivery was never
    // confirmed. Once the handset acked, "undelivered" is a lie.
    return current !== "read" && current !== "delivered";
  }
  return DELIVERY_RANK[next] > DELIVERY_RANK[current];
}

/**
 * Propagate a Meta delivery-status webhook onto the broadcast recipient row.
 *
 * Looked up by `(broadcastId, contactId)` — the existing @@unique — using data
 * the caller already had in hand, so this costs one indexed read + one indexed
 * write and needs no new index.
 *
 * Guard + CAS mirror the Message path: pin the state we read, write only if it
 * is still that, re-read and re-decide on a miss. Bounded at 4 attempts because
 * the ladder is only three rungs deep, so it cannot spin.
 */
async function applyBroadcastDeliveryStatus(
  workspaceId: string,
  broadcastId: string,
  contactId: string,
  evt: NormalizedStatusUpdate,
): Promise<void> {
  const recipient = await db.broadcastRecipient.findUnique({
    where: { broadcastId_contactId: { broadcastId, contactId } },
    select: { id: true, deliveryState: true },
  });
  // No recipient row: the campaign was deleted, or this is a non-broadcast
  // message that somehow carries a broadcastId. Nothing to report on.
  if (!recipient) return;

  // Meta's `failed` on an ACCEPTED message means undeliverable — distinct from
  // the runner's `failed_at_send` (the API call itself was rejected).
  const next: BroadcastDeliveryState =
    evt.status === "failed" ? "undelivered" : (evt.status as BroadcastDeliveryState);

  // Cost columns ride whatever write happens next. Captured even when the
  // delivery state itself doesn't advance (a pricing-bearing `sent`), which is
  // why this is computed before the ladder check below.
  const pricingFields = evt.pricing
    ? {
        ...(typeof evt.pricing.billable === "boolean"
          ? { pricingBillable: evt.pricing.billable }
          : {}),
        ...(evt.pricing.category ? { pricingCategory: evt.pricing.category } : {}),
        ...(evt.pricing.model ? { pricingModel: evt.pricing.model } : {}),
        ...(evt.pricing.type ? { pricingType: evt.pricing.type } : {}),
      }
    : {};

  let pinned = recipient.deliveryState;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!deliveryWinsOver(next, pinned)) {
      // The ladder says this status is stale — but if it carried pricing we
      // still want the cost, so write that alone and stop.
      if (Object.keys(pricingFields).length > 0) {
        await db.broadcastRecipient.updateMany({
          where: { id: recipient.id },
          data: pricingFields,
        });
      }
      return;
    }
    const written = await db.broadcastRecipient.updateMany({
      where: { id: recipient.id, deliveryState: pinned },
      data: {
        deliveryState: next,
        ...(next === "delivered" ? { deliveredAt: evt.timestamp } : {}),
        ...(next === "read" ? { readAt: evt.timestamp } : {}),
        ...pricingFields,
        ...(next === "undelivered"
          ? {
              metaErrorCode: evt.errorCode ?? null,
              // Same normalized vocabulary the send path uses, so the failure
              // report is one GROUP BY rather than two taxonomies.
              errorCode: classifyMetaStatusError(evt.errorCode),
              // Safe to write: a recipient carrying CANCEL_RECIPIENT_MARKER is
              // `status='failed'` with no wamid, so it never reaches here and
              // the marker can't be clobbered.
              errorMessage: (evt.errorDetail ?? evt.errorTitle)?.slice(0, 500) ?? null,
            }
          : {}),
      },
    });
    if (written.count > 0) {
      // 131050 = this recipient used WhatsApp's own "Offers and announcements"
      // setting to stop marketing from THIS business. Meta accepts the send and
      // then fails it, so without mirroring it onto the contact we would keep
      // paying to enqueue them into every future marketing campaign and keep
      // getting the same refusal.
      //
      // The `user_preferences` webhook is the primary signal; this is the
      // backstop for a workspace that hasn't subscribed to it or that missed a
      // delivery. `applyOptOut` is idempotent, so both firing is harmless.
      // 131049 = this recipient has hit Meta's PER-USER marketing cap (or is on
      // a US number, which no longer receives marketing at all). Not an opt-out
      // — the person made no choice about us — so it is recorded separately and
      // only suppresses them for 24h.
      //
      // Meta is explicit that resending sooner makes it worse: more of the same
      // error, and a WABA that repeatedly retries capped users can have delivery
      // to those users cut off for up to 24 hours. It also keeps reporting
      // honest, since those recipients were never reachable in the first place.
      if (evt.errorCode === 131049) {
        await db.contact
          .updateMany({
            where: { workspaceId, id: contactId },
            data: { marketingCapReachedAt: evt.timestamp ?? new Date() },
          })
          .catch((err) => {
            // Same rule as the opt-out mirror below: never fail the webhook over
            // suppression bookkeeping — Meta would redeliver the whole batch.
            console.warn(
              `[status] could not record marketing cap for contact ${contactId}:`,
              err instanceof Error ? err.message : err,
            );
          });
      }
      if (evt.errorCode === 131050) {
        await applyOptOut(
          workspaceId,
          contactId,
          "meta_preferences",
          evt.timestamp,
        ).catch((err) => {
          // Never fail the webhook over a suppression bookkeeping error — Meta
          // would redeliver the whole batch and we'd re-ingest the statuses.
          console.warn(
            `[status] could not record marketing opt-out for contact ${contactId}:`,
            err instanceof Error ? err.message : err,
          );
        });
      }
      return;
    }
    const current = await db.broadcastRecipient.findUnique({
      where: { id: recipient.id },
      select: { deliveryState: true },
    });
    if (!current) return;
    pinned = current.deliveryState;
  }
}

async function ingestInboundMessage(
  workspaceId: string,
  channel: Channel,
  evt: NormalizedInboundMessage,
  /** The account that received this message (see ingestEvents). */
  channelConnectionId?: string | null,
): Promise<void> {
  // Rule #3 dedupe gate. Cheap pre-check; the compound unique
  // (workspaceId, channel, externalId) is the actual race guard via the P2002
  // catch below.
  const existing = await db.message.findUnique({
    where: {
      workspaceId_channel_externalId: {
        workspaceId,
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
      workspaceId,
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
  const defaultStageId = await ensureDefaultStage(workspaceId);

  // Contact + conversation resolution must be transactional. Without a tx,
  // two simultaneous first-time inbounds from the same brand-new phone both
  // see `findFirst({ status: { not: "closed" } }) === null` and both
  // `conversation.create()` succeed — producing duplicate conversation rows
  // for one contact. The contact race is backstopped by the partial unique
  // `Contact_workspaceId_phoneNumber_whatsapp_key` (raw SQL — WhatsApp/null
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
      // `(workspaceId, identityChannel, externalContactId)`, where the id is the
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
      // A phone-channel person can be keyed by phone OR by BSUID, and Meta
      // switches between the two for the SAME person: `wa_id` is omitted for
      // contacts not messaged in the last 30 days, so a cold customer arrives
      // as a bare BSUID and the same customer, once warm, arrives as a phone.
      // Resolving on only the key this webhook happens to carry forks one person
      // into two contacts and two conversations, permanently (there is no unique
      // constraint on `bsuid` and no sweeper reconciles it). So try BOTH keys —
      // phone first, since it is the canonical identity — and backfill the one
      // that was missing onto whichever row we land on.
      const contactIdentitySelect = {
        id: true,
        deletedAt: true,
        phoneNumber: true,
        bsuid: true,
        username: true,
        // Needed to decide whether the stored name is a real one or just the
        // identity fallback — see the name backfill below.
        name: true,
      } as const;
      let existingContact: {
        id: string;
        name: string | null;
        deletedAt: Date | null;
        phoneNumber: string | null;
        bsuid: string | null;
        username: string | null;
      } | null = null;
      if (isPhone) {
        if (evt.contactPhone) {
          // Scope by identityChannel like the bsuid/externalContactId lookups
          // below: contact-share can stamp this same phone onto a
          // messenger/instagram contact (the partial unique on
          // (workspaceId, phoneNumber) fires ONLY for identityChannel='whatsapp', so
          // a social row holding the shared phone is allowed). Without the
          // channel scope this phone-channel inbound could resolve to that
          // social contact and fold a WhatsApp thread onto a messenger
          // conversation. Cross-channel personhood lives on Customer, never by
          // folding contacts.
          existingContact = await tx.contact.findFirst({
            where: { workspaceId, identityChannel: channel, phoneNumber: evt.contactPhone },
            select: contactIdentitySelect,
          });
        }
        if (!existingContact && evt.bsuid) {
          existingContact = await tx.contact.findFirst({
            where: { workspaceId, identityChannel: channel, bsuid: evt.bsuid },
            select: contactIdentitySelect,
          });
        }
      } else {
        existingContact = await tx.contact.findFirst({
          where: { workspaceId, identityChannel: channel, externalContactId: evt.externalContactId },
          select: contactIdentitySelect,
        });
      }
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
        // …with ONE exception: identity keys we now know and the row is missing.
        // This is what heals the BSUID↔phone transition — a contact first seen
        // as a cold BSUID gets its phone (and country) the moment Meta reveals
        // it, and a phone-keyed contact learns its BSUID — so the next webhook,
        // whichever key it carries, resolves to this same row. Only ever fills a
        // NULL; never overwrites an identity we already hold.
        const identityBackfill: {
          phoneNumber?: string;
          countryCode?: string | null;
          bsuid?: string;
          username?: string;
        } = {};
        if (isPhone) {
          if (evt.contactPhone && !existingContact.phoneNumber) {
            identityBackfill.phoneNumber = evt.contactPhone;
            identityBackfill.countryCode = getCountryFromPhone(evt.contactPhone);
          }
          if (evt.bsuid && !existingContact.bsuid) identityBackfill.bsuid = evt.bsuid;
          if (evt.username && !existingContact.username) identityBackfill.username = evt.username;
        }
        // NAME backfill — the same fill-a-NULL discipline as the identity keys
        // above, and it heals the same class of gap.
        //
        // WhatsApp only shares `profile.name` on an INBOUND message: a contact
        // first seen through an outbound call or a compose-new has no name to
        // store, so `Contact.name` falls back to the raw phone number. Without
        // this, the moment that person finally replies — with their real name
        // right there in `contacts[0].profile.name` — we threw it away and left
        // the inbox showing "96171505894" forever.
        //
        // Adopt ONLY when what we hold isn't a real name (null, or the identity
        // fallback). An agent-edited name and a previously-captured profile name
        // are both left alone: a customer who renames their WhatsApp profile must
        // not silently overwrite what the team deliberately typed.
        const incomingName = evt.contactName?.trim();
        const storedIsPlaceholder =
          !existingContact.name?.trim() || looksLikeIdentityFallback(existingContact.name);
        const nameBackfill =
          incomingName && !looksLikeIdentityFallback(incomingName) && storedIsPlaceholder
            ? { name: incomingName, ...splitContactName(incomingName) }
            : {};

        contact = await tx.contact.update({
          where: { id: existingContact.id },
          data: { deletedAt: null, ...identityBackfill, ...nameBackfill },
          // Load tags as `{ id }` so the `message.received` contact snapshot
          // (toWorkflowContact below) emits the RETURNING contact's real
          // tagIds — without this the relation is absent and tagIds is [].
          include: { tags: { select: { id: true } } },
        });
        // Cold→warm strong-key adoption. When the backfill just gave this row a
        // phone it never had, that phone may already identify a Customer under a
        // sibling channel (the person messaged us on WhatsApp before, or on
        // Messenger with a shared number). resolveCustomerId only ran at CREATE,
        // so without this the person stays split across two Customers forever.
        // Adopt-only + reap-empty, exactly like applyContactShareFromReply.
        if (identityBackfill.phoneNumber) {
          const adoptedCustomerId = await findExistingCustomerIdByStrongKey(
            workspaceId,
            { id: contact.id, name: contact.name, phoneNumber: identityBackfill.phoneNumber, email: null },
            tx,
          );
          if (adoptedCustomerId && adoptedCustomerId !== contact.customerId) {
            const priorCustomerId = contact.customerId;
            contact = await tx.contact.update({
              where: { id: contact.id },
              data: { customerId: adoptedCustomerId },
              include: { tags: { select: { id: true } } },
            });
            // The Customer it used to sit alone under is now childless — reap it.
            // The `contacts: none` guard leaves a real merge target (one that
            // still owns other channel contacts) intact.
            if (priorCustomerId) {
              await tx.customer.deleteMany({
                where: { id: priorCustomerId, workspaceId, contacts: { none: {} } },
              });
            }
          }
        }
      } else {
        contact = await tx.contact.create({
          data: {
            workspaceId,
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
            // A BSUID-only inbound (cold contact, Meta omits wa_id) carries no
            // phone to derive a country from — don't assert one into existence.
            countryCode:
              isPhone && evt.contactPhone ? getCountryFromPhone(evt.contactPhone) : null,
            stageId: defaultStageId,
            // Unified Customer (§6): resolve which person this contact belongs to
            // through the single identity authority. On a deterministic strong
            // key (exact phone/email already linked to a Customer) it adopts that
            // person IMMEDIATELY — cross-channel merge at ingest, not sweeper-
            // delayed; otherwise it mints a fresh Customer. Runs in `tx` so the
            // Customer rolls back with the contact if the create aborts. The
            // drift sweeper stays the backstop for keys that appear later.
            customerId: await resolveCustomerId(
              workspaceId,
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
        where: { workspaceId, contactId: contact.id },
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
            workspaceId,
            contactId: contact.id,
            // Bind the new thread to the account that received it.
            ...(channelConnectionId ? { channelConnectionId } : {}),
            // The thread's channel is the channel whose webhook created it.
            channel,
            // New chats land in `pending` so they sit in the triage column
            // until an agent claims them (→ open) or closes them out.
            status: "pending",
            lastMessageAt: evt.timestamp,
            lastMessagePreview: "",
          },
        });
      } else {
        // RE-STAMP the account on an existing thread when the customer messaged
        // a DIFFERENT one of our accounts. The live thread — and the 24h window
        // that governs free-form replies — now belongs to that account, so a
        // reply must go out from it. Deliberately unlike webchat's sticky
        // `webchatWidgetId`. Guarded so the common case writes nothing.
        if (channelConnectionId && conversation.channelConnectionId !== channelConnectionId) {
          conversation = await tx.conversation.update({
            where: { id: conversation.id },
            data: { channelConnectionId },
          });
        }
        if (conversation.status === "closed") {
          // Returning customer replying to a closed thread → mark for reopen in
          // tx2 (do NOT mutate here).
          needsReopen = true;
        }
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
          workspaceId,
          conversationId: conversation.id,
          externalId: evt.externalId,
          senderUserId: null,
          body: evt.body,
          direction: "in",
          channel,
          status: "delivered",
          // WHICH of our numbers/Pages this actually arrived on. Stamped from
          // the resolved inbound account — the same value the conversation
          // pointer is re-stamped to just above. The conversation's moves on
          // the next inbound to a different account; this one never does.
          channelConnectionId: channelConnectionId ?? conversation.channelConnectionId ?? null,
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
          // Persist the structured button/list tap. Until now this was parsed,
          // handed to workflows, and then dropped — only the button's display
          // TITLE survived (as `body`), so click-through could only be derived
          // from a string an operator can rename at will. Zero extra write:
          // these are columns on the row already being inserted.
          ...(evt.interactiveReply
            ? {
                interactiveOptionId: evt.interactiveReply.id,
                interactiveOptionKind: evt.interactiveReply.kind,
              }
            : {}),
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

      // Attach the message to a ticket — the unit of WORK this thread is doing
      // right now. Inside THIS transaction on purpose: a message that exists
      // with no ticket (or a reopened ticket for a message that rolled back)
      // is exactly the inconsistency the explicit `Message.ticketId` column
      // exists to rule out. Runs AFTER the reopen flip so a returning customer
      // routes against the post-reopen thread state.
      //
      // NOT wrapped in a try/catch, deliberately. A caught error here would be
      // false safety: a failed statement has already poisoned the surrounding
      // Postgres transaction, so every write after the catch fails anyway.
      // Routing only throws on infrastructure failure (it returns null, never
      // throws, for every logical miss — e.g. an unknown conversation),
      // and in that case the message write is failing too. Letting it roll back
      // means Meta redelivers and we ingest cleanly on the retry.
      const routed = await routeMessageToTicket(tx, {
        workspaceId,
        conversationId: conversation.id,
        direction: "in",
      });
      if (routed.ticketId) {
        await tx.message.update({
          where: { id: created.id },
          data: { ticketId: routed.ticketId },
        });
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
        workspaceId,
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
        workspaceId,
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
          workspaceId,
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
        workspaceId,
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
        workspaceId,
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

      return {
        messageId: created.id,
        resumeRunIds,
        contactId: contact.id,
        conversationId: conversation.id,
        reopened,
      };
    });
    // Post-commit: a reopen (closed -> pending on this inbound) also resumes
    // native AI if it was paused — a thread the customer walked away from and
    // came back to shouldn't stay silently paused forever (see
    // conversation-state.ts `resumeOnReopen`). Best-effort/non-fatal, same
    // reasoning as the resumeRunIds kicks below: a Redis/DB blip here just
    // leaves the conversation paused until an agent notices, not catastrophic.
    if (txResult?.reopened) {
      try {
        await resumeOnReopen(workspaceId, txResult.conversationId);
      } catch (err) {
        console.error("[ingest][ai_resume_on_reopen]", { conversationId: txResult.conversationId, err });
      }
    }
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

    // Post-commit: did the contact just tap a "share my phone / email" consent
    // chip? If so, stamp the strong key and fold them into the right unified
    // Customer. Deliberately AFTER the tx and non-fatal — an identity
    // enrichment must never cost us the message, and the customer-link drift
    // sweeper backstops the linking half.
    if (evt.interactiveReply && txResult) {
      try {
        await applyContactShareFromReply(
          workspaceId,
          channel,
          txResult.conversationId,
          txResult.contactId,
          evt.interactiveReply,
        );
      } catch (err) {
        console.error("[ingest][contact_share]", { contactId: txResult.contactId, err });
      }
    }

    // Post-commit: credit this inbound to a recent campaign (reply / button
    // click) and honour an opt-out keyword. Same placement and same contract as
    // the contact-share enrichment above — after the tx, non-fatal — because
    // campaign reporting must never be able to cost us the customer's message.
    if (txResult) {
      try {
        await attributeInboundToBroadcast({
          workspaceId,
          contactId: txResult.contactId,
          messageId: txResult.messageId,
          body: evt.body ?? null,
          timestamp: evt.timestamp,
          // OUR message the customer quoted, when they used quote-reply. This is
          // what makes direct (exact) attribution possible instead of inferring
          // from a time window.
          replyToMessageId: replySnapshot?.id ?? null,
          interactiveOptionId: evt.interactiveReply?.id ?? null,
        });
      } catch (err) {
        console.error("[ingest][broadcast_attribution]", {
          contactId: txResult.contactId,
          err,
        });
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
        workspaceId,
        contact: toContactWire(contact),
        source: "inbound",
        createdByUserId: null,
      });
    } catch (err) {
      console.error(
        `[ingest] publish(contact.created) failed for team=${workspaceId} contact=${contact.id}:`,
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
  workspaceId: string,
  channel: Channel,
  evt: NormalizedOutboundEcho,
  /** The account this echo arrived on — stamped on a thread it creates. */
  channelConnectionId?: string | null,
): Promise<void> {
  // Rule #3 dedupe. The outbound idempotent-create below is the race backstop;
  // this cheap pre-check short-circuits the common re-delivery / echo-of-our-
  // own-send case before we touch the contact/conversation resolution.
  const existing = await db.message.findUnique({
    where: {
      workspaceId_channel_externalId: { workspaceId, channel, externalId: evt.externalId },
    },
    select: { id: true },
  });
  if (existing) return;

  const defaultStageId = await ensureDefaultStage(workspaceId);
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

  // `conversation` is reassigned below (the reopen path re-reads it); the rest
  // never are, so they bind as const — lint's prefer-const flags each name
  // in a destructuring pattern independently.
  const { contact, isNewContact, wasRevived, isNewConversation, needsReopen, ...convHolder } =
    await runWithSerializableRetry(async (tx) => {
      const found = await tx.contact.findFirst({
        // Scope by identityChannel exactly like the inbound / call / history
        // paths (see the comment at the inbound lookup ~1490): the partial
        // unique on (workspaceId, phoneNumber) fires ONLY for identityChannel=
        // 'whatsapp', so contact-share (or a widget pre-chat) can stamp this
        // same phone onto a messenger/instagram/webchatwidget contact. Without
        // the channel scope this coexistence echo could resolve to that social/
        // widget contact and fold a WhatsApp echo thread onto the wrong
        // channel's conversation.
        where: isPhone
          ? { workspaceId, identityChannel: channel, phoneNumber: evt.contactPhone }
          : { workspaceId, identityChannel: channel, externalContactId: evt.externalContactId },
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
            workspaceId,
            identityChannel: channel,
            phoneNumber: isPhone ? evt.contactPhone : null,
            externalContactId: isPhone ? null : evt.externalContactId,
            name: identityLabel,
            firstName,
            lastName,
            // A BSUID-only inbound (cold contact, Meta omits wa_id) carries no
            // phone to derive a country from — don't assert one into existence.
            countryCode:
              isPhone && evt.contactPhone ? getCountryFromPhone(evt.contactPhone) : null,
            stageId: defaultStageId,
            // Same unified-Customer resolution as the inbound path — an echo can
            // be the FIRST time we see a contact (owner messaged them natively
            // before they replied). Runs in `tx` so it rolls back atomically.
            customerId: await resolveCustomerId(
              workspaceId,
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
        where: { workspaceId, contactId: contact!.id },
        orderBy: { lastMessageAt: "desc" },
      });
      const isNewConversation = !existingConvo;
      // Whether the thread needs a closed→pending reopen. The CAS itself runs
      // co-committed with the message insert below (INB-1) — this tx only
      // detects.
      let needsReopen = false;
      let conversation = existingConvo;
      if (!conversation) {
        conversation = await tx.conversation.create({
          data: {
            workspaceId,
            contactId: contact!.id,
            channel,
            ...(channelConnectionId ? { channelConnectionId } : {}),
            // A phone-initiated thread lands in triage like any other new
            // conversation until an agent claims it.
            status: "pending",
            lastMessageAt: evt.timestamp,
            lastMessagePreview: "",
          },
        });
      } else if (conversation.status === "closed") {
        // INB-1 (third copy, fixed 2026-07-27): only DETECT the reopen here —
        // do NOT flip closed→pending in this (separate) transaction. The CAS
        // flip + the `status_changed` publish are co-committed with the
        // message INSERT below, so:
        //   (a) a crash between this tx and the publish can no longer leave a
        //       silently-reopened thread with no event (redelivery used to see
        //       status='pending', skip `reopened`, and PERMANENTLY drop the
        //       workflow trigger + partner webhook + list splice), and
        //   (b) the duplicate-echo race can no longer split the CAS winner
        //       from the insert winner (the old pre-publish `!isFreshRow`
        //       return ate the event whenever they differed).
        // Mirrors the inbound path + ingest-call.ts's detect/flip split.
        needsReopen = true;
      }
      return { contact: contact!, conversation, isNewContact, wasRevived, isNewConversation, needsReopen };
    });
  let conversation = convHolder.conversation;

  // Strict-monotonic timestamp so a phone reply landing in the same second as
  // the inbound it answers still sorts AFTER it (same rule as send-text-internal).
  const messageTimestamp =
    conversation.lastMessageAt && conversation.lastMessageAt >= evt.timestamp
      ? new Date(conversation.lastMessageAt.getTime() + 1)
      : evt.timestamp;

  const mediaPending = Boolean(
    evt.media && !(evt.media.storageKey && evt.media.storageUrl),
  );

  // Message INSERT + reopen CAS + status_changed publish in ONE transaction
  // (INB-1): the flip and its event can neither outlive a failed insert nor
  // be split from it by a crash or a duplicate race. `reopened` is true only
  // for the copy that BOTH inserted the fresh row AND won the CAS.
  const { created, isFreshRow, reopened } = await db.$transaction(async (tx) => {
    const { message: createdRow, created: fresh } = await createOutboundMessageIdempotentDetailed(
      {
        workspaceId,
        conversationId: conversation.id,
        externalId: evt.externalId,
        senderUserId: null,
        origin: "business_app",
        body: evt.body,
        direction: "out",
        channel,
        // History backfill stamps the state the message already earned
        // (history_context.status) so old echoes show their real ticks; live
        // echoes carry no status and default to "sent" as before.
        status: evt.status ?? "sent",
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
      },
      tx,
    );

    let flipped = false;
    if (fresh && needsReopen) {
      // CAS so a racing inbound reopen doesn't double-flip; only the winner
      // publishes. Closed threads already cleared the assignee on close, so
      // null is the correct post-reopen value.
      const flip = await tx.conversation.updateMany({
        where: { id: conversation.id, status: "closed" },
        data: { status: "pending", assignedUserId: null },
      });
      flipped = flip.count > 0;
      if (flipped) {
        const reopenSnapshot = workflowConversationSnapshotAfterStatusChange(
          {
            ...conversation,
            status: "pending",
            assignedUserId: null,
            lastMessageAt: messageTimestamp,
            unreadCount: conversation.unreadCount,
          },
          { previousStatus: "closed", changedByUserId: null },
        );
        await publishInTx(tx, {
          type: "conversation.status_changed",
          workspaceId,
          conversationId: conversation.id,
          previousStatus: "closed",
          newStatus: "pending",
          changedByUserId: null,
          contact: toWorkflowContact(contact),
          conversation: reopenSnapshot,
        });
      }
    }
    return { created: createdRow, isFreshRow: fresh, reopened: flipped };
  });
  if (reopened) {
    conversation = { ...conversation, status: "pending", assignedUserId: null };
    kickOutbox();
  }

  // A raced duplicate of the same echo: the cheap findUnique above ran before
  // either copy committed, so both reached the insert and the loser got the
  // winner's row back. Everything past this point has SIDE EFFECTS —
  // `message.sent` fanout (one outbound-webhook delivery per publish, and a
  // +1 on Conversation.outgoingMessagesCount), the unread clear, the
  // `contact.created` publish — so a duplicate must stop here. The reopen +
  // its event are safe either way: they co-committed with the WINNER's insert
  // above.
  if (!isFreshRow) return;

  const preview = (evt.body.trim() || mediaPreview(evt.media?.kind)).slice(0, 200);
  const mediaBlock = buildEchoMediaBlock(created.id, evt.media, evt.body);
  const message: Message = {
    id: created.id,
    workspaceId,
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
  // uses on first contact). A reopened thread also needs the splice — it left
  // the open list when it closed. unreadCount 0 — we clear it just below.
  const newConversation: ConversationWithRefs | undefined = isNewConversation || reopened
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
        // An ECHO is outbound — the 24h window state comes from the contact's
        // stored last inbound. `null` here made a REOPENED thread render as
        // never-contacted (template-only reply box) on teammates' spliced-in
        // rows until a refetch.
        lastInboundAt: contact.lastInboundAt?.toISOString() ?? null,
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
      workspaceId,
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

  // (The reopen's `conversation.status_changed` is co-committed with the
  // message insert above — INB-1 — so there is no post-commit publish here.)

  // Clear team-wide unread: the owner read the thread on their phone to reply.
  // CAS so a concurrent inbound bump isn't clobbered; publish conversation.read
  // ONLY on the 1→0 transition so the list badge converges (the message.sent
  // frame above doesn't touch list unread). Best-effort — a miss re-syncs on the
  // next inbound. NO Meta read receipt (the phone already sent it).
  try {
    const cleared = await db.conversation.updateMany({
      where: { id: conversation.id, workspaceId, unreadCount: { gt: 0 } },
      data: { unreadCount: 0 },
    });
    if (cleared.count > 0) {
      await publish({
        type: "conversation.read",
        workspaceId,
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
        workspaceId,
        contact: toContactWire(contact),
        source: "inbound",
        createdByUserId: null,
      });
    } catch (err) {
      console.error(
        `[ingest] publish(contact.created) failed for echo team=${workspaceId} contact=${contact.id}:`,
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
  workspaceId: string,
  channel: Channel,
  evt: NormalizedContactSync,
): Promise<void> {
  if (evt.action === "remove" || !evt.fullName) return;

  const contact = await db.contact.findFirst({
    where: { workspaceId, phoneNumber: evt.phone, identityChannel: channel },
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
      workspaceId,
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
      `[ingest] publish(contact.updated) failed for state_sync team=${workspaceId} contact=${contact.id}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Migrate a WhatsApp contact to a NEW phone number after the customer changed it
 * (`system.type:"user_changed_number"`). Re-points the existing contact so their
 * thread continues instead of forking. If a contact already exists under the new
 * number, leaves both for a manual merge rather than violating the phone unique
 * key. Best-effort — a system webhook must never throw into the ingest pipeline.
 */
async function ingestContactNumberChange(
  workspaceId: string,
  channel: Channel,
  evt: NormalizedContactNumberChange,
): Promise<void> {
  const oldContact = await db.contact.findFirst({
    where: { workspaceId, identityChannel: channel, phoneNumber: evt.oldPhone, deletedAt: null },
    select: { id: true },
  });
  if (!oldContact) return;
  const existingNew = await db.contact.findFirst({
    where: { workspaceId, identityChannel: channel, phoneNumber: evt.newPhone, deletedAt: null },
    select: { id: true },
  });
  if (existingNew) {
    console.warn(
      JSON.stringify({
        event: "whatsapp.number_change_conflict",
        severity: "warning",
        workspaceId,
        oldContactId: oldContact.id,
        newContactId: existingNew.id,
        note: "a contact already exists under the new number — left for a manual merge",
      }),
    );
    return;
  }
  const updated = await db.contact
    .update({
      where: { id: oldContact.id },
      data: { phoneNumber: evt.newPhone },
      include: { tags: { select: { id: true } } },
    })
    .catch((err) => {
      console.error(
        `[ingest] number-change update failed team=${workspaceId} contact=${oldContact.id}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    });
  if (!updated) return;
  try {
    await publish({
      type: "contact.updated",
      workspaceId,
      contact: toContactWire(updated),
      previousStageId: updated.stageId,
      fieldChanges: [],
      changedByUserId: null,
      workflowContact: toWorkflowContact(updated),
      // Local identity migration, not a business event partners subscribe to.
      silent: true,
    });
  } catch (err) {
    console.error(
      `[ingest] publish(contact.updated) failed for number_change team=${workspaceId} contact=${oldContact.id}:`,
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
 *
 * `channelConnectionId` is the account that RECEIVED the batch. It is not
 * optional in practice: a PSID/IGSID is scoped to the Page or IG account it was
 * issued for, so the profile has to be fetched with that account's token. And
 * since the account-unresolved guard, omitting it doesn't fall back to the
 * default — it THROWS, straight into the `catch { return }` below, so a
 * workspace with two Pages silently kept every social contact named by its raw
 * opaque id with no avatar, forever.
 */
export async function enrichSocialContactNames(
  workspaceId: string,
  channel: Channel,
  externalContactIds: string[],
  channelConnectionId?: string | null,
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
    config = await binding.getSendConfig(workspaceId, channelConnectionId ?? undefined);
  } catch {
    return; // not connected / creds missing — skip, keep the id fallback
  }

  await runWithConcurrency(unique, 4, async (extId) => {
    try {
      const contact = await db.contact.findFirst({
        where: { workspaceId, identityChannel: channel, externalContactId: extId },
        include: { tags: { select: { id: true } } },
      });
      if (!contact) return;

      // Cheap pre-check BEFORE the Graph round-trip: a contact already enriched
      // (a real name AND a captured R2 avatar) needs no profile fetch on a normal
      // inbound — only a forced sync (the panel's Refresh) re-pulls. Without this
      // guard, every inbound social message from a KNOWN contact fired a Graph
      // profile call for nothing — a per-message round-trip against Meta's app
      // rate limit that scales with thread volume.
      const current = contact.name?.trim() ?? "";
      // "Real" = not empty, not the raw-id default, and not the friendly
      // placeholder ("Messenger user") the wire shows for an un-enriched contact.
      // The placeholder normally lives only on the wire (the DB keeps the id),
      // but guard against it here too so a contact whose placeholder somehow
      // reached the DB (e.g. an edit-form save mid-enrichment) still gets its
      // real name filled instead of wedging enrichment forever.
      const nameIsReal =
        current !== "" && current !== extId && !isSocialContactPlaceholder(current);
      const hasCapturedAvatar = contact.avatarUrl?.startsWith("/api/contacts/");
      if (nameIsReal && hasCapturedAvatar && !opts?.forceAvatar) return;

      const profile = await fetchProfile(extId, config);

      // Build the patch: fill a name still equal to the id default (never
      // overwrite a real one an agent/prior enrichment set); retain the IG
      // @username; store a profile picture when the contact has none yet.
      const data: Prisma.ContactUpdateInput = {};
      if (!nameIsReal && profile.name && profile.name !== extId) {
        data.name = profile.name;
        // Prefer Meta's own first/last split (Messenger returns it) over our
        // heuristic — "Maria del Carmen Garcia" has no reliable split point.
        if (profile.firstName || profile.lastName) {
          data.firstName = profile.firstName;
          data.lastName = profile.lastName;
        } else {
          const { firstName, lastName } = splitContactName(profile.name);
          data.firstName = firstName;
          data.lastName = lastName;
        }
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
      if (profile.avatarUrl && (opts?.forceAvatar || !hasCapturedAvatar)) {
        const captured = await captureRemoteContactAvatar(
          contact.id,
          profile.avatarUrl,
          contact.avatarUrl,
        );
        if (captured && captured !== contact.avatarUrl) data.avatarUrl = captured;
      }
      // Instagram richer signals (follower count / verified / follow-relationship).
      // MERGE field-by-field, keeping the stored value when the new one is absent:
      // a transient/partial Graph response that omits a field must not clobber a
      // previously-captured signal with undefined. `??` keeps an explicit `false`
      // / `0` (a real update) while treating only null/undefined as "unknown".
      // Change-gated so an unchanged profile doesn't republish `contact.updated`.
      // IG carries the follower/verified signals; Messenger carries locale/
      // timezone/gender (once the `pages_user_*` perms are approved) — the merge
      // whitelists BOTH sets, so `merged` must list every key or an update would
      // silently drop the ones it omits.
      if (profile.socialProfile) {
        const cur = (contact.socialProfile ?? {}) as SocialProfile;
        const next = profile.socialProfile;
        const merged: SocialProfile = {
          followerCount: next.followerCount ?? cur.followerCount ?? null,
          isVerified: next.isVerified ?? cur.isVerified ?? null,
          followsBusiness: next.followsBusiness ?? cur.followsBusiness ?? null,
          businessFollows: next.businessFollows ?? cur.businessFollows ?? null,
          locale: next.locale ?? cur.locale ?? null,
          timezone: next.timezone ?? cur.timezone ?? null,
          gender: next.gender ?? cur.gender ?? null,
        };
        if (
          cur.followerCount !== merged.followerCount ||
          cur.isVerified !== merged.isVerified ||
          cur.followsBusiness !== merged.followsBusiness ||
          cur.businessFollows !== merged.businessFollows ||
          cur.locale !== merged.locale ||
          cur.timezone !== merged.timezone ||
          cur.gender !== merged.gender
        ) {
          data.socialProfile = merged as Prisma.InputJsonValue;
        }
        // NOTE: `locale` is surfaced in the UI under the grouped "Messenger" row
        // (contact-panel derives the language name from `socialProfile.locale`),
        // NOT copied onto the editable `Contact.language` builtin — keeping it in
        // one place avoids showing the same value in two fields.
      }
      if (Object.keys(data).length === 0) return; // nothing new to persist

      const updated = await db.contact.update({
        where: { id: contact.id },
        data,
        include: { tags: { select: { id: true } } },
      });
      await publish({
        type: "contact.updated",
        workspaceId,
        contact: toContactWire(updated),
        previousStageId: updated.stageId,
        fieldChanges: [],
        changedByUserId: null,
        workflowContact: toWorkflowContact(updated),
        silent: true,
      });
    } catch (err) {
      console.error(
        `[ingest] social name enrichment failed team=${workspaceId} channel=${channel} id=${extId}:`,
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
  /**
   * The account this backfill arrived on. Without it a backfilled thread has
   * no `channelConnectionId`, and since the account-unresolved guard that
   * makes it unsendable from the inbox in a multi-account workspace until the
   * customer sends an inbound of their own.
   */
  channelConnectionId?: string | null;
}

export async function ingestHistoricalMessage(
  workspaceId: string,
  channel: Channel,
  msg: HistoricalMessageInput,
): Promise<void> {
  const existing = await db.message.findUnique({
    where: {
      workspaceId_channel_externalId: { workspaceId, channel, externalId: msg.externalId },
    },
    select: { id: true },
  });
  if (existing) return;

  const defaultStageId = await ensureDefaultStage(workspaceId);
  const { firstName, lastName } = splitContactName(msg.contactPhone);

  const conversation = await runWithSerializableRetry(async (tx) => {
    // Channel-scoped like the live message/call ingest sites: contact-share can
    // stamp this phone onto a messenger/instagram contact (the (workspaceId,
    // phoneNumber) partial unique is whatsapp-only), so an unscoped lookup would
    // fold this WhatsApp coexistence-history backfill onto a social contact.
    // channel is always 'whatsapp' here; cross-channel identity is a Customer
    // concern, never a fold.
    const found = await tx.contact.findFirst({
      where: { workspaceId, identityChannel: channel, phoneNumber: msg.contactPhone },
      select: { id: true },
    });
    let contactId = found?.id;
    if (!contactId) {
      const createdContact = await tx.contact.create({
        data: {
          workspaceId,
          identityChannel: channel,
          phoneNumber: msg.contactPhone,
          name: msg.contactPhone,
          firstName,
          lastName,
          countryCode: getCountryFromPhone(msg.contactPhone),
          stageId: defaultStageId,
          // Deliberately NOT setting lastInboundAt — see below.
        },
        select: { id: true },
      });
      contactId = createdContact.id;
    }
    // A Coexistence HISTORY backfill must NEVER open a customer-service window.
    // Meta: "Customer service windows will only be opened when a WhatsApp user
    // messages a business customer who is already onboarded onto Cloud API. If a
    // WhatsApp user messages a business just prior to the business being onboarded
    // onto Cloud API, the business can only respond with a template message, since
    // no customer service was opened."
    //
    // The history webhook delivers exactly that pre-onboarding conversation
    // (phase 0 runs backwards from the onboarding instant), so phase 0 routinely
    // contains inbounds from minutes before onboarding. Stamping lastInboundAt
    // from them made the composer show an OPEN 24h window on the first day of
    // every Coexistence onboarding, accept a free-form reply, and have Meta reject
    // it as template-required. A backfilled thread is closed by construction.
    //
    // The inverse is already correct and stays correct: business-app sends do not
    // extend the window either ("Messages sent from the WhatsApp Business app are
    // not subject to the customer service window and do not create, extend, or
    // affect Cloud API conversation windows"), and the echo path writes no
    // lastInboundAt.

    const existingConvo = await tx.conversation.findFirst({
      where: { workspaceId, contactId },
      orderBy: { lastMessageAt: "desc" },
    });
    if (existingConvo) return existingConvo;
    // Backfilled-only threads land closed — archived context, not triage.
    return tx.conversation.create({
      data: {
        workspaceId,
        contactId,
        channel,
        ...(msg.channelConnectionId ? { channelConnectionId: msg.channelConnectionId } : {}),
        status: "closed",
        lastMessageAt: msg.timestamp,
        lastMessagePreview: "",
      },
    });
  });

  await createOutboundMessageIdempotent({
    workspaceId,
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
  workspaceId: string;
  channel: Channel;
  conversation: { id: string };
  evt: NormalizedInboundMessage;
  replySnapshot: ReplySnapshot | null;
  mediaPending: boolean;
}): Message {
  const { createdId, workspaceId, channel, conversation, evt, replySnapshot, mediaPending } = args;
  return {
    id: createdId,
    workspaceId,
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
    // Structured rendering (location map-pin / contact vCard / IG story card)
    // and ad/deep-link attribution ("from your ad" chip) MUST ride the live
    // frame too — they're persisted on the row (see the create above), so
    // without them here a contact-card / location / story / ad message renders
    // its plain-text placeholder body live and only becomes a card after a
    // refetch (the "text now, card after refresh" bug). Same shape the DB read
    // path returns, so the live bubble and the refetched bubble are identical.
    ...(evt.structured ? { structured: evt.structured } : {}),
    ...(evt.attribution ? { attribution: evt.attribution } : {}),
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
  /** WHICH account on that channel — see the snapshot type. Carried so the
   *  `message.received` webhook envelope and the workflow trigger both know
   *  the number/Page the customer actually wrote to. */
  channelConnectionId?: string | null;
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
    channelConnectionId: c.channelConnectionId ?? null,
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
  // NEVER split an identity fallback into a first name.
  //
  // `Contact.name` legitimately falls back to the phone number / handle so the
  // inbox list has something to render. `firstName` must not: it is a CLAIM
  // that we know the person's given name, and it is what
  // `$var.contact.first_name` resolves to. Left unguarded, a broadcast
  // personalised with "Hi {{first_name}}" greeted customers as
  // "Hi 96171505894" — and the contact panel asserted a first name we were
  // never told. WhatsApp only shares `profile.name` once the customer messages
  // FIRST, so an outbound-initiated contact legitimately has no name at all;
  // null is the honest answer until they reply.
  if (looksLikeIdentityFallback(trimmed)) return { firstName: null, lastName: null };
  const idx = trimmed.indexOf(" ");
  if (idx === -1) return { firstName: trimmed, lastName: null };
  return {
    firstName: trimmed.slice(0, idx),
    lastName: trimmed.slice(idx + 1).trim() || null,
  };
}

/**
 * Is this "name" actually just the raw identity we fell back to?
 *
 * Deliberately narrow: an all-digits string (a phone number, with or without a
 * leading +), or an opaque provider id (`vis_…`, a BSUID like `LB.9464…`, a
 * PSID). A real display name that happens to contain digits is untouched.
 */
function looksLikeIdentityFallback(value: string): boolean {
  const compact = value.replace(/[\s()+-]/g, "");
  if (compact.length === 0) return false;
  // Pure digits → a phone number.
  if (/^\d+$/.test(compact)) return true;
  // Opaque ids we mint or receive: `vis_<uuid>`, `LB.9464…`-style BSUIDs.
  if (/^vis_/i.test(compact)) return true;
  if (/^[A-Z]{2}\.\d+$/.test(compact)) return true;
  return false;
}

/** Pull the most recent N messages on the conversation, excluding the trigger
 *  message itself. Surfaced in MessageReceivedPayload.recentMessages so a
 *  downstream AI flow has short-term context without a callback. */
async function loadRecentForWorkflow(
  workspaceId: string,
  conversationId: string,
  excludeMessageId: string,
  // Optional tx — pass it when the caller is already inside a $transaction
  // (e.g. the inbound-ingest atomic block, which writes the outbox row in
  // the same tx and needs the recentMessages snapshot to be consistent
  // with what just committed). Without tx, runs on the global pool.
  client: { message: typeof db.message } = db,
): Promise<WorkflowMessageSnapshot[]> {
  const rows = await client.message.findMany({
    // workspaceId is transitively guaranteed (conversationId was resolved
    // tenant-scoped upstream) — carried anyway per the §18 letter, so the
    // where-checker convention stays greppable and a future caller can't
    // reach across tenants with a raw id.
    where: { workspaceId, conversationId, NOT: { id: excludeMessageId } },
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
  workspaceId: string;
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
    workspaceId: c.workspaceId,
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
/**
 * Meta's BSUID transition gives a customer's OWN message TWO wamids: the inbound
 * webhook stores a PHONE-encoded id (`wamid.HBgL…<phone>…`), but when the
 * customer QUOTES that message the reply's `context.id` is BSUID-encoded
 * (`wamid.HBgS…<user_id>…`). Same message, different string — so a direct
 * externalId lookup misses and the quote was lost ("reply-to-own shows as a
 * normal message"). The per-message hash TAIL of the wamid is identical across
 * both encodings (verified: they differ only in the sender-id prefix and a
 * 2-byte `15 xx` marker), so extract that tail as a stable cross-identity key.
 * Returns null for non-wamid ids (social mids carry no identity prefix and match
 * directly) or an unrecognised wamid layout.
 */
export function wamidMessageKey(externalId: string): string | null {
  if (!externalId.startsWith("wamid.")) return null;
  try {
    const b = Buffer.from(externalId.slice(6), "base64");
    // Layout: 1C 18 <idLen> <sender-id bytes> 15 <marker> <stable message hash>.
    if (b.length < 5 || b[0] !== 0x1c || b[1] !== 0x18) return null;
    const idLen = b[2]!;
    const rest = b.subarray(3 + idLen);
    if (rest.length < 3 || rest[0] !== 0x15) return null;
    // Drop the `15 <marker>` (02 on the sent id, 14 on the quoted context id).
    return rest.subarray(2).toString("hex");
  } catch {
    return null;
  }
}

export async function loadReplySnapshotByExternalId(
  externalId: string,
  scope: { workspaceId: string; channel: Channel },
): Promise<ReplySnapshot | null> {
  // Post the (workspaceId, channel, externalId) compound unique migration,
  // externalId alone isn't unique; pass the scope explicitly so cross-team
  // / cross-channel replies can't accidentally resolve to a different row.
  const row = await db.message.findUnique({
    where: {
      workspaceId_channel_externalId: {
        workspaceId: scope.workspaceId,
        channel: scope.channel,
        externalId,
      },
    },
    select: REPLY_TO_INCLUDE.select,
  });
  if (row) return mapReplySnapshot(row);

  // BSUID fallback (WhatsApp only): the quoted id may be a re-encoding, under
  // the customer's OTHER identity, of a message we DID store — match on the
  // identity-independent wamid tail. Bounded scan; runs ONLY when the direct
  // lookup misses (rare — a customer quoting their own message), so it never
  // touches the common reply-to-us path.
  const key = wamidMessageKey(externalId);
  if (!key) return null;
  const candidates = await db.message.findMany({
    where: { workspaceId: scope.workspaceId, channel: scope.channel },
    orderBy: { createdAt: "desc" },
    take: 300,
    select: { ...REPLY_TO_INCLUDE.select, externalId: true },
  });
  const match = candidates.find(
    (c) => c.externalId != null && wamidMessageKey(c.externalId) === key,
  );
  return match ? mapReplySnapshot(match) : null;
}

export async function loadReplySnapshotById(
  workspaceId: string,
  id: string,
): Promise<ReplySnapshot | null> {
  const row = await db.message.findFirst({
    where: { id, workspaceId },
    select: REPLY_TO_INCLUDE.select,
  });
  return mapReplySnapshot(row);
}

/**
 * Run `work` in a Serializable transaction, retrying once on Postgres
 * `40001` (serialization failure) OR `23505` (unique violation). Two
 * concurrent webhook handlers ingesting the first inbound from the same
 * brand-new phone can race the findFirst→create on both `Contact` (partial
 * unique on phone) and `Conversation` (full unique on (workspaceId, contactId)).
 * Serializable + a retry is the cleanest fix. In practice Postgres usually
 * fires P2034 first via predicate locking, but the unique-index backstop
 * can race ahead — we retry both signals so the loser's tx restarts cleanly
 * and finds the row the winner committed.
 */
export async function runWithSerializableRetry<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  // ATTEMPTS AND BACKOFF ARE MEASURED, NOT GUESSED. This was 2 attempts with a
  // flat 5-25ms jitter, which is enough for two writers colliding once and not
  // enough for a real burst. The B-M5 pressure harness
  // (tests/e2e/meta-channels/pressure-burst-ingest.spec.ts) drove 500 inbound
  // webhooks across 50 contacts at 25 in flight and produced 273 serialization
  // conflicts; with one retry, 32 requests (6.4%) exhausted the budget and
  // returned 503.
  //
  // A 503 here is not a quiet failure — it is the fail-soft contract (CLAUDE.md
  // §8): Meta redelivers. So every exhausted retry converts one request into a
  // whole redelivered BATCH later, amplifying exactly the load that caused it,
  // and a sustained error rate is also how Meta decides to throttle or disable
  // a webhook subscription. Spending a few hundred milliseconds retrying is far
  // cheaper than that.
  //
  // Conflicts here are inherent, not a bug to fix elsewhere: ten messages from
  // ONE customer arriving together all touch that contact's conversation row
  // (unreadCount, lastMessagePreview), and Serializable is what makes the
  // one-conversation-per-contact invariant hold. The right answer to a
  // serialization conflict is to retry it.
  //
  // Exponential backoff with FULL jitter (random in [0, cap]) rather than a
  // fixed sleep: symmetric retries after a fixed delay collide again in step.
  // Worst case adds ~0.5s before giving up — bounded well inside the 5s pool
  // acquisition timeout, so a retrying request can never be the thing that
  // starves the pool.
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await db.$transaction(work, { isolationLevel: "Serializable" });
    } catch (err) {
      const isRaceRetryable =
        err instanceof Prisma.PrismaClientKnownRequestError &&
        (err.code === "P2034" || err.code === "P2002");
      if (!isRaceRetryable || attempt === MAX_ATTEMPTS - 1) throw err;
      const cap = Math.min(240, 15 * 2 ** attempt);
      await new Promise((r) => setTimeout(r, Math.random() * cap));
    }
  }
  // Unreachable — the loop either returns or throws.
  throw new Error("runWithSerializableRetry: exhausted retries");
}

