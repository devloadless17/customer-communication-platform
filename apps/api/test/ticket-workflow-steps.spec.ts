/**
 * The four ticket workflow steps, driven against a real database.
 *
 * Steps are the seam where automation touches tickets, so the things worth
 * proving are the SAFETY rules rather than the happy path:
 *
 *   - `create_ticket` does not mint a second ticket every time a customer
 *     writes (the default that makes "open a ticket on inbound" usable at all),
 *   - `assign_ticket` never takes work away from whoever already owns it,
 *   - a step whose thread has no live work SKIPS and lets the run continue,
 *     rather than failing the whole workflow,
 *   - bad config is rejected at parse time, not at run time in production.
 *
 *   pnpm --filter @ccp/api exec vitest run test/ticket-workflow-steps.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setSharedDb } from "@/lib/db";
import { getStepHandler } from "@/lib/workflows/steps";
import { StepConfigError } from "@/lib/workflows/steps/types";
import { createTicket, updateTicket } from "@/lib/tickets/mutations";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
setSharedDb(prisma as unknown as PrismaClient);
const db = prisma as unknown as Parameters<typeof createTicket>[0];

const S = `tw${Date.now().toString().slice(-8)}`;
let orgId = "";
let workspaceId = "";
let userId = "";
let otherUserId = "";
let seq = 0;

async function makeConversation() {
  const contact = await prisma.contact.create({
    data: {
      workspaceId,
      name: `TW ${seq}`,
      phoneNumber: `+9855${S}${String(seq++).padStart(3, "0")}`,
      identityChannel: "whatsapp",
    },
    select: { id: true },
  });
  const convo = await prisma.conversation.create({
    data: { workspaceId, contactId: contact.id, channel: "whatsapp" },
    select: { id: true },
  });
  return convo.id;
}

/** The slice of the envelope + context the ticket steps actually read. */
function envelopeFor(conversationId: string) {
  return {
    version: 1,
    event: "message_received",
    workspaceId,
    occurredAt: new Date().toISOString(),
    data: { conversation: { id: conversationId } },
  } as unknown as Parameters<ReturnType<typeof getStepHandler>["run"]>[0];
}

function ctx() {
  return {
    workspaceId,
    workflowId: "wf_test",
    runId: "run_test",
    trigger: "message_received",
    attempt: 1,
    stepId: "step_1",
    graph: {},
    executionIndex: 0,
  } as unknown as Parameters<ReturnType<typeof getStepHandler>["run"]>[2];
}

async function runStep(type: string, rawConfig: unknown, conversationId: string) {
  const handler = getStepHandler(type as never);
  const config = handler.parseConfig(rawConfig);
  return handler.run(envelopeFor(conversationId), config, ctx());
}

/** A step's structured output. `advance()` serializes it into `body`. */
async function stepOutput(
  type: string,
  rawConfig: unknown,
  conversationId: string,
): Promise<{ status: number; out: Record<string, unknown> }> {
  const result = await runStep(type, rawConfig, conversationId);
  return {
    status: result.status,
    out: (result.body ? JSON.parse(result.body) : {}) as Record<string, unknown>,
  };
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `TW Org ${S}`, status: "active" } }))
    .id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `TW WS ${S}`, organizationId: orgId } })
  ).id;
  userId = (
    await prisma.user.create({
      data: { name: "TW A", email: `tw-a-${S}@example.test`, organizationId: orgId },
      select: { id: true },
    })
  ).id;
  otherUserId = (
    await prisma.user.create({
      data: { name: "TW B", email: `tw-b-${S}@example.test`, organizationId: orgId },
      select: { id: true },
    })
  ).id;
  await prisma.workspaceMember.createMany({
    data: [
      { userId, workspaceId, role: "agent" },
      { userId: otherUserId, workspaceId, role: "agent" },
    ],
  });
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("config validation", () => {
  it("rejects an unknown status / priority at PARSE time", () => {
    const status = getStepHandler("set_ticket_status" as never);
    expect(() => status.parseConfig({ status: "almost_done" })).toThrow(StepConfigError);
    const priority = getStepHandler("set_ticket_priority" as never);
    expect(() => priority.parseConfig({ priority: "asap" })).toThrow(StepConfigError);
    const assign = getStepHandler("assign_ticket" as never);
    expect(() => assign.parseConfig({ mode: "user" })).toThrow(StepConfigError);
  });

  it("defaults create_ticket to skip-if-already-open", () => {
    const handler = getStepHandler("create_ticket" as never);
    const config = handler.parseConfig({}) as { onlyIfNoActiveTicket: boolean };
    // The default that makes "open a ticket when a customer messages" usable:
    // without it, every follow-up message mints another ticket.
    expect(config.onlyIfNoActiveTicket).toBe(true);
  });
});

describe("create_ticket", () => {
  it("opens one, then SKIPS while that ticket is still live", async () => {
    const conversationId = await makeConversation();
    const first = await stepOutput(
      "create_ticket",
      { subject: "Broken lamp", priority: "high" },
      conversationId,
    );
    expect(first.out.ticketId).toBeTruthy();

    const second = await stepOutput("create_ticket", {}, conversationId);
    expect(second.out.skipped).toBe("already_has_active_ticket");
    expect(await prisma.ticket.count({ where: { workspaceId, conversationId } })).toBe(1);
  });

  it("opens a second one when the caller explicitly allows it", async () => {
    const conversationId = await makeConversation();
    await runStep("create_ticket", {}, conversationId);
    await runStep("create_ticket", { onlyIfNoActiveTicket: false }, conversationId);
    expect(await prisma.ticket.count({ where: { workspaceId, conversationId } })).toBe(2);
  });
});

describe("set_ticket_status / set_ticket_priority", () => {
  it("moves the conversation's ACTIVE ticket", async () => {
    const conversationId = await makeConversation();
    const opened = await createTicket(db, { workspaceId, conversationId, actor: {} });
    if (!opened.ok) throw new Error("setup failed");

    await runStep("set_ticket_priority", { priority: "urgent" }, conversationId);
    await runStep(
      "set_ticket_status",
      { status: "solved", resolutionCode: "auto_resolved" },
      conversationId,
    );

    const row = await prisma.ticket.findUniqueOrThrow({
      where: { id: opened.ticket.id },
      select: { status: true, priority: true, resolutionCode: true },
    });
    expect(row.priority).toBe("urgent");
    expect(row.status).toBe("solved");
    expect(row.resolutionCode).toBe("auto_resolved");
  });

  it("SKIPS (and lets the run continue) when the thread has no live work", async () => {
    const conversationId = await makeConversation();
    // No ticket at all — a normal state, not an error.
    const result = await stepOutput("set_ticket_status", { status: "solved" }, conversationId);
    expect(result.out.skipped).toBe("no_active_ticket");
    // The run advances rather than failing: a workflow shouldn't die because
    // there happened to be nothing to close.
    expect(result.status).toBeLessThan(400);
  });
});

describe("assign_ticket", () => {
  it("fills an empty owner", async () => {
    const conversationId = await makeConversation();
    const opened = await createTicket(db, {
      workspaceId,
      conversationId,
      actor: {},
      assignedUserId: null,
    });
    if (!opened.ok) throw new Error("setup failed");

    await runStep("assign_ticket", { mode: "user", userId }, conversationId);
    const row = await prisma.ticket.findUniqueOrThrow({
      where: { id: opened.ticket.id },
      select: { assignedUserId: true },
    });
    expect(row.assignedUserId).toBe(userId);
  });

  it("NEVER takes the ticket from someone already on it, unless told to", async () => {
    const conversationId = await makeConversation();
    const opened = await createTicket(db, {
      workspaceId,
      conversationId,
      actor: {},
      assignedUserId: otherUserId,
    });
    if (!opened.ok) throw new Error("setup failed");

    const skipped = await stepOutput("assign_ticket", { mode: "user", userId }, conversationId);
    expect(skipped.out.skipped).toBe("already_assigned");
    let row = await prisma.ticket.findUniqueOrThrow({
      where: { id: opened.ticket.id },
      select: { assignedUserId: true },
    });
    expect(row.assignedUserId).toBe(otherUserId);

    // An escalation workflow opts in explicitly.
    await runStep("assign_ticket", { mode: "user", userId, overwrite: true }, conversationId);
    row = await prisma.ticket.findUniqueOrThrow({
      where: { id: opened.ticket.id },
      select: { assignedUserId: true },
    });
    expect(row.assignedUserId).toBe(userId);
  });

  it("refuses an assignee from another workspace", async () => {
    const conversationId = await makeConversation();
    await createTicket(db, { workspaceId, conversationId, actor: {}, assignedUserId: null });
    const outsider = await prisma.user.create({
      data: { name: "TW outsider", email: `tw-out-${S}@example.test`, organizationId: orgId },
      select: { id: true },
    });
    // Real user id, real org — but no membership in THIS workspace.
    const result = await runStep(
      "assign_ticket",
      { mode: "user", userId: outsider.id },
      conversationId,
    );
    expect(result.status).toBe(400);
  });

  it("unassigns", async () => {
    const conversationId = await makeConversation();
    const opened = await createTicket(db, {
      workspaceId,
      conversationId,
      actor: {},
      assignedUserId: userId,
    });
    if (!opened.ok) throw new Error("setup failed");

    await runStep("assign_ticket", { mode: "unassign" }, conversationId);
    const row = await prisma.ticket.findUniqueOrThrow({
      where: { id: opened.ticket.id },
      select: { assignedUserId: true },
    });
    expect(row.assignedUserId).toBeNull();
  });
});

describe("loop safety", () => {
  it("publishes every ticket event as SILENT so a step can't chain-trigger a workflow", async () => {
    const conversationId = await makeConversation();
    // Clear rows written by the direct `createTicket` calls in the tests above
    // — those are NOT step-driven and correctly carry no `silent` flag, so
    // leaving them in would make this assertion test the wrong thing.
    await prisma.outboundEvent.deleteMany({ where: { workspaceId } });

    await runStep("create_ticket", {}, conversationId);
    await runStep("set_ticket_status", { status: "solved" }, conversationId);

    const events = await prisma.outboundEvent.findMany({
      where: { workspaceId, type: "ticket.changed" },
      select: { payload: true },
    });
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      // Without this, a `create_ticket` step inside workflow X could fire
      // workflow Y mid-run — the recursive chain §9 forbids.
      expect((e.payload as { silent?: boolean }).silent).toBe(true);
    }
    // Housekeeping: this workspace's rows would otherwise linger in the outbox.
    await prisma.outboundEvent.deleteMany({ where: { workspaceId } });
  });
});

/** `updateTicket` is re-exported here only to keep the import graph honest —
 *  the steps must go through the same chokepoint the UI and /v1 use. */
void updateTicket;
