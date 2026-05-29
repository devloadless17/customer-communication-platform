import { Prisma, CallStatus, CallDirection } from "@prisma/client";

import { db } from "@/lib/db";
import { publishInTx } from "@/lib/events/outbox";
import {
  runWithSerializableRetry,
  splitContactName,
  toWorkflowContact,
} from "@/lib/providers/ingest";
import { ensureDefaultStage } from "@/lib/queries";
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

  // ICE-candidate-only webhooks (no `phase` matters past the gate): publish
  // straight to the bus without touching the Call row. The browser is the
  // only consumer; the row's state isn't changing.
  if (
    evt.iceCandidate &&
    !evt.sdp &&
    evt.phase !== "completed" &&
    evt.phase !== "missed" &&
    evt.phase !== "rejected" &&
    evt.phase !== "failed"
  ) {
    await publishIceCandidateOnly(teamId, channel, evt);
    return;
  }

  // Resolve contact + conversation (1:1 invariant). Reuses the same
  // Serializable-with-retry pattern as message ingest so two concurrent
  // first-time call webhooks for the same brand-new number can't race-
  // create duplicate rows.
  const defaultStageId = await ensureDefaultStage(teamId);
  const { contact, conversation, reopened } = await runWithSerializableRetry(
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
      let reopened = false;
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
      } else if (
        existingConvo &&
        existingConvo.status === "closed" &&
        evt.direction === "in"
      ) {
        // Only INBOUND calls reopen a closed thread. An outbound call to a
        // closed-thread contact stays closed at the conversation level
        // (the agent already chose to close it; reopening on every call
        // would be noisy).
        conversation = await tx.conversation.update({
          where: { id: existingConvo.id },
          data: { status: "pending" },
        });
        reopened = true;
      }
      return { contact, conversation: conversation!, reopened };
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
      if (existing) {
        // Terminal-state guard. If the row already landed in a terminal
        // state, a later non-terminal webhook (out-of-order delivery) must
        // not downgrade it. Idempotent same-status writes are still OK so
        // a duplicate webhook on a terminal state is a no-op success.
        if (
          TERMINAL_STATUSES.has(existing.status) &&
          !TERMINAL_STATUSES.has(targetStatus) &&
          existing.status !== targetStatus
        ) {
          return;
        }
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
            ...(targetStatus === CallStatus.in_progress && !existing.answeredAt
              ? { answeredAt: evt.timestamp }
              : {}),
            ...(isTerminal ? { endedAt: evt.timestamp, durationSeconds } : {}),
            rawPayload: evt.rawPayload as Prisma.InputJsonValue,
          },
          select: { id: true, status: true },
        });
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
            ...(isTerminalFirstWebhook
              ? { endedAt: evt.timestamp, durationSeconds: 0 }
              : {}),
            rawPayload: evt.rawPayload as Prisma.InputJsonValue,
          },
          select: { id: true, status: true },
        });
        isFirstInsert = true;
      }

      // Publish via outbox so subscribers see the mutation atomically with
      // the commit. The reopen frame goes first so audit/workflow see the
      // status change before the call event arrives.
      if (reopened) {
        await publishInTx(tx, {
          type: "conversation.status_changed",
          teamId,
          conversationId: conversation.id,
          previousStatus: "closed",
          newStatus: "pending",
          changedByUserId: null,
          contact: toWorkflowContact(contact),
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
      if (evt.phase === "completed") {
        await publishInTx(tx, {
          type: "call.ended",
          teamId,
          conversationId: conversation.id,
          callId: callRow.id,
          direction: evt.direction,
          endedAt: evt.timestamp.toISOString(),
          durationSeconds: null,
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
        });
      } else if (evt.phase === "failed") {
        await publishInTx(tx, {
          type: "call.failed",
          teamId,
          conversationId: conversation.id,
          callId: callRow.id,
          reason: "provider_error",
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

      // SDP offer goes on its own frame regardless of phase, so the browser
      // gets it as soon as it lands. Outside the tx for ICE; bundled here
      // for SDP because losing it = the call can't establish (vs an ICE
      // candidate where redundancy means we can lose one).
      if (evt.sdp && evt.sdp.type === "offer") {
        await publishInTx(tx, {
          type: "call.sdp_offer",
          teamId,
          conversationId: conversation.id,
          callId: callRow.id,
          // Re-narrow the SDP envelope: TS doesn't carry the type-guard
          // through the publishInTx call site, so reconstruct explicitly.
          sdp: { type: "offer", sdp: evt.sdp.sdp },
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

/**
 * ICE-candidate-only webhook. No DB write — the live agent's browser is
 * the only consumer. We need a Call row to resolve `callId`, so look it up
 * by externalCallId; if no row exists yet (rare race — first webhook is
 * the ICE one), drop the candidate. The browser will see subsequent ones.
 */
async function publishIceCandidateOnly(
  teamId: string,
  channel: Channel,
  evt: NormalizedCallEvent,
): Promise<void> {
  if (!evt.iceCandidate) return;
  const row = await db.call.findUnique({
    where: {
      teamId_channel_externalCallId: {
        teamId,
        channel,
        externalCallId: evt.externalCallId,
      },
    },
    select: { id: true, conversationId: true },
  });
  if (!row) return;
  // Publish through bus (no outbox needed — ICE is ephemeral signaling and
  // a missed candidate is recoverable from the next one).
  const { publish } = await import("@/lib/events/bus");
  await publish({
    type: "call.ice_candidate",
    teamId,
    conversationId: row.conversationId,
    callId: row.id,
    candidate: evt.iceCandidate,
  });
}
