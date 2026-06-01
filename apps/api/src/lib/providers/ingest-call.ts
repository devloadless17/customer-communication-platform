import { Prisma, CallStatus, CallDirection } from "@prisma/client";

import { db } from "@/lib/db";
import { publishInTx } from "@/lib/events/outbox";
import {
  runWithSerializableRetry,
  splitContactName,
  toWorkflowContact,
} from "@/lib/providers/ingest";
import { ensureDefaultStage } from "@/lib/queries";
import { workflowConversationSnapshotAfterStatusChange } from "@/lib/workflows/events";
import type { NormalizedCallEvent } from "@ccp/shared/providers/types";
import type { Channel } from "@ccp/shared/types";
import { getCountryFromPhone } from "@ccp/shared/utils";

/**
 * Call-event ingest pipeline. Mirrors `ingestInboundMessage` in structure:
 *
 *   normalized call event → dedupe → upsert contact/conversation
 *                         → upsert Call row → publishInTx(call.*)
 *
 * Lifecycle phases land via separate webhooks for the same `externalCallId`:
 * (1) incoming/ringing_out → INSERT, (2) answered → UPDATE if the server-side
 * /answer didn't already win, (3) terminal → UPDATE + compute duration.
 *
 * Terminal-state guard: once Call.status is in {completed, missed, rejected,
 * failed}, a later out-of-order non-terminal webhook MUST NOT downgrade it
 * (Meta delivers at-least-once with no ordering guarantee). Same posture as
 * the Message.status `statusRank` guard.
 *
 * Permission events (granted / revoked) take a degraded path — no Call row
 * upsert, just the matching Contact mutation.
 */

const TERMINAL_STATUSES: ReadonlySet<CallStatus> = new Set([
  CallStatus.completed,
  CallStatus.missed,
  CallStatus.rejected,
  CallStatus.failed,
]);

function phaseToStatus(phase: NormalizedCallEvent["phase"]): CallStatus | null {
  switch (phase) {
    case "incoming":
    case "ringing_out":
      return CallStatus.ringing;
    case "answered":
      return CallStatus.in_progress;
    case "completed":
      return CallStatus.completed;
    case "missed":
      return CallStatus.missed;
    case "rejected":
      return CallStatus.rejected;
    case "failed":
      return CallStatus.failed;
    case "permission_granted":
    case "permission_revoked":
      // Handled separately — no Call row write.
      return null;
  }
}

export async function ingestCallEvent(
  teamId: string,
  channel: Channel,
  evt: NormalizedCallEvent,
): Promise<void> {
  // Permission events take a side-path: they mutate Contact, not Call.
  if (evt.phase === "permission_granted" || evt.phase === "permission_revoked") {
    await handlePermissionEvent(teamId, evt);
    return;
  }

  // Resolve contact + conversation (1:1 invariant). Reuses the same
  // Serializable-with-retry pattern as message ingest so two concurrent
  // first-time call webhooks for the same brand-new number can't race-
  // create duplicate rows.
  const defaultStageId = await ensureDefaultStage(teamId);
  const { contact, conversation, needsReopen } = await runWithSerializableRetry(
    async (tx) => {
      const existingContact = await tx.contact.findFirst({
        where: { teamId, phoneNumber: evt.contactPhone },
        select: { id: true },
      });

      const { firstName, lastName } = splitContactName(
        evt.contactName ?? evt.contactPhone,
      );
      let contact;
      if (existingContact) {
        // Revive a soft-deleted contact on a call the same way ingest does
        // for a message — they're reaching out, they belong back in the
        // directory. Do NOT touch name or stage.
        contact = await tx.contact.update({
          where: { id: existingContact.id },
          data: { deletedAt: null },
        });
      } else {
        contact = await tx.contact.create({
          data: {
            teamId,
            identityChannel: channel,
            phoneNumber: evt.contactPhone,
            name: evt.contactName ?? evt.contactPhone,
            firstName,
            lastName,
            countryCode: getCountryFromPhone(evt.contactPhone),
            stageId: defaultStageId,
          },
        });
      }

      // One conversation per contact, forever. Closed → pending reopen on
      // an inbound call mirrors the message-ingest reopen.
      const existingConvo = await tx.conversation.findFirst({
        where: { teamId, contactId: contact.id },
        orderBy: { lastMessageAt: "desc" },
      });
      let conversation = existingConvo;
      // NOTE: we do NOT perform the closed→pending reopen UPDATE here. The
      // matching `conversation.status_changed` event must commit atomically
      // with the status flip, but it's published via publishInTx in the SECOND
      // (Call-upsert) transaction below. Flipping here (tx1) and publishing
      // there (tx2) splits them — a transient tx2 failure after tx1 commits
      // would leave the conversation silently reopened with NO event (workflows
      // / audit / partners miss it), and the outer ingestEvents catch swallows
      // the error so Meta never retries. So we only DETECT the reopen here and
      // do the flip + publish together in tx2. Mirrors the message-ingest
      // invariant (ingest.ts co-commits reopen + publishInTx in one tx).
      let needsReopen = false;
      if (!conversation) {
        conversation = await tx.conversation.create({
          data: {
            teamId,
            contactId: contact.id,
            channel,
            status: "pending",
            lastMessageAt: evt.timestamp,
            lastMessagePreview: "",
          },
        });
      } else if (conversation.status === "closed" && evt.direction === "in") {
        // Only INBOUND calls reopen a closed thread. An outbound call to a
        // closed-thread contact stays closed at the conversation level (the
        // agent already chose to close it; reopening on every call is noisy).
        needsReopen = true;
      }
      return { contact, conversation, needsReopen };
    },
  );

  // Upsert the Call row in its own tx so the publishInTx outbox row commits
  // atomically with whatever Call mutation we make. Find-or-create by the
  // compound unique; on UPDATE, apply the terminal-state guard.
  const targetStatus = phaseToStatus(evt.phase);
  if (!targetStatus) return;

  try {
    await db.$transaction(async (tx) => {
      const existing = await tx.call.findUnique({
        where: {
          teamId_channel_externalCallId: {
            teamId,
            channel,
            externalCallId: evt.externalCallId,
          },
        },
        select: {
          id: true,
          status: true,
          direction: true,
          answeredAt: true,
          answeredByUserId: true,
        },
      });

      let callRow: { id: string; status: CallStatus };
      let isFirstInsert = false;
      // True when this webhook lands on a row that was ALREADY terminal — i.e.
      // a duplicate/redundant terminal delivery (Meta is at-least-once with no
      // ordering guarantee). The phase-event publishes + the unanswered-counter
      // increment below are gated on `!alreadyTerminal` so a redelivered
      // `missed`/`completed`/`rejected`/`failed` webhook is a true no-op for
      // side effects: re-publishing call.* would re-fire any future call-event
      // subscriber, and re-incrementing consecutiveUnansweredOutCalls (which
      // mirrors Meta's auto-revocation counter + drives the contact-panel
      // warning) is NOT idempotent and would inflate on every retry.
      const alreadyTerminal = existing
        ? TERMINAL_STATUSES.has(existing.status)
        : false;
      if (existing) {
        // Terminal-state guard. If the row already landed in a terminal
        // state, ANY later webhook (terminal or not, out-of-order delivery)
        // must NOT mutate the row's status/timestamps. Previously the guard
        // only rejected non-terminal downgrades, leaving a subtle drift: a
        // duplicate terminal webhook would re-write endedAt + recompute
        // durationSeconds from a later evt.timestamp, inflating the duration
        // by however long Meta's redelivery lagged. Now we fully no-op on an
        // already-terminal row — `alreadyTerminal` separately suppresses the
        // side-effect publishes below, so this is a complete no-op.
        if (alreadyTerminal) {
          callRow = { id: existing.id, status: existing.status };
        } else {
          // Compute durationSeconds at the terminal transition. answeredAt
          // is null on calls that never reached in_progress (missed /
          // rejected pre-answer), and we leave duration null in that case.
          const isTerminal = TERMINAL_STATUSES.has(targetStatus);
          const durationSeconds =
            isTerminal && existing.answeredAt
              ? Math.max(
                  0,
                  Math.floor(
                    (evt.timestamp.getTime() - existing.answeredAt.getTime()) /
                      1000,
                  ),
                )
              : null;
          callRow = await tx.call.update({
            where: { id: existing.id },
            data: {
              status: targetStatus,
              // answeredAt is set-once: only on the first in_progress
              // transition. A later out-of-order in_progress webhook (e.g.
              // arriving after `completed` was already overlaid by a
              // subsequent retry) must not re-stamp it. The alreadyTerminal
              // branch above covers the harder case; this guard covers the
              // ringing→in_progress→in_progress retry case where the row
              // hasn't yet terminalized.
              ...(targetStatus === CallStatus.in_progress && !existing.answeredAt
                ? { answeredAt: evt.timestamp }
                : {}),
              ...(isTerminal ? { endedAt: evt.timestamp, durationSeconds } : {}),
              rawPayload: evt.rawPayload as Prisma.InputJsonValue,
            },
            select: { id: true, status: true },
          });
        }
      } else {
        // INSERT path — first webhook for this call id.
        const direction: CallDirection =
          evt.direction === "in" ? CallDirection.in : CallDirection.out;
        const isTerminalFirstWebhook = TERMINAL_STATUSES.has(targetStatus);
        callRow = await tx.call.create({
          data: {
            teamId,
            conversationId: conversation.id,
            externalCallId: evt.externalCallId,
            channel,
            direction,
            status: targetStatus,
            ringingAt: evt.timestamp,
            // A terminal-on-first-webhook call never reached in_progress (no
            // answeredAt to subtract from), so durationSeconds stays NULL — not
            // 0. Leaving it null keeps the row consistent with both the UPDATE
            // path (which computes null when answeredAt is null) and the
            // call.ended event published below (which also resolves to null on a
            // first insert). Writing 0 here drifted the row from its own event.
            ...(isTerminalFirstWebhook ? { endedAt: evt.timestamp } : {}),
            rawPayload: evt.rawPayload as Prisma.InputJsonValue,
          },
          select: { id: true, status: true },
        });
        isFirstInsert = true;
      }

      // Reopen the closed thread HERE (tx2), atomically with its event. The
      // CAS `where status: "closed"` makes it idempotent across Meta retries:
      // if a concurrent path already reopened it, count===0 and we skip the
      // publish too, so we never emit a phantom closed→pending for a thread
      // that wasn't actually closed at flip time. publishInTx co-commits the
      // event with this UPDATE — a tx2 rollback drops both together.
      //
      // Skip the reopen on a duplicate already-terminal webhook: the row
      // didn't change, so we shouldn't synthesize a status flip from an
      // at-least-once redelivery. The original (non-terminal) webhook for
      // this call already drove the reopen.
      if (needsReopen && !alreadyTerminal) {
        const flip = await tx.conversation.updateMany({
          where: { id: conversation.id, status: "closed" },
          data: { status: "pending" },
        });
        if (flip.count > 0) {
          // Reopen frame goes first so audit/workflow see the status change
          // before the call event arrives. Snapshot reflects the flipped
          // status + predicted close-field nulling so workflow-dispatch
          // doesn't need a fresh DB read.
          const reopenSnapshot = workflowConversationSnapshotAfterStatusChange(
            { ...conversation, status: "pending" },
            { previousStatus: "closed", changedByUserId: null },
          );
          await publishInTx(tx, {
            type: "conversation.status_changed",
            teamId,
            conversationId: conversation.id,
            previousStatus: "closed",
            newStatus: "pending",
            changedByUserId: null,
            contact: toWorkflowContact(contact),
            conversation: reopenSnapshot,
          });
        }
      }

      // Surface the thread in the inbox list on real call activity by bumping
      // lastMessageAt. A newly-created conversation already has it set to
      // evt.timestamp (the `lt` guard below makes this a no-op for it), but an
      // EXISTING conversation otherwise never moved on a call — so a missed /
      // incoming call silently stayed buried in the list instead of rising for
      // triage. Gated on !alreadyTerminal so a duplicate terminal redelivery
      // doesn't re-bump; the monotonic `lt` guard stops an out-of-order webhook
      // from moving the timestamp backward past a newer message or call.
      if (!alreadyTerminal) {
        await tx.conversation.updateMany({
          where: { id: conversation.id, lastMessageAt: { lt: evt.timestamp } },
          data: { lastMessageAt: evt.timestamp },
        });
      }

      // Emit the phase-specific domain event. Inserts always emit the
      // direction-appropriate "incoming" / "ringing_out"; subsequent
      // updates emit per-phase terminal frames.
      if (isFirstInsert && evt.direction === "in") {
        await publishInTx(tx, {
          type: "call.incoming",
          teamId,
          conversationId: conversation.id,
          callId: callRow.id,
          externalCallId: evt.externalCallId,
          contact: toWorkflowContact(contact),
          ringingAt: evt.timestamp.toISOString(),
        });
      }
      if (isFirstInsert && evt.direction === "out") {
        await publishInTx(tx, {
          type: "call.ringing_out",
          teamId,
          conversationId: conversation.id,
          callId: callRow.id,
          externalCallId: evt.externalCallId,
          // Outbound calls placed via the API attribute the initiator on
          // CallsService; the webhook ingest path has no acting user here.
          // Callers reading the event downstream should treat absence
          // gracefully — the placeCall REST path emits its own immediate
          // ringing event with the right userId.
          initiatedByUserId: "",
          ringingAt: evt.timestamp.toISOString(),
        });
      }
      // Terminal phase-events + the unanswered-counter mutation fire ONLY on a
      // genuine non-terminal→terminal transition. `alreadyTerminal` means this
      // is a duplicate/redundant terminal webhook (Meta at-least-once) landing
      // on a row that already terminalized — re-publishing call.* would re-fire
      // downstream subscribers and re-incrementing the (non-idempotent) counter
      // would inflate it. A duplicate terminal webhook thus becomes a true
      // no-op for side effects (the row UPDATE above is idempotent). Inserts
      // (isFirstInsert) are never alreadyTerminal, so a terminal-on-first-
      // webhook call still fires its event exactly once.
      if (!alreadyTerminal) {
        if (evt.phase === "completed") {
          await publishInTx(tx, {
            type: "call.ended",
            teamId,
            conversationId: conversation.id,
            callId: callRow.id,
            direction: evt.direction,
            endedAt: evt.timestamp.toISOString(),
            // Carry the duration computed on the row UPDATE above (endedAt -
            // answeredAt) instead of null, so a customer-hangup call shows its
            // real length in the timeline/partner payload. Null only when the
            // call never reached in_progress (no answeredAt to subtract from).
            durationSeconds:
              existing?.answeredAt
                ? Math.max(
                    0,
                    Math.floor(
                      (evt.timestamp.getTime() - existing.answeredAt.getTime()) /
                        1000,
                    ),
                  )
                : null,
            reason: "hangup_by_customer",
          });
        } else if (evt.phase === "missed") {
          await publishInTx(tx, {
            type: "call.missed",
            teamId,
            conversationId: conversation.id,
            callId: callRow.id,
            ringingAt: evt.timestamp.toISOString(),
          });
          // Unanswered outbound — mirror Meta's auto-revocation counter.
          if (evt.direction === "out") {
            await tx.contact.update({
              where: { id: contact.id },
              data: { consecutiveUnansweredOutCalls: { increment: 1 } },
            });
          }
        } else if (evt.phase === "rejected") {
          await publishInTx(tx, {
            type: "call.rejected",
            teamId,
            conversationId: conversation.id,
            callId: callRow.id,
            rejectedByUserId: null,
            endedAt: evt.timestamp.toISOString(),
          });
        } else if (evt.phase === "failed") {
          await publishInTx(tx, {
            type: "call.failed",
            teamId,
            conversationId: conversation.id,
            callId: callRow.id,
            reason: "provider_error",
            endedAt: evt.timestamp.toISOString(),
          });
        }

        // Reset the unanswered counter on any successful completion. The
        // counter is "consecutive" — a single answered call resets it.
        if (evt.phase === "completed" && evt.direction === "out") {
          await tx.contact.update({
            where: { id: contact.id },
            data: { consecutiveUnansweredOutCalls: 0 },
          });
        }
      }

      // Forward SDP to the browser regardless of type — for inbound calls
      // it's an OFFER (browser feeds into setRemoteDescription, generates
      // answer); for OUTBOUND calls it's the customer's ANSWER (browser
      // feeds into setRemoteDescription to complete the handshake). The
      // socket event was originally named `call:sdp_offer` for the inbound
      // case but is reused for both — payload carries the actual type so
      // the browser's onSdpOffer handler can branch.
      //
      // CRITICAL: losing this frame on outbound = call never establishes
      // media, connectionState goes to "failed" after ~15s ICE timeout,
      // and the user sees a panel that closes itself. This was a real bug
      // in the first outbound flow.
      if (evt.sdp) {
        await publishInTx(tx, {
          type: "call.sdp_offer",
          teamId,
          conversationId: conversation.id,
          callId: callRow.id,
          // The shared event type narrows `sdp.type` to "offer"; carry
          // the actual type through with an `as` so the wire payload
          // stays honest. Browser branches on type to decide
          // setRemoteDescription role.
          sdp: { type: evt.sdp.type as "offer", sdp: evt.sdp.sdp },
        });
      }
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Race: a parallel worker won the Call insert. Drop without side
      // effects — the winner's tx already published.
      return;
    }
    throw err;
  }
}

/**
 * Permission granted/revoked side-path. No Call row mutation — these are
 * Contact-level state. Revocation sets `callPermissionRevokedUntil` to the
 * far future (Meta requires a fresh permission request from the customer
 * to re-enable); granted clears it AND resets the unanswered counter.
 */
async function handlePermissionEvent(
  teamId: string,
  evt: NormalizedCallEvent,
): Promise<void> {
  const contact = await db.contact.findFirst({
    where: { teamId, phoneNumber: evt.contactPhone },
    select: { id: true },
  });
  if (!contact) return;

  if (evt.phase === "permission_granted") {
    await db.contact.update({
      where: { id: contact.id },
      data: {
        callPermissionRevokedUntil: null,
        consecutiveUnansweredOutCalls: 0,
      },
    });
  } else if (evt.phase === "permission_revoked") {
    // Far-future timestamp acts as "revoked until further notice" — Meta
    // doesn't expire revocation on its own; the customer has to grant a
    // fresh permission. We clear it on the next successful permission
    // grant rather than letting a timer run out.
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    await db.contact.update({
      where: { id: contact.id },
      data: {
        callPermissionRevokedUntil: farFuture,
        // Reset the counter so the UI's warning state resolves once Meta
        // confirms the revocation — they've already taken the action.
        consecutiveUnansweredOutCalls: 0,
      },
    });
  }
}

