/**
 * Customer-service window ← calls.
 *
 * The calling-PRICING doc settled the rules the service-messages wording left
 * open: the window starts/refreshes (a) when a WhatsApp user calls you,
 * "regardless of if you accept the call or not" — so ANY inbound call opens
 * it at its arrival — and (b) "when a WhatsApp user accepts your call" — a
 * CONNECTED outbound call opens it at pickup. `Contact.lastInboundAt` is the
 * window anchor, and three writers agree:
 *
 *   - message ingest (providers/ingest.ts) — always did,
 *   - answerCall (calls.service.ts) + call ingest (providers/ingest-call.ts)
 *     — bump per the rules above,
 *   - the contact-drift sweeper — recomputes GREATEST(inbound-message max,
 *     inbound-call ringingAt max, connected-call answeredAt max) per contact.
 *
 * The sweeper is the invariant net: if it recomputed from a NARROWER set
 * than the write paths (the original messages-only SQL, or the interim
 * connected-inbound-only version), every wider bump would be silently
 * REVERTED as "drift" within 24h — so these tests pin the recompute.
 *
 *   pnpm --filter @ccp/api exec vitest run test/call-csw-window.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setSharedDb } from "@/lib/db";
import { sweepOnce } from "@/lib/sweepers/contact-last-inbound-drift";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
setSharedDb(prisma as unknown as PrismaClient);

const S = `cw${Date.now().toString().slice(-8)}`;

// Fixed instants, oldest → newest.
const T1 = new Date("2026-07-20T10:00:00.000Z"); // inbound message
const T2 = new Date("2026-07-21T10:00:00.000Z"); // connected inbound call
const WRONG = new Date("2026-07-25T10:00:00.000Z"); // seeded drift value

let orgId = "";
let workspaceId = "";
// One contact per scenario.
let msgOnly = "";
let callNewer = "";
let missedOnly = "";
let outboundOnly = "";

async function makeContactWithConversation(suffix: string): Promise<{
  contactId: string;
  conversationId: string;
}> {
  const contact = await prisma.contact.create({
    data: {
      workspaceId,
      name: `CW ${suffix}`,
      identityChannel: "whatsapp",
      phoneNumber: `9617${Date.now().toString().slice(-6)}${suffix.length}`,
    },
    select: { id: true },
  });
  const conversation = await prisma.conversation.create({
    data: {
      workspaceId,
      contactId: contact.id,
      channel: "whatsapp",
      status: "open",
    },
    select: { id: true },
  });
  return { contactId: contact.id, conversationId: conversation.id };
}

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `CW Org ${S}`, status: "active" },
  });
  orgId = org.id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `CW WS ${S}`, organizationId: orgId } })
  ).id;

  // 1. Inbound message only — the classic case the sweeper always handled.
  {
    const { contactId, conversationId } = await makeContactWithConversation("m");
    msgOnly = contactId;
    await prisma.message.create({
      data: {
        workspaceId,
        conversationId,
        channel: "whatsapp",
        externalId: `${S}_wamid_1`,
        body: "hi",
        direction: "in",
        timestamp: T1,
      },
    });
  }

  // 2. Inbound message + NEWER connected inbound call. Seeded with the
  //    message's timestamp, as if the call-driven bump crashed before the
  //    contact write — the sweeper must advance it to the call's answeredAt.
  {
    const { contactId, conversationId } = await makeContactWithConversation("c");
    callNewer = contactId;
    await prisma.message.create({
      data: {
        workspaceId,
        conversationId,
        channel: "whatsapp",
        externalId: `${S}_wamid_2`,
        body: "hi",
        direction: "in",
        timestamp: T1,
      },
    });
    await prisma.call.create({
      data: {
        workspaceId,
        conversationId,
        externalCallId: `${S}_call_answered`,
        direction: "in",
        status: "completed",
        ringingAt: T2,
        answeredAt: T2,
        endedAt: new Date(T2.getTime() + 60_000),
        durationSeconds: 60,
        rawPayload: {},
      },
    });
  }

  // 3. MISSED inbound call only (answeredAt null) — still opens the window
  //    at its ARRIVAL (pricing doc: "regardless of if you accept the call or
  //    not"). Seeded with a wrong FUTURE value the sweeper must correct DOWN
  //    to the call's ringingAt (drift in the too-generous direction).
  {
    const { contactId, conversationId } = await makeContactWithConversation("x");
    missedOnly = contactId;
    await prisma.call.create({
      data: {
        workspaceId,
        conversationId,
        externalCallId: `${S}_call_missed`,
        direction: "in",
        status: "missed",
        ringingAt: T2,
        endedAt: T2,
        rawPayload: {},
      },
    });
    await prisma.contact.update({
      where: { id: contactId },
      data: { lastInboundAt: WRONG },
    });
  }

  // 4. Connected OUTBOUND call only — the customer ACCEPTED the business's
  //    call, which opens the window at pickup (pricing doc: "when a WhatsApp
  //    user accepts your call").
  {
    const { contactId, conversationId } = await makeContactWithConversation("o");
    outboundOnly = contactId;
    await prisma.call.create({
      data: {
        workspaceId,
        conversationId,
        externalCallId: `${S}_call_out`,
        direction: "out",
        status: "completed",
        ringingAt: T2,
        answeredAt: T2,
        endedAt: new Date(T2.getTime() + 30_000),
        durationSeconds: 30,
        rawPayload: {},
      },
    });
  }
});

afterAll(async () => {
  // Workspace cascade removes contacts/conversations/messages/calls.
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.$disconnect();
});

async function lastInbound(contactId: string): Promise<Date | null> {
  const row = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { lastInboundAt: true },
  });
  return row?.lastInboundAt ?? null;
}

// The sweeper is GLOBAL — it walks every workspace in the shared dev DB (one
// raw UPDATE each), so under a parallel full-suite run a sweep can take
// several seconds. 30s keeps a loaded run from flaking on the 5s default; the
// assertions, not the wall clock, are the test.
const SWEEP_TIMEOUT_MS = 30_000;

describe("contact-drift sweeper recompute (messages + calls, pricing-doc rules)", () => {
  it("reconciles all four scenarios in one sweep", { timeout: SWEEP_TIMEOUT_MS }, async () => {
    await sweepOnce();

    // Message-only contact: the classic recompute still works.
    expect(await lastInbound(msgOnly)).toEqual(T1);

    // Connected inbound call NEWER than the last message wins — the old
    // messages-only SQL would have written T1 here, reverting the window.
    expect(await lastInbound(callNewer)).toEqual(T2);

    // A missed inbound call opens the window at its ARRIVAL ("regardless of
    // if you accept the call or not"); the seeded too-future value is
    // corrected down to the call's ringingAt.
    expect(await lastInbound(missedOnly)).toEqual(T2);

    // A connected OUTBOUND call opens the window at pickup ("when a WhatsApp
    // user accepts your call").
    expect(await lastInbound(outboundOnly)).toEqual(T2);
  });

  it("is idempotent — a second sweep changes nothing", { timeout: SWEEP_TIMEOUT_MS }, async () => {
    await sweepOnce();
    expect(await lastInbound(callNewer)).toEqual(T2);
    expect(await lastInbound(missedOnly)).toEqual(T2);
    expect(await lastInbound(outboundOnly)).toEqual(T2);
  });
});
