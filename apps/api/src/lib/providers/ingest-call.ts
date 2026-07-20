import {
  Prisma,
  CallStatus,
  CallDirection,
  CallPermissionStatus,
} from "@prisma/client";
import type { Contact, Conversation } from "@prisma/client";

import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { publishInTx } from "@/lib/events/outbox";
import { resolveCustomerId } from "@/lib/identity/identity-service";
import { toContactWire } from "@/lib/queries/_shared";
import {
  runWithSerializableRetry,
  splitContactName,
  toWorkflowContact,
} from "@/lib/providers/ingest";
import { ensureDefaultStage } from "@/lib/queries";
import { workflowConversationSnapshotAfterStatusChange } from "@/lib/workflows/events";
import { isPhoneChannel } from "@ccp/shared/providers/capabilities";
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
    case "connecting":
      // `connecting` = the outbound media leg came up (provider's SDP answer),
      // NOT the human picking up. The row stays `ringing`; the SDP is forwarded
      // to the browser regardless of status (see the sdp block below). answeredAt
      // is stamped later, from the terminate's real pickup time.
      return CallStatus.ringing;
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
    await handlePermissionEvent(teamId, channel, evt);
    return;
  }

  // Channel-aware caller identity — mirrors the message-ingest resolution
  // (providers/ingest.ts): phone channels (WhatsApp) resolve/create by
  // `phoneNumber`; external-id channels (Messenger PSID / Instagram IGSID) by
  // the compound `(teamId, identityChannel, externalContactId)`. Exactly one
  // identity is set on the event, so a PSID is never digit-stripped into a
  // phone nor collides with a WhatsApp contact sharing the same digits.
  // On phone channels the caller may be identified by a BSUID instead of a
  // phone (Meta omits `wa_id` for contacts not messaged in 30 days) — same
  // either/or the message path handles, resolved against both keys below.
  const isPhone = isPhoneChannel(channel);
  const identityLabel = isPhone
    ? evt.contactPhone ?? evt.bsuid
    : evt.externalContactId;

  let contact: Contact;
  let conversation: Conversation;
  let needsReopen = false;

  if (!identityLabel) {
    // A status webhook (Messenger `media_update` / `terminate`) that references
    // an EXISTING call by id and carries no caller identity. Resolve the row's
    // contact/conversation instead of creating one — you can't place a call
    // without a caller, so an unknown call id here is dropped (Meta is
    // at-least-once; a duplicate terminate for a purged row is a safe no-op).
    const existingCall = await db.call.findUnique({
      where: {
        teamId_channel_externalCallId: { teamId, channel, externalCallId: evt.externalCallId },
      },
      select: { conversation: { include: { contact: true } } },
    });
    if (!existingCall) return;
    const { contact: c, ...convo } = existingCall.conversation;
    contact = c;
    conversation = convo;
  } else {
    // Resolve contact + conversation (1:1 invariant). Reuses the same
    // Serializable-with-retry pattern as message ingest so two concurrent
    // first-time call webhooks for the same brand-new caller can't race-
    // create duplicate rows.
    const defaultStageId = await ensureDefaultStage(teamId);
    const resolved = await runWithSerializableRetry(async (tx) => {
      // Try BOTH phone and BSUID (phone first — it's the canonical key), so a
      // caller first seen cold as a BSUID and later warm as a phone resolves to
      // one contact instead of forking. Mirrors providers/ingest.ts.
      const contactIdentitySelect = {
        id: true,
        phoneNumber: true,
        bsuid: true,
        // Drives the `wasRevived` signal for the contact.created publish below.
        deletedAt: true,
      } as const;
      let existingContact: {
        id: string;
        phoneNumber: string | null;
        bsuid: string | null;
        deletedAt: Date | null;
      } | null = null;
      if (isPhone) {
        if (evt.contactPhone) {
          // Channel-scoped like message ingest: contact-share can stamp this
          // phone onto a social contact (the (teamId, phoneNumber) partial
          // unique is whatsapp-only), so an unscoped lookup could attach an
          // inbound WhatsApp call to a messenger/instagram contact sharing the
          // number. Cross-channel identity is a Customer concern, not a fold.
          existingContact = await tx.contact.findFirst({
            where: { teamId, identityChannel: channel, phoneNumber: evt.contactPhone },
            select: contactIdentitySelect,
          });
        }
        if (!existingContact && evt.bsuid) {
          existingContact = await tx.contact.findFirst({
            where: { teamId, identityChannel: channel, bsuid: evt.bsuid },
            select: contactIdentitySelect,
          });
        }
      } else {
        existingContact = await tx.contact.findFirst({
          where: { teamId, identityChannel: channel, externalContactId: evt.externalContactId },
          select: contactIdentitySelect,
        });
      }

      const { firstName, lastName } = splitContactName(
        evt.contactName ?? identityLabel,
      );
      let contact;
      if (existingContact) {
        // Revive a soft-deleted contact on a call the same way ingest does
        // for a message — they're reaching out, they belong back in the
        // directory. Do NOT touch name or stage. Backfill only missing identity
        // keys, so the next webhook resolves here whichever key it carries.
        const identityBackfill: {
          phoneNumber?: string;
          countryCode?: string | null;
          bsuid?: string;
        } = {};
        if (isPhone) {
          if (evt.contactPhone && !existingContact.phoneNumber) {
            identityBackfill.phoneNumber = evt.contactPhone;
            identityBackfill.countryCode = getCountryFromPhone(evt.contactPhone);
          }
          if (evt.bsuid && !existingContact.bsuid) identityBackfill.bsuid = evt.bsuid;
        }
        contact = await tx.contact.update({
          where: { id: existingContact.id },
          data: { deletedAt: null, ...identityBackfill },
        });
      } else {
        contact = await tx.contact.create({
          data: {
            teamId,
            identityChannel: channel,
            phoneNumber: isPhone ? evt.contactPhone ?? null : null,
            externalContactId: isPhone ? null : evt.externalContactId,
            bsuid: isPhone ? evt.bsuid ?? null : null,
            name: evt.contactName ?? identityLabel,
            firstName,
            lastName,
            // A BSUID-only caller has no phone to derive a country from.
            countryCode:
              isPhone && evt.contactPhone ? getCountryFromPhone(evt.contactPhone) : null,
            stageId: defaultStageId,
            // Unified Customer (§6), exactly as message-ingest does. Without it a
            // contact acquired by CALLING alone kept `customerId: null`, so the
            // person never appeared in the linked-channels switcher, never rolled
            // up in "Group by person", and was invisible to a `targetMode:
            // "customer"` broadcast until the drift sweeper happened to catch it.
            // Inside `tx` so the Customer rolls back with the contact.
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
      let reopen = false;
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
        reopen = true;
      }
      return {
        contact,
        conversation,
        needsReopen: reopen,
        isNewContact: !existingContact,
        wasRevived: !!existingContact?.deletedAt,
      };
    });
    contact = resolved.contact;
    conversation = resolved.conversation;
    needsReopen = resolved.needsReopen;

    // A caller we've never seen is a brand-new directory entry — announce it the
    // same way message-ingest does, so workflows, the audit timeline, the
    // contacts list and subscribed partners learn about a contact acquired by
    // CALL rather than by message. Post-commit + best-effort: the contact row is
    // already durable, and losing the announcement must never fail the call.
    if (resolved.isNewContact || resolved.wasRevived) {
      try {
        await publish({
          type: "contact.created",
          teamId,
          contact: toContactWire(resolved.contact),
          source: "inbound",
          createdByUserId: null,
        });
      } catch (err) {
        console.error(
          `[ingest-call] publish(contact.created) failed for team=${teamId} contact=${resolved.contact.id}:`,
          err,
        );
      }
    }
  }

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

      // ── Resolve the REAL answer state (channel-agnostic) ──────────────────
      // answeredAt comes from the provider's connected signal — for Meta that's
      // the terminate's `start_time` (evt.connectedAt), the actual pickup. We no
      // longer fabricate it from the media-setup `connect`, which fired ~1s after
      // dialing (before the human answered) and made every declined call look
      // connected. Inbound calls already carry answeredAt from the agent's
      // answerCall, so either source means the call genuinely connected.
      const priorAnsweredAt = existing?.answeredAt ?? null;
      const answeredAt = priorAnsweredAt ?? evt.connectedAt ?? null;
      const isTerminalPhase = TERMINAL_STATUSES.has(targetStatus);
      // The parser classifies a terminate as completed/missed from the connected
      // signal; correct the inbound case where the agent answered but the
      // provider omitted a duration (answeredAt is set ⇒ it completed). Never the
      // reverse — a parser "completed" already required real evidence.
      const effectiveStatus =
        targetStatus === CallStatus.missed && answeredAt
          ? CallStatus.completed
          : targetStatus;
      // Authoritative talk-time for a connected call: prefer the provider's own
      // end-of-call duration (Meta `terminate.duration`), else derive from the
      // real pickup. Non-connected terminals carry null.
      const terminalDurationSeconds =
        isTerminalPhase && effectiveStatus === CallStatus.completed
          ? evt.durationSeconds ??
            (answeredAt
              ? Math.max(
                  0,
                  Math.floor(
                    (evt.timestamp.getTime() - answeredAt.getTime()) / 1000,
                  ),
                )
              : null)
          : null;

      // ONE terminal→terminal correction is allowed: a row locked as `missed`
      // when it actually CONNECTED. Happens on an outbound call the customer
      // answered but the agent hung up before the browser's `markConnected`
      // stamped answeredAt — endCall CAS-flips ringing→missed. Meta's
      // authoritative terminate then arrives carrying start_time/duration (proof
      // it connected), but the `alreadyTerminal` no-op would otherwise leave it
      // permanently `missed` with durationSeconds=null. Correct the stored FIELDS
      // only; the non-idempotent side effects (publishes, unanswered-counter)
      // stay suppressed, so this can't re-fire subscribers or inflate the counter.
      const upgradeMissedToCompleted =
        !!existing &&
        existing.status === CallStatus.missed &&
        effectiveStatus === CallStatus.completed &&
        (evt.connectedAt != null || evt.durationSeconds != null);

      if (existing) {
        // Terminal-state guard. If the row already landed in a terminal
        // state, ANY later webhook (terminal or not, out-of-order delivery)
        // must NOT mutate the row's status/timestamps — `alreadyTerminal` also
        // suppresses the side-effect publishes below, so this is a complete
        // no-op against Meta's at-least-once redelivery. The sole exception is
        // the missed→completed correction above.
        if (alreadyTerminal && upgradeMissedToCompleted) {
          const corrected = await tx.call.update({
            where: { id: existing.id },
            data: {
              status: CallStatus.completed,
              ...(answeredAt ? { answeredAt } : {}),
              ...(terminalDurationSeconds != null
                ? { durationSeconds: terminalDurationSeconds }
                : {}),
              endedAt: evt.timestamp,
            },
            select: { id: true, status: true },
          });
          callRow = corrected;
          // The row was locked as `missed` but Meta's terminate proves it
          // CONNECTED, so mirror the two side effects a normal missed→completed
          // transition performs — the `!alreadyTerminal && isTerminalPhase`
          // block below is skipped for this already-terminal correction. Both
          // are idempotent: this branch runs exactly once (the next duplicate
          // terminate sees status=completed, so upgradeMissedToCompleted is
          // false and the plain no-op applies).
          //   1. Reset the unanswered-outbound counter — a connected outbound
          //      call clears it (mirror of Meta's auto-revocation reset),
          //      otherwise a real answer leaves the contact-panel warning stuck.
          if (existing.direction === CallDirection.out) {
            await tx.contact.update({
              where: { id: contact.id },
              data: { consecutiveUnansweredOutCalls: 0 },
            });
          }
          //   2. Publish the corrective terminal event so the conversation audit
          //      timeline (which recorded a `call_missed` pill from endCall) is
          //      superseded by `call_completed`, ending the divergence between
          //      the Calls page (row=completed) and the thread timeline.
          await publishInTx(tx, {
            type: "call.ended",
            teamId,
            conversationId: conversation.id,
            callId: corrected.id,
            direction: existing.direction,
            endedAt: evt.timestamp.toISOString(),
            durationSeconds: terminalDurationSeconds,
            reason: "hangup_by_customer",
          });
        } else if (alreadyTerminal) {
          callRow = { id: existing.id, status: existing.status };
        } else {
          // Status-rank guard (same posture as the Message.status statusRank
          // guard cited in the header). A non-terminal redelivery must never
          // DOWNGRADE a row that already advanced: Meta redelivers the
          // `connecting` webhook (→ ringing) minutes after CallsService
          // .markConnected flipped the row to in_progress, and an
          // unconditional write would push it back to ringing — the
          // stale-calls sweeper then terminalizes the still-LIVE call as
          // missed and tears down the agent's call panel. Only write status
          // when it isn't a downgrade: a terminal phase always wins
          // (alreadyTerminal is excluded above), and the sole non-terminal
          // target (`ringing`) is written only when the row is still ringing.
          const canWriteStatus =
            isTerminalPhase || existing.status === CallStatus.ringing;
          callRow = await tx.call.update({
            where: { id: existing.id },
            data: {
              ...(canWriteStatus ? { status: effectiveStatus } : {}),
              // answeredAt is set-once, stamped from the provider's REAL pickup
              // time (evt.connectedAt). Never from the media-setup connect.
              ...(!existing.answeredAt && evt.connectedAt
                ? { answeredAt: evt.connectedAt }
                : {}),
              ...(isTerminalPhase
                ? {
                    endedAt: evt.timestamp,
                    durationSeconds: terminalDurationSeconds,
                  }
                : {}),
              rawPayload: evt.rawPayload as Prisma.InputJsonValue,
            },
            select: { id: true, status: true },
          });
        }
      } else {
        // INSERT path — first webhook for this call id.
        const direction: CallDirection =
          evt.direction === "in" ? CallDirection.in : CallDirection.out;
        callRow = await tx.call.create({
          data: {
            teamId,
            conversationId: conversation.id,
            externalCallId: evt.externalCallId,
            channel,
            direction,
            status: effectiveStatus,
            ringingAt: evt.timestamp,
            // A terminal-on-first-webhook call (we missed the ringing/connect
            // legs): stamp answeredAt + duration from the provider's connected
            // signal when present, else leave null (never answered).
            ...(evt.connectedAt ? { answeredAt: evt.connectedAt } : {}),
            ...(isTerminalPhase
              ? { endedAt: evt.timestamp, durationSeconds: terminalDurationSeconds }
              : {}),
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
          channel,
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
      // Key the terminal events off the CORRECTED status (effectiveStatus), not
      // the raw parser phase — an outbound no-answer now resolves to `missed`
      // (so the counter fires) and an answered call to `completed` (carrying the
      // provider's authoritative duration). Only fires on a real non-terminal→
      // terminal transition (alreadyTerminal already excluded above).
      if (!alreadyTerminal && isTerminalPhase) {
        // Direction from the authoritative Call ROW, not the parser: the social
        // `terminate` webhook carries no direction signal, so mapSocialCall
        // hardcodes "in". Using it would record an OUTBOUND Messenger call as
        // inbound in the audit timeline and skip the unanswered-counter reset.
        // `existing` (pre-update snapshot) holds the real direction; on a
        // terminal-on-first-insert we fall back to the same value the INSERT used.
        const rowDirection: CallDirection =
          existing?.direction ??
          (evt.direction === "in" ? CallDirection.in : CallDirection.out);
        if (effectiveStatus === CallStatus.completed) {
          await publishInTx(tx, {
            type: "call.ended",
            teamId,
            conversationId: conversation.id,
            callId: callRow.id,
            direction: rowDirection,
            endedAt: evt.timestamp.toISOString(),
            // The authoritative talk-time computed above (provider duration, or
            // endedAt − real pickup). Drives the "Call · 1:23" timeline pill.
            durationSeconds: terminalDurationSeconds,
            reason: "hangup_by_customer",
          });
          // A connected call resets the consecutive-unanswered counter (the
          // mirror of Meta's auto-revocation after 4 unanswered outbound calls).
          if (rowDirection === CallDirection.out) {
            await tx.contact.update({
              where: { id: contact.id },
              data: { consecutiveUnansweredOutCalls: 0 },
            });
          }
        } else if (effectiveStatus === CallStatus.missed) {
          await publishInTx(tx, {
            type: "call.missed",
            teamId,
            conversationId: conversation.id,
            callId: callRow.id,
            ringingAt: evt.timestamp.toISOString(),
          });
          // Unanswered outbound — increment Meta's auto-revocation mirror. This
          // now actually fires: Meta reports unanswered business-initiated calls
          // as terminate/COMPLETED-without-duration, which we map to `missed`.
          if (rowDirection === CallDirection.out) {
            await tx.contact.update({
              where: { id: contact.id },
              data: { consecutiveUnansweredOutCalls: { increment: 1 } },
            });
          }
        } else if (effectiveStatus === CallStatus.rejected) {
          await publishInTx(tx, {
            type: "call.rejected",
            teamId,
            conversationId: conversation.id,
            callId: callRow.id,
            rejectedByUserId: null,
            endedAt: evt.timestamp.toISOString(),
          });
        } else if (effectiveStatus === CallStatus.failed) {
          await publishInTx(tx, {
            type: "call.failed",
            teamId,
            conversationId: conversation.id,
            callId: callRow.id,
            reason: "provider_error",
            endedAt: evt.timestamp.toISOString(),
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
      // `!alreadyTerminal` matches every other side effect in this transaction
      // (the reopen, the lastMessageAt bump, and all four terminal publishes).
      // This publish was the only ungated one, and Meta redelivers — so a
      // `connect` webhook arriving AFTER the call ended still emitted an SDP
      // frame for a dead call. The browser's handler can't match it to a live
      // call, so it stashes the SDP under that call id in `pendingAnswersRef`,
      // and the only two things that ever clear that map (teardown of a live
      // call, or `onEnded` for that id) have both already run. Result: a few KB
      // stranded per redelivery, for the life of a tab that stays open all day.
      // Gating here also removes any chance of a stale offer being applied to a
      // still-live peer connection.
      if (evt.sdp && !alreadyTerminal) {
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
  channel: Channel,
  evt: NormalizedCallEvent,
): Promise<void> {
  // Channel-aware caller lookup (see the main-path note above). Guard against a
  // missing identity so an undefined `phoneNumber`/`externalContactId` filter
  // can't match an arbitrary contact.
  const isPhone = isPhoneChannel(channel);
  const identityLabel = isPhone
    ? evt.contactPhone ?? evt.bsuid
    : evt.externalContactId;
  if (!identityLabel) return;
  // Phone channels may identify the caller by phone OR BSUID — match either, or
  // a permission grant from a cold (BSUID-only) caller silently lands nowhere.
  const identityWhere = isPhone
    ? {
        teamId,
        OR: [
          ...(evt.contactPhone ? [{ identityChannel: channel, phoneNumber: evt.contactPhone }] : []),
          ...(evt.bsuid ? [{ identityChannel: channel, bsuid: evt.bsuid }] : []),
        ],
      }
    : { teamId, identityChannel: channel, externalContactId: evt.externalContactId };
  const contact = await db.contact.findFirst({
    where: identityWhere,
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
    // Flip the matching outstanding request to `granted`. Without this the
    // CallPermissionRequest row stayed `pending` forever and the placeCall
    // pre-flight (which now gates on `granted`) would never let a call out
    // even after the customer accepted. We can't correlate the webhook to a
    // specific request id (the normalized event carries only the contact), so
    // we grant the newest still-pending, non-rate-limited request — there's at
    // most one live one per contact (Meta caps requests at 1/24h). The 72h
    // calling-validity window runs from the REAL grant time, so we re-stamp
    // expiresAt from now rather than the request-time +72h.
    const grantedAt = evt.timestamp;
    // A PERMANENT grant (customer chose "always allow") never expires — store a
    // far-future expiry so the out-of-window placeCall gate keeps authorizing.
    // Otherwise the standard 72h calling-validity window from the real grant.
    const grantExpiresAt = evt.permanentPermission
      ? new Date(grantedAt.getTime() + 100 * 365 * 24 * 60 * 60 * 1000)
      : new Date(grantedAt.getTime() + 72 * 60 * 60 * 1000);
    const pending = await db.callPermissionRequest.findFirst({
      where: {
        teamId,
        contactId: contact.id,
        status: CallPermissionStatus.pending,
        rateLimitedUntil: null,
      },
      orderBy: { requestedAt: "desc" },
      select: { id: true },
    });
    if (pending) {
      await db.callPermissionRequest.update({
        where: { id: pending.id },
        data: {
          status: CallPermissionStatus.granted,
          grantedAt,
          expiresAt: grantExpiresAt,
        },
      });
    } else {
      // Customer granted without a request row on file (e.g. they accepted a
      // request that predated this tracking, or the row was pruned). Record a
      // synthetic granted row so the pre-flight has a live grant to read.
      //
      // Idempotency (F16): Meta delivers permission_granted at-least-once. A
      // redelivery finds no `pending` row (the first delivery flipped/created a
      // `granted` one), so it would fall here and CREATE a second synthetic
      // granted row — duplicating the row AND extending the 72h window from the
      // redelivery time. Short-circuit if a live (granted + unexpired) request
      // already exists so the redelivery is a true no-op for the request rows.
      const existingGrant = await db.callPermissionRequest.findFirst({
        where: {
          teamId,
          contactId: contact.id,
          status: CallPermissionStatus.granted,
          expiresAt: { gt: grantedAt },
        },
        select: { id: true },
      });
      if (!existingGrant) {
        await db.callPermissionRequest.create({
          data: {
            teamId,
            contactId: contact.id,
            status: CallPermissionStatus.granted,
            grantedAt,
            expiresAt: grantExpiresAt,
          },
        });
      }
    }
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
    // Mark any live grant/pending request as `denied` so a stale `granted`
    // row can't keep authorizing calls after Meta revoked permission. The
    // Contact.callPermissionRevokedUntil gate already blocks the call, but
    // keeping the request rows consistent prevents the pre-flight from
    // disagreeing with itself if that column is ever cleared independently.
    await db.callPermissionRequest.updateMany({
      where: {
        teamId,
        contactId: contact.id,
        status: {
          in: [CallPermissionStatus.pending, CallPermissionStatus.granted],
        },
      },
      data: { status: CallPermissionStatus.denied },
    });
  }
}

