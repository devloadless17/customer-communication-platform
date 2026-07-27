/**
 * Redelivery dedupe — the guard that makes at-least-once SAFE.
 *
 * Converting the outbox to at-least-once (claim lease) is only correct if the
 * subscribers with non-idempotent side effects can recognise a replay. Three
 * can't do it on their own, so each writes an `eventKey` derived from the
 * outbox row id and leans on a partial unique index:
 *
 *   WorkflowRun             — a replay would re-execute every step, including
 *                             a second BILLED Meta send.
 *   OutboundWebhookDelivery — the row id IS the partner's dedup header.
 *   ConversationEvent       — a replay would write a second identical pill.
 *
 * These tests assert the DB-level guarantee (the index bites, and NULL keys
 * from the synchronous publish path stay unconstrained) plus the ALS plumbing
 * that carries the row id from the drainer to the writers. They deliberately
 * do NOT boot Nest: the contract under test is the key + index, not the wiring
 * of any one subscriber.
 */
import { existsSync } from "node:fs";

import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getOutboxDispatchId, runWithCorrelationContext } from "@/common/correlation";
import { setSharedDb } from "@/lib/db";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
setSharedDb(prisma as unknown as PrismaClient);

const WS_ID = "e2e-dedupe-ws";
const ORG_ID = "e2e-dedupe-org";

beforeAll(async () => {
  await prisma.organization.upsert({
    where: { id: ORG_ID },
    create: { id: ORG_ID, name: "Dedupe Org", status: "active" },
    update: {},
  });
  await prisma.workspace.upsert({
    where: { id: WS_ID },
    create: { id: WS_ID, name: "Dedupe WS", organizationId: ORG_ID },
    update: {},
  });
});

beforeEach(async () => {
  await prisma.conversationEvent.deleteMany({ where: { workspaceId: WS_ID } });
  await prisma.workflowRun.deleteMany({ where: { workspaceId: WS_ID } });
  await prisma.workflow.deleteMany({ where: { workspaceId: WS_ID } });
});

afterAll(async () => {
  await prisma.conversationEvent.deleteMany({ where: { workspaceId: WS_ID } });
  await prisma.workflowRun.deleteMany({ where: { workspaceId: WS_ID } });
  await prisma.workflow.deleteMany({ where: { workspaceId: WS_ID } });
  await prisma.workspace.deleteMany({ where: { id: WS_ID } });
  await prisma.organization.deleteMany({ where: { id: ORG_ID } });
  await prisma.$disconnect();
});

describe("outbox dispatch id (ALS)", () => {
  it("is absent on the synchronous publish path and present while the drainer dispatches", async () => {
    expect(getOutboxDispatchId()).toBeUndefined();
    await runWithCorrelationContext(
      { requestId: "req-1", chainDepth: 0, outboxDispatchId: "outbox-row-1" },
      async () => {
        expect(getOutboxDispatchId()).toBe("outbox-row-1");
        // Survives an await boundary — subscribers are async.
        await Promise.resolve();
        expect(getOutboxDispatchId()).toBe("outbox-row-1");
      },
    );
    expect(getOutboxDispatchId()).toBeUndefined();
  });
});

describe("WorkflowRun.eventKey", () => {
  async function seedWorkflow(): Promise<string> {
    const wf = await prisma.workflow.create({
      data: {
        workspaceId: WS_ID,
        name: `dedupe-${Date.now()}`,
        published: true,
        trigger: "message_received",
        triggerConfig: {},
        graph: { startNodeId: "", nodes: [], edges: [] },
      },
      select: { id: true },
    });
    return wf.id;
  }

  const runData = (workflowId: string, eventKey: string | null) => ({
    workflowId,
    workspaceId: WS_ID,
    trigger: "message_received" as const,
    eventPayload: {},
    graphSnapshot: {},
    status: "queued" as const,
    ...(eventKey ? { eventKey } : {}),
  });

  it("rejects a second run for the same (outbox row, workflow) — no duplicate billed steps", async () => {
    const workflowId = await seedWorkflow();
    const key = `outbox-row-A:${workflowId}`;
    await prisma.workflowRun.create({ data: runData(workflowId, key) });

    await expect(
      prisma.workflowRun.create({ data: runData(workflowId, key) }),
    ).rejects.toMatchObject({ code: "P2002" });

    expect(await prisma.workflowRun.count({ where: { workspaceId: WS_ID } })).toBe(1);
  });

  it("still allows a DIFFERENT workflow to run for the same event", async () => {
    const a = await seedWorkflow();
    const b = await seedWorkflow();
    await prisma.workflowRun.create({ data: runData(a, `outbox-row-B:${a}`) });
    await prisma.workflowRun.create({ data: runData(b, `outbox-row-B:${b}`) });
    expect(await prisma.workflowRun.count({ where: { workspaceId: WS_ID } })).toBe(2);
  });

  it("leaves the synchronous publish path (NULL key) unconstrained", async () => {
    const workflowId = await seedWorkflow();
    await prisma.workflowRun.create({ data: runData(workflowId, null) });
    await prisma.workflowRun.create({ data: runData(workflowId, null) });
    expect(await prisma.workflowRun.count({ where: { workspaceId: WS_ID } })).toBe(2);
  });
});

describe("ConversationEvent.eventKey", () => {
  async function seedConversation(): Promise<string> {
    const contact = await prisma.contact.create({
      data: {
        workspaceId: WS_ID,
        name: "Dedupe Contact",
        identityChannel: "whatsapp",
        phoneNumber: `1999${Date.now() % 1_000_000}`,
      },
      select: { id: true },
    });
    const convo = await prisma.conversation.create({
      data: {
        workspaceId: WS_ID,
        contactId: contact.id,
        channel: "whatsapp",
        status: "open",
        lastMessagePreview: "",
      },
      select: { id: true },
    });
    return convo.id;
  }

  it("rejects a duplicate pill from a replayed row but allows one pill PER TAG", async () => {
    const conversationId = await seedConversation();
    const base = {
      conversationId,
      workspaceId: WS_ID,
      kind: "tag_added" as const,
      before: Prisma.JsonNull,
      after: Prisma.JsonNull,
    };
    // Two tags in ONE event → distinct discriminators, both must land.
    await prisma.conversationEvent.create({
      data: { ...base, eventKey: `row-C:${conversationId}:tag_added:tag-1` },
    });
    await prisma.conversationEvent.create({
      data: { ...base, eventKey: `row-C:${conversationId}:tag_added:tag-2` },
    });
    // The SAME tag replayed → rejected.
    await expect(
      prisma.conversationEvent.create({
        data: { ...base, eventKey: `row-C:${conversationId}:tag_added:tag-1` },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    expect(await prisma.conversationEvent.count({ where: { workspaceId: WS_ID } })).toBe(2);
    await prisma.conversation.deleteMany({ where: { workspaceId: WS_ID } });
    await prisma.contact.deleteMany({ where: { workspaceId: WS_ID } });
  });
});
