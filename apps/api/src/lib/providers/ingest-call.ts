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
import {
  downloadCallRecording,
  downloadCallTranscript,
} from "@/lib/media/call-recording-download";
import { resolveCustomerId } from "@/lib/identity/identity-service";
import { recordConversationEvent } from "@/lib/inbox/events";
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
      // to the browser regardless of status (see the sdp block below).
      return CallStatus.ringing;
    case "answered":
      // The customer genuinely picked up an outbound call — the provider's own
      // authoritative signal, carrying the pickup time as `connectedAt`. This
      // is what makes a later hangup resolve to `completed` rather than
      // `missed`, and keeps connected-call accounting honest.
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
    case "recording_available":
    case "transcript_available":
      // Handled separately — no lifecycle-status write.
      return null;
  }
}

export async function ingestCallEvent(
  workspaceId: string,
  channel: Channel,
  evt: NormalizedCallEvent,
  /**
   * The account (ChannelConnection) this call arrived on — the same one
   * `ingestEvents` resolved for the batch.
   *
   * Load-bearing, not decorative. A customer who CALLS before they ever
   * message creates the thread here, and every later call action
   * (answer / reject / end / permission) resolves its credentials from
   * `Conversation.channelConnectionId`. Leaving it null meant those threads
   * fell back to the workspace default account — and since the
   * account-unresolved guard, a multi-number workspace could not answer the
   * call at all. The message path has always stamped and re-stamped this; call
   * ingest was simply never handed the value.
   */
  channelConnectionId?: string | null,
): Promise<void> {
  // Permission events take a side-path: they mutate Contact, not Call.
  if (evt.phase === "permission_granted" || evt.phase === "permission_revoked") {
    await handlePermissionEvent(workspaceId, channel, evt);
    return;
  }

  // Recording/transcript artifacts take a side-path too: they reference an
  // EXISTING call by id and stamp its artifact columns — no lifecycle
  // transition, no Contact/Conversation work.
  if (evt.phase === "recording_available") {
    await handleRecordingAvailable(workspaceId, channel, evt);
    return;
  }
  if (evt.phase === "transcript_available") {
    await handleTranscriptAvailable(workspaceId, channel, evt);
    return;
  }

  // Channel-aware caller identity — mirrors the message-ingest resolution
  // (providers/ingest.ts): phone channels (WhatsApp) resolve/create by
  // `phoneNumber`; external-id channels (Messenger PSID / Instagram IGSID) by
  // the compound `(workspaceId, identityChannel, externalContactId)`. Exactly one
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
        workspaceId_channel_externalCallId: { workspaceId, channel, externalCallId: evt.externalCallId },
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
    const defaultStageId = await ensureDefaultStage(workspaceId);
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
          // phone onto a social contact (the (workspaceId, phoneNumber) partial
          // unique is whatsapp-only), so an unscoped lookup could attach an
          // inbound WhatsApp call to a messenger/instagram contact sharing the
          // number. Cross-channel identity is a Customer concern, not a fold.
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
            workspaceId,
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
              workspaceId,
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
        where: { workspaceId, contactId: contact.id },
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
            workspaceId,
            contactId: contact.id,
            channel,
            ...(channelConnectionId ? { channelConnectionId } : {}),
            status: "pending",
            lastMessageAt: evt.timestamp,
            lastMessagePreview: "",
          },
        });
      } else if (channelConnectionId && conversation.channelConnectionId !== channelConnectionId) {
        // RE-STAMP, same rule as the message path: the customer reached a
        // DIFFERENT one of our numbers, so the live thread now belongs to it
        // and the reply (or the call-back) must go out from there. Guarded so
        // the common case writes nothing.
        conversation = await tx.conversation.update({
          where: { id: conversation.id },
          data: { channelConnectionId },
        });
        if (conversation.status === "closed" && evt.direction === "in") reopen = true;
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
          workspaceId,
          contact: toContactWire(resolved.contact),
          source: "inbound",
          createdByUserId: null,
        });
      } catch (err) {
        console.error(
          `[ingest-call] publish(contact.created) failed for team=${workspaceId} contact=${resolved.contact.id}:`,
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
          workspaceId_channel_externalCallId: {
            workspaceId,
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
          // Needed to attribute the customer-answered frame on an outbound
          // call: the agent who placed it is the one on the line.
          initiatedByUserId: true,
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
      // Authoritative "THIS webhook performed the non-terminal→terminal
      // transition" — set by the terminal-write CAS below (or by a terminal-
      // on-first-insert, where creation IS the transition). `!alreadyTerminal`
      // alone is a STALE read under a concurrent duplicate: two parallel
      // deliveries both read `ringing`, both saw alreadyTerminal=false, and
      // both published call.missed + double-incremented the (non-idempotent)
      // consecutiveUnansweredOutCalls counter. The CAS makes exactly one
      // winner.
      let terminalTransitionWon = false;

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
            workspaceId,
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
          // A row that already reached `in_progress` must not be pushed back to
          // `ringing` by a redelivered `connecting` webhook — the stale-calls
          // sweeper would then terminalize a LIVE call as missed and tear down
          // the agent's panel. So the only non-terminal write allowed is onto a
          // still-`ringing` row, which also covers the ringing→in_progress
          // advance from `answered`.
          if (isTerminalPhase) {
            // CAS on the status still being non-terminal: of two concurrent
            // duplicate terminal deliveries, exactly one matches — the loser
            // writes nothing (same observable behavior as the alreadyTerminal
            // branch) and fires no side effects below.
            const won = await tx.call.updateMany({
              where: { id: existing.id, status: { notIn: [...TERMINAL_STATUSES] } },
              data: {
                status: effectiveStatus,
                // answeredAt is set-once, stamped from the provider's REAL
                // pickup time (evt.connectedAt). Never from the media-setup
                // connect.
                ...(!existing.answeredAt && evt.connectedAt
                  ? { answeredAt: evt.connectedAt }
                  : {}),
                endedAt: evt.timestamp,
                durationSeconds: terminalDurationSeconds,
                // Origin attribution (call button / deep link). The terminate
                // webhook echoes the same values the connect carried, so a
                // re-stamp is idempotent; stamping here also covers the
                // terminal-on-first-webhook case where connect never arrived.
                ...(evt.ctaPayload ? { ctaPayload: evt.ctaPayload } : {}),
                ...(evt.deeplinkPayload
                  ? { deeplinkPayload: evt.deeplinkPayload }
                  : {}),
                // WHY a failed call failed (terminate errors[]; 138019-138023).
                ...(evt.phase === "failed" && evt.errorCode !== undefined
                  ? { errorCode: evt.errorCode }
                  : {}),
                ...(evt.phase === "failed" && evt.errorTitle
                  ? { errorTitle: evt.errorTitle }
                  : {}),
                rawPayload: evt.rawPayload as Prisma.InputJsonValue,
              },
            });
            terminalTransitionWon = won.count > 0;
            callRow = {
              id: existing.id,
              status: terminalTransitionWon ? effectiveStatus : existing.status,
            };
          } else {
            // The sole non-terminal write allowed is onto a still-`ringing`
            // row (see the downgrade rationale above).
            const canWriteStatus = existing.status === CallStatus.ringing;
            callRow = await tx.call.update({
              where: { id: existing.id },
              data: {
                ...(canWriteStatus ? { status: effectiveStatus } : {}),
                ...(!existing.answeredAt && evt.connectedAt
                  ? { answeredAt: evt.connectedAt }
                  : {}),
                ...(evt.ctaPayload ? { ctaPayload: evt.ctaPayload } : {}),
                ...(evt.deeplinkPayload
                  ? { deeplinkPayload: evt.deeplinkPayload }
                  : {}),
                rawPayload: evt.rawPayload as Prisma.InputJsonValue,
              },
              select: { id: true, status: true },
            });
          }
        }
      } else {
        // INSERT path — first webhook for this call id.
        const direction: CallDirection =
          evt.direction === "in" ? CallDirection.in : CallDirection.out;
        callRow = await tx.call.create({
          data: {
            workspaceId,
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
            ...(evt.ctaPayload ? { ctaPayload: evt.ctaPayload } : {}),
            ...(evt.deeplinkPayload
              ? { deeplinkPayload: evt.deeplinkPayload }
              : {}),
            ...(evt.phase === "failed" && evt.errorCode !== undefined
              ? { errorCode: evt.errorCode }
              : {}),
            ...(evt.phase === "failed" && evt.errorTitle
              ? { errorTitle: evt.errorTitle }
              : {}),
            rawPayload: evt.rawPayload as Prisma.InputJsonValue,
          },
          select: { id: true, status: true },
        });
        isFirstInsert = true;
        // Terminal-on-first-webhook: creation IS the non-terminal→terminal
        // transition (a concurrent duplicate insert P2002-rolls-back wholesale,
        // publishes included, so the winner is still exactly one).
        terminalTransitionWon = isTerminalPhase;
      }

      // Customer-service window. The calling-PRICING doc settled both rules
      // the earlier service-messages wording left open:
      //   - a user-initiated call opens/refreshes the window "regardless of
      //     if you accept the call or not" — so ANY inbound call bumps, at
      //     its arrival instant (a missed/declined call still opened it);
      //   - "when a WhatsApp user accepts your call" — a CONNECTED outbound
      //     call bumps too, at the pickup instant (the ACCEPTED status
      //     webhook carries it as `connectedAt`).
      // Monotonic (only ever advances), so redelivered / out-of-order
      // webhooks are no-ops, and an inbound call's answeredAt superseding its
      // own ring-time bump is harmless. The contact-drift sweeper recomputes
      // the same value (GREATEST over inbound messages + inbound calls'
      // ringingAt + connected calls' answeredAt), so these bumps survive
      // reconciliation. answerCall (calls.service.ts) remains the primary
      // bump for a normally-answered inbound call; this covers every
      // webhook-driven path.
      const rowDirection =
        existing?.direction ??
        (evt.direction === "in" ? CallDirection.in : CallDirection.out);
      const windowAnchor =
        rowDirection === CallDirection.in
          ? answeredAt ??
            // The arrival itself opens the window. `incoming` is the ring
            // webhook; a terminal-on-first-webhook insert (we never saw the
            // ring) anchors at its own timestamp — within the ring duration
            // of the true instant, and monotonicity absorbs the slack.
            (evt.phase === "incoming" || isFirstInsert ? evt.timestamp : null)
          : answeredAt;
      if (windowAnchor) {
        await tx.contact.updateMany({
          where: {
            id: contact.id,
            OR: [{ lastInboundAt: null }, { lastInboundAt: { lt: windowAnchor } }],
          },
          data: { lastInboundAt: windowAnchor },
        });
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
          workspaceId,
          conversationId: conversation.id,
          callId: callRow.id,
          externalCallId: evt.externalCallId,
          channel,
          // WHICH of our numbers/Pages the customer dialled. Prefer the
          // account this batch was attributed to; fall back to the thread's
          // own pointer (they agree, since ingest re-stamps the conversation
          // to the receiving account just above). Without it the toast can
          // only say "on WhatsApp", and an agent running two lines answers
          // with the wrong business identity half the time.
          channelConnectionId: channelConnectionId ?? conversation.channelConnectionId ?? null,
          contact: toWorkflowContact(contact),
          ringingAt: evt.timestamp.toISOString(),
        });
      }
      if (isFirstInsert && evt.direction === "out") {
        await publishInTx(tx, {
          type: "call.ringing_out",
          workspaceId,
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
      // The customer picked up an outbound call. Publishing the same
      // answered frame the inbound path uses flips every viewer's thread pill
      // to in-progress and starts the live timer at the REAL pickup moment.
      //
      // Gated on a genuine ringing→in_progress transition so an at-least-once
      // redelivery of the ACCEPTED status is a no-op. Attribution is the agent
      // who placed the call — they're the one on the line; the webhook itself
      // carries no user context.
      if (
        evt.phase === "answered" &&
        existing &&
        existing.status === CallStatus.ringing
      ) {
        await publishInTx(tx, {
          type: "call.answered_by_agent",
          workspaceId,
          conversationId: conversation.id,
          callId: callRow.id,
          answeredByUserId: existing.initiatedByUserId ?? "",
          answeredAt: (evt.connectedAt ?? evt.timestamp).toISOString(),
        });
      }

      // Terminal phase-events + the unanswered-counter mutation fire ONLY on a
      // genuine non-terminal→terminal transition, keyed on the terminal-write
      // CAS (`terminalTransitionWon`) — not on the stale `alreadyTerminal`
      // read, which two CONCURRENT duplicate deliveries could both see false
      // (both then published call.* and double-incremented the non-idempotent
      // counter). A sequential duplicate is still a no-op (CAS matches zero);
      // a terminal-on-first-insert still fires exactly once (P2002 rolls a
      // losing duplicate back wholesale).
      // Key the terminal events off the CORRECTED status (effectiveStatus), not
      // the raw parser phase — an outbound no-answer resolves to `missed` (so
      // the counter fires) and an answered call to `completed` (carrying the
      // provider's authoritative duration).
      if (terminalTransitionWon) {
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
            workspaceId,
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
            workspaceId,
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
            workspaceId,
            conversationId: conversation.id,
            callId: callRow.id,
            rejectedByUserId: null,
            endedAt: evt.timestamp.toISOString(),
          });
        } else if (effectiveStatus === CallStatus.failed) {
          await publishInTx(tx, {
            type: "call.failed",
            workspaceId,
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
          workspaceId,
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
/**
 * `recording_available`: stamp the media id on the call row, then fetch the
 * bytes to R2 in the background. The webhook must 200 fast (Meta redelivers on
 * anything else), so only the row stamp is synchronous — the download is
 * detached, with the call-recordings sweeper as the retry backstop. The
 * provider deletes the file 7 days after this webhook.
 */
async function handleRecordingAvailable(
  workspaceId: string,
  channel: Channel,
  evt: NormalizedCallEvent,
): Promise<void> {
  const media = evt.recordingMedia;
  if (!media?.mediaId) {
    console.warn(
      `[ingest-call] recording_available without a media id for call=${evt.externalCallId} — dropping`,
    );
    return;
  }
  const call = await db.call.findUnique({
    where: {
      workspaceId_channel_externalCallId: {
        workspaceId,
        channel,
        externalCallId: evt.externalCallId,
      },
    },
    select: { id: true, recordingKey: true },
  });
  if (!call) {
    // Recording always postdates the call's own webhooks, so a missing row
    // means the call was never ingested — nothing to attach to. Fail-soft.
    console.warn(
      `[ingest-call] recording_available for unknown call=${evt.externalCallId} team=${workspaceId} — dropping`,
    );
    return;
  }
  if (call.recordingKey) return; // redelivery after a completed download — no-op

  await db.call.update({
    where: { id: call.id },
    data: {
      recordingMediaId: media.mediaId,
      ...(media.mimeType ? { recordingMimeType: media.mimeType } : {}),
    },
  });
  // Detached — sweeper retries on transient failure.
  void downloadCallRecording(call.id, media.sha256).catch((err) => {
    console.warn(
      `[ingest-call] inline recording download failed for call=${call.id}: ${
        err instanceof Error ? err.message : err
      } — sweeper will retry`,
    );
  });
}

/** `transcript_available`: same stamp-then-detached-download lifecycle as
 *  handleRecordingAvailable, for the JSON transcript document. */
async function handleTranscriptAvailable(
  workspaceId: string,
  channel: Channel,
  evt: NormalizedCallEvent,
): Promise<void> {
  const media = evt.transcriptMedia;
  if (!media?.mediaId) {
    console.warn(
      `[ingest-call] transcript_available without a media id for call=${evt.externalCallId} — dropping`,
    );
    return;
  }
  const call = await db.call.findUnique({
    where: {
      workspaceId_channel_externalCallId: {
        workspaceId,
        channel,
        externalCallId: evt.externalCallId,
      },
    },
    select: { id: true, transcriptKey: true },
  });
  if (!call) {
    console.warn(
      `[ingest-call] transcript_available for unknown call=${evt.externalCallId} team=${workspaceId} — dropping`,
    );
    return;
  }
  if (call.transcriptKey) return; // redelivery after a completed download

  await db.call.update({
    where: { id: call.id },
    data: { transcriptMediaId: media.mediaId },
  });
  void downloadCallTranscript(call.id, media.sha256).catch((err) => {
    console.warn(
      `[ingest-call] inline transcript download failed for call=${call.id}: ${
        err instanceof Error ? err.message : err
      } — sweeper will retry`,
    );
  });
}

async function handlePermissionEvent(
  workspaceId: string,
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
        workspaceId,
        OR: [
          ...(evt.contactPhone ? [{ identityChannel: channel, phoneNumber: evt.contactPhone }] : []),
          ...(evt.bsuid ? [{ identityChannel: channel, bsuid: evt.bsuid }] : []),
        ],
      }
    : { workspaceId, identityChannel: channel, externalContactId: evt.externalContactId };
  // Full row, not a narrow select: the callback-request branch below reopens
  // the thread (needs `toWorkflowContact`) and the pill snapshots the name.
  const contact = await db.contact.findFirst({ where: identityWhere });
  if (!contact) return;

  if (evt.phase === "permission_granted") {
    await db.contact.update({
      where: { id: contact.id },
      data: {
        callPermissionRevokedUntil: null,
        consecutiveUnansweredOutCalls: 0,
      },
    });
    // Flip the matching outstanding request to `granted`.
    //
    // Correlate by the request MESSAGE id the reply echoes back whenever it's
    // present — that identifies the exact request the customer answered.
    // Fall back to the newest still-pending row only when the reply carries no
    // context (a proactive grant from the business profile, or an automatic
    // callback grant), where there is nothing to correlate against.
    const grantedAt = evt.timestamp;
    const isPermanent = evt.permanentPermission === true;
    // The provider's OWN expiry, verbatim. Never computed here: no webhook is
    // sent when a temporary permission lapses, so a locally-guessed duration is
    // unverifiable and silently discards days of a valid grant. If the provider
    // somehow omits it on a temporary grant, fall back to the documented 7-day
    // window rather than inventing a shorter one.
    const grantExpiresAt = isPermanent
      ? // Unused while isPermanent is set (the gate short-circuits on the flag),
        // but the column is non-null, so keep it consistent rather than absurd.
        new Date(grantedAt.getTime() + 7 * 24 * 60 * 60 * 1000)
      : evt.permissionExpiresAt ??
        new Date(grantedAt.getTime() + 7 * 24 * 60 * 60 * 1000);
    // Tracks whether THIS delivery actually changed grant state. The pill +
    // realtime fanout below gate on it, so an at-least-once redelivery (which
    // finds everything already applied) stays silent — same posture as the
    // synthetic-row idempotency guard.
    let grantTransitioned = false;
    const pending = await db.callPermissionRequest.findFirst({
      where: {
        workspaceId,
        contactId: contact.id,
        ...(evt.permissionRequestExternalId
          ? { externalRequestId: evt.permissionRequestExternalId }
          : {
              status: CallPermissionStatus.pending,
              rateLimitedUntil: null,
            }),
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
          isPermanent,
        },
      });
      grantTransitioned = true;
    } else {
      // Customer granted without a request row on file (e.g. they accepted a
      // request that predated this tracking, or the row was pruned). Record a
      // synthetic granted row so the pre-flight has a live grant to read.
      //
      // Idempotency: the provider delivers this at-least-once. A redelivery
      // finds no `pending` row (the first delivery flipped/created a `granted`
      // one), so it would fall here and CREATE a second synthetic granted row —
      // duplicating the row AND extending the window from the redelivery time.
      // Short-circuit if a live grant already exists so the redelivery is a
      // true no-op. A permanent grant is always live.
      const existingGrant = await db.callPermissionRequest.findFirst({
        where: {
          workspaceId,
          contactId: contact.id,
          status: CallPermissionStatus.granted,
          OR: [{ isPermanent: true }, { expiresAt: { gt: grantedAt } }],
        },
        select: { id: true, isPermanent: true, expiresAt: true },
      });
      if (!existingGrant) {
        await db.callPermissionRequest.create({
          data: {
            workspaceId,
            contactId: contact.id,
            status: CallPermissionStatus.granted,
            grantedAt,
            expiresAt: grantExpiresAt,
            isPermanent,
          },
        });
        grantTransitioned = true;
      } else if (
        // A live grant already exists, but this reply may STRENGTHEN it: the
        // customer can upgrade a temporary permission to permanent, or re-grant
        // and push the expiry out, both from their business profile. Skipping
        // outright would leave us treating a now-permanent permission as
        // expiring, and re-asking a customer who already said "always".
        //
        // Only ever widen — never shorten. A redelivery of the SAME grant then
        // stays a true no-op, which is what the idempotency guard is for.
        (isPermanent && !existingGrant.isPermanent) ||
        (!existingGrant.isPermanent &&
          !isPermanent &&
          grantExpiresAt.getTime() > existingGrant.expiresAt.getTime())
      ) {
        await db.callPermissionRequest.update({
          where: { id: existingGrant.id },
          data: {
            grantedAt,
            isPermanent,
            // A permanent grant's expiry is never read; keep the column
            // coherent rather than absurd.
            expiresAt: grantExpiresAt,
          },
        });
        grantTransitioned = true;
      }
    }
    // Visibility (2026-07-28): the reply webhook is consumed whole into the
    // state above, so without this the customer's decision — most importantly
    // a "request a callback" tap outside call hours — leaves NO visible trace
    // anywhere. Gated on a real transition so redeliveries stay silent.
    if (grantTransitioned) {
      await recordCallPermissionActivity(workspaceId, channel, contact, evt, {
        isPermanent,
        expiresAt: grantExpiresAt,
      });
    }
  } else if (evt.phase === "permission_revoked") {
    // Two very different things arrive as a "reject", and conflating them
    // blocks calling to customers who never revoked anything:
    //
    //   user_action — the customer DECLINED a permission request. That is not
    //     a standing revocation: they can still grant permission afterwards,
    //     right up until the request expires. Only the request is dead.
    //   automatic  — the provider WITHDREW permission itself, after too many
    //     unanswered calls.
    //
    // Treating a single decline as a revocation is what made us refuse
    // customers we had just spoken to.
    const isAutomaticRevocation = evt.permissionAutomatic === true;

    if (isAutomaticRevocation) {
      // Record it so the contact panel can explain why calling stopped. This
      // is ADVISORY ONLY — the provider remains the gate, because the customer
      // can re-grant at any moment in ways that touch nothing on our side
      // (calling us with callback permission on, or their business profile),
      // and a local lock would outlive the reality it describes.
      await db.contact.update({
        where: { id: contact.id },
        data: {
          callPermissionRevokedUntil: new Date(
            evt.timestamp.getTime() + 7 * 24 * 60 * 60 * 1000,
          ),
          // The counter has done its job; reset it so the "2 unanswered"
          // warning doesn't sit alongside the revocation notice.
          consecutiveUnansweredOutCalls: 0,
        },
      });
    }

    // Retire request rows either way — a declined request and a withdrawn
    // permission are both dead as authorizations. Correlate to the exact
    // request when the reply told us which one it answers; otherwise retire
    // whatever is outstanding.
    const retired = await db.callPermissionRequest.updateMany({
      where: {
        workspaceId,
        contactId: contact.id,
        ...(evt.permissionRequestExternalId
          ? { externalRequestId: evt.permissionRequestExternalId }
          : {
              status: {
                in: [CallPermissionStatus.pending, CallPermissionStatus.granted],
              },
            }),
      },
      data: { status: CallPermissionStatus.denied },
    });
    // A customer's explicit decline gets a pill (the request bubble they
    // answered is otherwise the thread's last word on it). An AUTOMATIC
    // withdrawal does not — that's provider bookkeeping, already explained by
    // the contact panel's revoked-until notice. Gated on actually retiring a
    // row so an at-least-once redelivery stays silent.
    if (!isAutomaticRevocation && retired.count > 0) {
      await recordCallPermissionActivity(workspaceId, channel, contact, evt, null);
    }
  }
}

/**
 * Surface a customer's call-permission decision as a conversation-timeline
 * pill + a `call.permission_changed` publish (→ `call:permission` frame: live
 * pill refresh for thread viewers, team-wide callback toast).
 *
 * Classification of a GRANT (`grant` non-null):
 *   - automatic + context names a call we ingested → NO pill. The customer
 *     called us; the CallBubble already tells that story.
 *   - automatic otherwise → `callback_requested`. This is the invisible case
 *     this function exists for: outside call hours WhatsApp offers "request a
 *     callback", and the tap arrives as nothing but this automatic grant.
 *   - user_action → `granted` (they tapped Allow on our permission request).
 * `grant === null` → `declined`.
 *
 * A callback request is customer-initiated outreach, so it also rises for
 * triage exactly like a missed call (see the main ingest path): reopen a
 * closed thread and bump `lastMessageAt` monotonically.
 *
 * Callers gate on a real state transition, so this never double-writes on
 * at-least-once redelivery.
 */
async function recordCallPermissionActivity(
  workspaceId: string,
  channel: Channel,
  contact: Contact,
  evt: NormalizedCallEvent,
  grant: { isPermanent: boolean; expiresAt: Date } | null,
): Promise<void> {
  let permission: "callback_requested" | "granted" | "declined";
  if (!grant) {
    permission = "declined";
  } else if (evt.permissionAutomatic === true) {
    const ctx = evt.permissionRequestExternalId;
    const matchingCall = ctx
      ? await db.call.findFirst({
          where: { workspaceId, channel, externalCallId: ctx },
          select: { id: true },
        })
      : null;
    if (matchingCall) return;
    permission = "callback_requested";
  } else {
    permission = "granted";
  }

  // No thread yet (they never messaged us) → nothing to attach the pill to;
  // the contact panel still shows the callable state.
  const conversation = await db.conversation.findUnique({
    where: { workspaceId_contactId: { workspaceId, contactId: contact.id } },
  });
  if (!conversation) return;

  if (permission === "callback_requested") {
    // CAS reopen, same shape as the call-ingest path: idempotent across
    // retries, and the status_changed publish only fires when THIS delivery
    // actually flipped the row.
    const flip = await db.conversation.updateMany({
      where: { id: conversation.id, status: "closed" },
      data: { status: "pending" },
    });
    if (flip.count > 0) {
      await publish({
        type: "conversation.status_changed",
        workspaceId,
        conversationId: conversation.id,
        previousStatus: "closed",
        newStatus: "pending",
        changedByUserId: null,
        contact: toWorkflowContact(contact),
        conversation: workflowConversationSnapshotAfterStatusChange(
          { ...conversation, status: "pending" },
          { previousStatus: "closed", changedByUserId: null },
        ),
      });
    }
    // Monotonic bump so the thread rises in the inbox list for triage — the
    // `lt` guard stops an out-of-order webhook moving it backward past a
    // newer message or call.
    await db.conversation.updateMany({
      where: { id: conversation.id, lastMessageAt: { lt: evt.timestamp } },
      data: { lastMessageAt: evt.timestamp },
    });
  }

  const kind =
    permission === "callback_requested"
      ? ("callback_requested" as const)
      : permission === "granted"
        ? ("call_permission_granted" as const)
        : ("call_permission_declined" as const);
  // Pill BEFORE the publish so the frame-triggered activity GET finds the row
  // (the trailing coalesced fetch backstops a race regardless).
  await recordConversationEvent({
    conversationId: conversation.id,
    workspaceId,
    userId: null,
    kind,
    after: {
      contactId: contact.id,
      contactName: contact.name ?? null,
      ...(grant
        ? { isPermanent: grant.isPermanent, expiresAt: grant.expiresAt.toISOString() }
        : {}),
    },
    at: evt.timestamp,
  });
  await publish({
    type: "call.permission_changed",
    workspaceId,
    conversationId: conversation.id,
    contactId: contact.id,
    contactName: contact.name ?? null,
    permission,
    occurredAt: evt.timestamp.toISOString(),
  });
}

