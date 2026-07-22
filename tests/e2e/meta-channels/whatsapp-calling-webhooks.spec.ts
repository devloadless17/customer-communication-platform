/**
 * WhatsApp Calling webhook ingest — end to end through the REAL pipeline:
 * HMAC verify → metaProvider.parseWebhook → ingestCallEvent → Prisma.
 *
 * This suite exists because of a production incident. The calling refactor
 * moved pickup detection from a browser heuristic onto WhatsApp's authoritative
 * `ACCEPTED` call status, and moved permission grants onto the
 * `call_permission_reply` message — and NOTHING covered either path. Both
 * shipped broken and were found by a human placing a real call.
 *
 * The through-line of every case here: WhatsApp overloads its webhook shapes,
 * and each overload is a place we have already been wrong.
 *
 *   - `value.statuses[]` carries BOTH message delivery AND call progress,
 *     discriminated only by `type: "call"`. Routing it wholesale to the message
 *     handler silently dropped every call status.
 *   - permission decisions arrive as interactive MESSAGES, not call events.
 *   - a `reject` reply means two different things depending on
 *     `response_source`, and conflating them blocked calling to customers who
 *     had never revoked anything.
 */

import { test, expect } from "@playwright/test";

import { db } from "../_helpers/db";
import {
  seedMetaTestTeam,
  wipeMetaTestTeam,
  postMetaWebhook,
  META_TEST_TEAM_ID,
  WA_PHONE_NUMBER_ID,
} from "../_helpers/meta";

test.describe.configure({ mode: "serial" });

const CUSTOMER_PHONE = "15550001111";
const BUSINESS_PHONE = "15559998888";

test.beforeAll(async () => {
  await seedMetaTestTeam();
});
test.afterAll(async () => {
  await wipeMetaTestTeam();
});

/** The `field: "calls"` envelope, which carries `calls[]` and/or `statuses[]`. */
function callsWebhook(value: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-e2e",
        changes: [
          {
            field: "calls",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: BUSINESS_PHONE,
                phone_number_id: WA_PHONE_NUMBER_ID,
              },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

/** The `field: "messages"` envelope — where permission replies actually live. */
function messagesWebhook(message: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-e2e",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: BUSINESS_PHONE,
                phone_number_id: WA_PHONE_NUMBER_ID,
              },
              contacts: [{ profile: { name: "Calling E2E" }, wa_id: CUSTOMER_PHONE }],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

/** Seed an outbound call already ringing, as placeCall would have left it. */
async function seedRingingOutboundCall(externalCallId: string) {
  // The WhatsApp phone uniqueness is a PARTIAL index, not a compound key, so
  // this is find-or-create rather than an upsert. Every spec reuses the one
  // contact — the calling state under test lives on the Call/permission rows.
  const contact =
    (await db().contact.findFirst({
      where: {
        workspaceId: META_TEST_TEAM_ID,
        identityChannel: "whatsapp",
        phoneNumber: CUSTOMER_PHONE,
      },
      select: { id: true },
    })) ??
    (await db().contact.create({
      data: {
        workspaceId: META_TEST_TEAM_ID,
        phoneNumber: CUSTOMER_PHONE,
        identityChannel: "whatsapp",
        name: "Calling E2E",
        source: "manual",
      },
      select: { id: true },
    }));
  const conversation =
    (await db().conversation.findFirst({
      where: { workspaceId: META_TEST_TEAM_ID, contactId: contact.id },
      select: { id: true },
    })) ??
    (await db().conversation.create({
      data: {
        workspaceId: META_TEST_TEAM_ID,
        contactId: contact.id,
        channel: "whatsapp",
        status: "open",
        lastMessageAt: new Date(),
        lastMessagePreview: "",
      },
      select: { id: true },
    }));
  const call = await db().call.create({
    data: {
      workspaceId: META_TEST_TEAM_ID,
      conversationId: conversation.id,
      externalCallId,
      channel: "whatsapp",
      direction: "out",
      status: "ringing",
      ringingAt: new Date(),
      rawPayload: {},
    },
    select: { id: true },
  });
  return { contactId: contact.id, conversationId: conversation.id, callId: call.id };
}

// ═════════════════════════════════════════════════════════════════════════
// Call progress — `statuses[]` with `type: "call"`
// ═════════════════════════════════════════════════════════════════════════

test("ACCEPTED status connects the call — the pickup signal that had no owner", async () => {
  const externalCallId = `wacid.accept.${Date.now()}`;
  const { callId } = await seedRingingOutboundCall(externalCallId);
  const acceptedAt = Math.floor(Date.now() / 1000);

  const res = await postMetaWebhook(
    META_TEST_TEAM_ID,
    callsWebhook({
      statuses: [
        {
          id: externalCallId,
          type: "call",
          status: "ACCEPTED",
          timestamp: String(acceptedAt),
          recipient_id: CUSTOMER_PHONE,
        },
      ],
    }),
  );
  expect(res.status).toBe(200);

  const row = await db().call.findUnique({
    where: { id: callId },
    select: { status: true, answeredAt: true },
  });
  expect(row?.status).toBe("in_progress");
  // answeredAt must come from WhatsApp's own timestamp — the timer the agent
  // watches is rendered from it, so an arrival-time stamp would drift.
  expect(row?.answeredAt).not.toBeNull();
  expect(Math.abs((row!.answeredAt!.getTime() - acceptedAt * 1000) / 1000)).toBeLessThan(2);
});

test("a REJECTED status ends the call — the customer declined", async () => {
  const externalCallId = `wacid.reject.${Date.now()}`;
  const { callId } = await seedRingingOutboundCall(externalCallId);

  await postMetaWebhook(
    META_TEST_TEAM_ID,
    callsWebhook({
      statuses: [
        {
          id: externalCallId,
          type: "call",
          status: "REJECTED",
          timestamp: String(Math.floor(Date.now() / 1000)),
          recipient_id: CUSTOMER_PHONE,
        },
      ],
    }),
  );

  const row = await db().call.findUnique({
    where: { id: callId },
    select: { status: true, answeredAt: true },
  });
  expect(row?.status).toBe("rejected");
  // Never picked up, so it must not read as a connected call anywhere.
  expect(row?.answeredAt).toBeNull();
});

test("a RINGING status does not downgrade a call that already connected", async () => {
  const externalCallId = `wacid.ring.${Date.now()}`;
  const { callId } = await seedRingingOutboundCall(externalCallId);

  const accepted = {
    id: externalCallId,
    type: "call",
    status: "ACCEPTED",
    timestamp: String(Math.floor(Date.now() / 1000)),
    recipient_id: CUSTOMER_PHONE,
  };
  await postMetaWebhook(META_TEST_TEAM_ID, callsWebhook({ statuses: [accepted] }));
  // WhatsApp is at-least-once with no ordering guarantee, so a RINGING can
  // legitimately land after an ACCEPTED. Pushing the row back to `ringing`
  // would hand a LIVE call to the stale-call sweeper to terminalize as missed.
  await postMetaWebhook(
    META_TEST_TEAM_ID,
    callsWebhook({ statuses: [{ ...accepted, status: "RINGING" }] }),
  );

  const row = await db().call.findUnique({
    where: { id: callId },
    select: { status: true },
  });
  expect(row?.status).toBe("in_progress");
});

test("a call status is not mistaken for a message delivery status", async () => {
  const externalCallId = `wacid.notmsg.${Date.now()}`;
  await seedRingingOutboundCall(externalCallId);
  const before = await db().message.count({ where: { workspaceId: META_TEST_TEAM_ID } });

  await postMetaWebhook(
    META_TEST_TEAM_ID,
    callsWebhook({
      statuses: [
        {
          id: externalCallId,
          type: "call",
          status: "ACCEPTED",
          timestamp: String(Math.floor(Date.now() / 1000)),
          recipient_id: CUSTOMER_PHONE,
        },
      ],
    }),
  );

  // The two arrays share a name; only `type` tells them apart. A call id must
  // never be written as a message status.
  expect(await db().message.count({ where: { workspaceId: META_TEST_TEAM_ID } })).toBe(before);
});

// ═════════════════════════════════════════════════════════════════════════
// Permission — `call_permission_reply` interactive MESSAGES
// ═════════════════════════════════════════════════════════════════════════

test("an accepted permission reply is recorded with WhatsApp's own expiry", async () => {
  const requestWamid = `wamid.req.${Date.now()}`;
  const { contactId } = await seedRingingOutboundCall(`wacid.perm.${Date.now()}`);
  // The request we sent, which the reply will reference by context.
  await db().callPermissionRequest.create({
    data: {
      workspaceId: META_TEST_TEAM_ID,
      contactId,
      externalRequestId: requestWamid,
      status: "pending",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  const expiresAt = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;

  await postMetaWebhook(
    META_TEST_TEAM_ID,
    messagesWebhook({
      from: CUSTOMER_PHONE,
      id: `wamid.reply.${Date.now()}`,
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: "interactive",
      context: { from: CUSTOMER_PHONE, id: requestWamid },
      interactive: {
        type: "call_permission_reply",
        call_permission_reply: {
          response: "accept",
          is_permanent: false,
          expiration_timestamp: String(expiresAt),
          response_source: "user_action",
        },
      },
    }),
  );

  const row = await db().callPermissionRequest.findFirst({
    where: { workspaceId: META_TEST_TEAM_ID, externalRequestId: requestWamid },
    select: { status: true, grantedAt: true, expiresAt: true, isPermanent: true },
  });
  expect(row?.status).toBe("granted");
  expect(row?.grantedAt).not.toBeNull();
  expect(row?.isPermanent).toBe(false);
  // Taken verbatim, never recomputed: WhatsApp sends NO webhook when a
  // temporary permission lapses, so a locally-guessed duration silently throws
  // away days of a live grant (this was 72h against a real 7 days).
  expect(Math.abs((row!.expiresAt.getTime() - expiresAt * 1000) / 1000)).toBeLessThan(2);
});

test("a permission reply is NOT persisted as a chat message", async () => {
  const before = await db().message.count({ where: { workspaceId: META_TEST_TEAM_ID } });

  await postMetaWebhook(
    META_TEST_TEAM_ID,
    messagesWebhook({
      from: CUSTOMER_PHONE,
      id: `wamid.reply.nomsg.${Date.now()}`,
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: "interactive",
      interactive: {
        type: "call_permission_reply",
        call_permission_reply: {
          response: "accept",
          is_permanent: true,
          response_source: "user_action",
        },
      },
    }),
  );

  // Before it was parsed, this fell through to the generic interactive branch
  // and rendered in the customer's thread as a meaningless
  // "💬 Interactive reply" bubble.
  expect(await db().message.count({ where: { workspaceId: META_TEST_TEAM_ID } })).toBe(before);
});

test("a permanent grant is stored as permanent, not as a far-future date", async () => {
  const { contactId } = await seedRingingOutboundCall(`wacid.permanent.${Date.now()}`);

  await postMetaWebhook(
    META_TEST_TEAM_ID,
    messagesWebhook({
      from: CUSTOMER_PHONE,
      id: `wamid.perm.${Date.now()}`,
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: "interactive",
      interactive: {
        type: "call_permission_reply",
        call_permission_reply: {
          response: "accept",
          is_permanent: true,
          response_source: "user_action",
        },
      },
    }),
  );

  const row = await db().callPermissionRequest.findFirst({
    where: { workspaceId: META_TEST_TEAM_ID, contactId, status: "granted" },
    orderBy: { requestedAt: "desc" },
    select: { isPermanent: true },
  });
  // A flag, so the UI can say "always allowed" instead of counting down to the
  // next century.
  expect(row?.isPermanent).toBe(true);
});

test("DECLINING a request is not a revocation — this refused live customers", async () => {
  const { contactId } = await seedRingingOutboundCall(`wacid.decline.${Date.now()}`);
  await db().contact.update({
    where: { id: contactId },
    data: { callPermissionRevokedUntil: null },
  });

  await postMetaWebhook(
    META_TEST_TEAM_ID,
    messagesWebhook({
      from: CUSTOMER_PHONE,
      id: `wamid.decline.${Date.now()}`,
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: "interactive",
      interactive: {
        type: "call_permission_reply",
        call_permission_reply: {
          response: "reject",
          response_source: "user_action",
        },
      },
    }),
  );

  const contact = await db().contact.findUnique({
    where: { id: contactId },
    select: { callPermissionRevokedUntil: true },
  });
  // WhatsApp is explicit that a customer who declines can still grant
  // permission afterwards. Treating the decline as a standing revocation wrote
  // a year-long block and refused customers the agent had just spoken to.
  expect(contact?.callPermissionRevokedUntil).toBeNull();
});

test("an AUTOMATIC revocation is recorded — that one is real", async () => {
  const { contactId } = await seedRingingOutboundCall(`wacid.autorevoke.${Date.now()}`);
  await db().contact.update({
    where: { id: contactId },
    data: { callPermissionRevokedUntil: null, consecutiveUnansweredOutCalls: 4 },
  });

  await postMetaWebhook(
    META_TEST_TEAM_ID,
    messagesWebhook({
      from: CUSTOMER_PHONE,
      id: `wamid.autorevoke.${Date.now()}`,
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: "interactive",
      interactive: {
        type: "call_permission_reply",
        call_permission_reply: {
          response: "reject",
          response_source: "automatic",
        },
      },
    }),
  );

  const contact = await db().contact.findUnique({
    where: { id: contactId },
    select: { callPermissionRevokedUntil: true, consecutiveUnansweredOutCalls: true },
  });
  expect(contact?.callPermissionRevokedUntil).not.toBeNull();
  // The counter has done its job; leaving it high would stack an "almost out of
  // attempts" warning on top of the revocation notice.
  expect(contact?.consecutiveUnansweredOutCalls).toBe(0);
});

// ═════════════════════════════════════════════════════════════════════════
// Terminal calls
// ═════════════════════════════════════════════════════════════════════════

test("an unanswered call terminates as missed, despite status COMPLETED", async () => {
  const externalCallId = `wacid.noanswer.${Date.now()}`;
  const { callId } = await seedRingingOutboundCall(externalCallId);

  await postMetaWebhook(
    META_TEST_TEAM_ID,
    callsWebhook({
      calls: [
        {
          id: externalCallId,
          to: CUSTOMER_PHONE,
          from: BUSINESS_PHONE,
          event: "terminate",
          direction: "BUSINESS_INITIATED",
          status: "COMPLETED",
          timestamp: String(Math.floor(Date.now() / 1000)),
          // No start_time / duration — WhatsApp documents those as present
          // ONLY when the call was picked up. Their absence is the answered
          // discriminator; `status` alone cannot tell these apart.
        },
      ],
    }),
  );

  const row = await db().call.findUnique({
    where: { id: callId },
    select: { status: true, durationSeconds: true },
  });
  expect(row?.status).toBe("missed");
  expect(row?.durationSeconds).toBeNull();
});

test("an answered call terminates as completed with WhatsApp's own duration", async () => {
  const externalCallId = `wacid.answered.${Date.now()}`;
  const { callId } = await seedRingingOutboundCall(externalCallId);
  const startedAt = Math.floor(Date.now() / 1000) - 42;

  await postMetaWebhook(
    META_TEST_TEAM_ID,
    callsWebhook({
      calls: [
        {
          id: externalCallId,
          to: CUSTOMER_PHONE,
          from: BUSINESS_PHONE,
          event: "terminate",
          direction: "BUSINESS_INITIATED",
          status: "COMPLETED",
          timestamp: String(Math.floor(Date.now() / 1000)),
          start_time: String(startedAt),
          end_time: String(Math.floor(Date.now() / 1000)),
          duration: 42,
        },
      ],
    }),
  );

  const row = await db().call.findUnique({
    where: { id: callId },
    select: { status: true, durationSeconds: true, answeredAt: true },
  });
  expect(row?.status).toBe("completed");
  // Prefer the provider's own duration over endedAt−answeredAt so our record
  // matches theirs exactly.
  expect(row?.durationSeconds).toBe(42);
  expect(row?.answeredAt).not.toBeNull();
});

test("a redelivered terminate is a no-op — at-least-once must not double-count", async () => {
  const externalCallId = `wacid.dup.${Date.now()}`;
  const { callId, contactId } = await seedRingingOutboundCall(externalCallId);
  await db().contact.update({
    where: { id: contactId },
    data: { consecutiveUnansweredOutCalls: 0 },
  });

  const terminate = callsWebhook({
    calls: [
      {
        id: externalCallId,
        to: CUSTOMER_PHONE,
        from: BUSINESS_PHONE,
        event: "terminate",
        direction: "BUSINESS_INITIATED",
        status: "COMPLETED",
        timestamp: String(Math.floor(Date.now() / 1000)),
      },
    ],
  });
  await postMetaWebhook(META_TEST_TEAM_ID, terminate);
  await postMetaWebhook(META_TEST_TEAM_ID, terminate);

  const row = await db().call.findUnique({
    where: { id: callId },
    select: { status: true },
  });
  expect(row?.status).toBe("missed");
  // The unanswered counter drives WhatsApp's auto-revocation mirror and is NOT
  // idempotent — a redelivery must not inflate it toward a false revocation.
  const contact = await db().contact.findUnique({
    where: { id: contactId },
    select: { consecutiveUnansweredOutCalls: true },
  });
  expect(contact?.consecutiveUnansweredOutCalls).toBe(1);
});
