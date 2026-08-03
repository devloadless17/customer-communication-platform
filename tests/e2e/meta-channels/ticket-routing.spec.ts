/**
 * Message → ticket routing, end to end through the REAL webhook pipeline.
 *
 * The domain rules are unit-tested against the domain layer directly
 * (apps/api/test/tickets.spec.ts). What can only be proven HERE is that the
 * routing is actually WIRED into ingest: that a genuine HMAC-signed Meta
 * webhook, landing through object-dispatch → parse → identity → upsert, comes
 * out the other side with a ticket attached to the message it created.
 *
 * That distinction is the whole point of this file. A domain layer that is
 * perfect and never called looks identical to a broken one from the outside.
 */

import { test, expect } from "@playwright/test";

import { db } from "../_helpers/db";
import {
  seedMetaTestTeam,
  postMetaWebhook,
  socialInbound,
  META_TEST_TEAM_ID,
  META_API_BASE,
  MSGR_PAGE_ID,
} from "../_helpers/meta";

let apiToken = "";

/** A `/v1` call with the seeded key. Mirrors the helper in assignment-routing. */
async function api(path: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${META_API_BASE}/api/external/v1${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (res.status === 429 && attempt < 12) {
      await new Promise((r) => setTimeout(r, 3_000));
      continue;
    }
    // seedMetaTestTeam() rotates the team's keys, so a concurrent re-seed
    // invalidates ours mid-suite. Re-seed and retry rather than failing for a
    // harness reason.
    if (res.status === 401 && attempt < 2) {
      apiToken = (await seedMetaTestTeam()).apiToken;
      continue;
    }
    return res;
  }
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await api(path, init);
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** One Messenger inbound through the real signed-webhook path. */
function inbound(senderId: string, mid: string, text: string) {
  return postMetaWebhook(
    META_TEST_TEAM_ID,
    socialInbound({ object: "page", accountId: MSGR_PAGE_ID, senderId, mid, text }),
  );
}

test.describe.configure({ mode: "serial" });

// Convention (see reactions.spec.ts): seed in beforeAll but DO NOT wipe —
// `wipeMetaTestTeam` mid-run stales the api's 60s provider-config cache, and
// every spec that runs after us then drops its inbound webhooks. Our external
// ids (`m.ticket.*`) and PSIDs (`60099000…`) are unique across the suite, so
// the final spec's wipe cleans up our rows harmlessly.
test.beforeAll(async () => {
  apiToken = (await seedMetaTestTeam()).apiToken;
});

async function messageWithTicket(externalId: string) {
  return db().message.findUnique({
    where: {
      workspaceId_channel_externalId: {
        workspaceId: META_TEST_TEAM_ID,
        channel: "messenger",
        externalId,
      },
    },
    select: { id: true, conversationId: true, ticketId: true },
  });
}

test("an inbound message does NOT open a ticket — tickets are raised deliberately", async () => {
  const psid = "6009900001111";
  const mid = "m.ticket.in.1";
  const res = await inbound(psid, mid, "my order never arrived");
  expect(res.status).toBe(200);

  const message = await messageWithTicket(mid);
  expect(message).not.toBeNull();
  // Auto-open was removed 2026-07-25: the message lands ticket-free — the
  // inbox already tracks the thread; a ticket means someone decided this
  // needs work, not "a message arrived".
  expect(message!.ticketId).toBeNull();
  const tickets = await db().ticket.count({
    where: { workspaceId: META_TEST_TEAM_ID, conversationId: message!.conversationId },
  });
  expect(tickets).toBe(0);

  const convo = await db().conversation.findUniqueOrThrow({
    where: { id: message!.conversationId },
    select: { activeTicketId: true, openTicketCount: true },
  });
  expect(convo.activeTicketId).toBeNull();
  expect(convo.openTicketCount).toBe(0);
});

test("a follow-up message ATTACHES to the thread's raised ticket — the wiring assertion", async () => {
  const psid = "6009900002222";
  await inbound(psid, "m.ticket.in.2a", "hello");
  const first = await messageWithTicket("m.ticket.in.2a");
  expect(first!.ticketId).toBeNull();

  // Raise the ticket deliberately (as an agent or workflow would).
  const raised = await apiJson<{ ticket: { id: string } }>("/tickets", {
    method: "POST",
    body: JSON.stringify({ conversationId: first!.conversationId, subject: "Order missing" }),
  });

  // The follow-up inbound, through the REAL signed-webhook path, must come out
  // the other side attached to that ticket — this is what only THIS suite can
  // prove: the routing is wired into ingest, not just correct in the domain.
  await inbound(psid, "m.ticket.in.2b", "still waiting");
  const second = await messageWithTicket("m.ticket.in.2b");
  expect(second!.ticketId).toBe(raised.ticket.id);

  const tickets = await db().ticket.count({
    where: { workspaceId: META_TEST_TEAM_ID, conversationId: first!.conversationId },
  });
  expect(tickets).toBe(1);
});

test("a redelivered webhook attaches nothing twice — dedupe stops the whole tail", async () => {
  const psid = "6009900003333";
  await inbound(psid, "m.ticket.in.3a", "first contact");
  const seed = await messageWithTicket("m.ticket.in.3a");
  const raised = await apiJson<{ ticket: { id: string } }>("/tickets", {
    method: "POST",
    body: JSON.stringify({ conversationId: seed!.conversationId }),
  });

  const mid = "m.ticket.in.3b";
  await inbound(psid, mid, "duplicate me");
  // Meta delivers at-least-once; the dedupe gate must stop the whole tail of
  // the pipeline, ticket routing included — one message row, one attach.
  await inbound(psid, mid, "duplicate me");

  const copies = await db().message.count({
    where: { workspaceId: META_TEST_TEAM_ID, channel: "messenger", externalId: mid },
  });
  expect(copies).toBe(1);
  const message = await messageWithTicket(mid);
  expect(message!.ticketId).toBe(raised.ticket.id);
  const tickets = await db().ticket.count({
    where: { workspaceId: META_TEST_TEAM_ID, conversationId: seed!.conversationId },
  });
  expect(tickets).toBe(1);
});

// ---------------------------------------------------------------------------
// The `/v1` surface. Same domain functions the in-app board calls, with an
// API-key actor — so these assertions cover BOTH surfaces' rules at once.
// ---------------------------------------------------------------------------

interface TicketDto {
  id: string;
  number: number;
  status: string;
  priority: string;
  version: number;
  conversationId: string;
  subject: string | null;
  assignedUserId: string | null;
  sla: { firstResponseDueAt: string | null; resolutionDueAt: string | null; paused: boolean };
}

test("/v1 lists the raised tickets, filtered by status", async () => {
  const all = await apiJson<{ tickets: TicketDto[] }>("/tickets");
  expect(all.tickets.length).toBeGreaterThan(0);

  // The status filter is a real filter, not decoration: every row it returns
  // carries the status asked for. Asserting on the WHOLE board's status would
  // be wrong — a ticket raised on an already-assigned thread inherits its
  // owner and starts `open`, not `new`.
  const newOnly = await apiJson<{ tickets: TicketDto[] }>("/tickets?status=new");
  expect(newOnly.tickets.length).toBeGreaterThan(0);
  expect(newOnly.tickets.every((t) => t.status === "new")).toBe(true);

  // Two statuses at once, and the comma list is parsed as a list.
  const active = await apiJson<{ tickets: TicketDto[] }>("/tickets?status=new,open");
  expect(active.tickets.every((t) => t.status === "new" || t.status === "open")).toBe(true);
  expect(active.tickets.length).toBeGreaterThanOrEqual(newOnly.tickets.length);

  // A bogus enum value is a 400 that NAMES the problem, not a 500 and not a
  // silently-ignored filter that would return the whole board.
  const bad = await api("/tickets?status=not_a_status");
  expect(bad.status).toBe(400);
});

test("/v1 opens, works and solves a ticket end to end", async () => {
  const psid = "6009900004444";
  await inbound(psid, "m.ticket.v1.1", "the lamp is broken");
  const message = await messageWithTicket("m.ticket.v1.1");

  // TWO tickets on one thread, each raised deliberately — a person can have
  // two live issues at once, and that is the whole reason tickets are a
  // separate entity from the conversation.
  await apiJson<{ ticket: TicketDto }>("/tickets", {
    method: "POST",
    body: JSON.stringify({ conversationId: message!.conversationId, subject: "Broken lamp" }),
  });
  const created = await apiJson<{ ticket: TicketDto; openTicketCount: number }>("/tickets", {
    method: "POST",
    body: JSON.stringify({
      conversationId: message!.conversationId,
      subject: "Also: wrong invoice",
      priority: "high",
    }),
  });
  expect(created.ticket.subject).toBe("Also: wrong invoice");
  expect(created.ticket.priority).toBe("high");
  expect(created.openTicketCount).toBe(2);

  const solved = await apiJson<{ ticket: TicketDto; openTicketCount: number }>(
    `/tickets/${created.ticket.id}`,
    {
      method: "PATCH",
      body: JSON.stringify({ status: "solved", resolutionCode: "fixed" }),
    },
  );
  expect(solved.ticket.status).toBe("solved");
  // The first ticket is still open, so the thread's badge drops to 1, not 0.
  expect(solved.openTicketCount).toBe(1);

  const detail = await apiJson<{ ticket: TicketDto; events: Array<{ kind: string }> }>(
    `/tickets/${created.ticket.id}`,
  );
  expect(detail.ticket.status).toBe("solved");
  // The timeline records both the creation and the transition.
  expect(detail.events.map((e) => e.kind)).toEqual(["created", "status_changed"]);
});

test("/v1 rejects a stale write instead of clobbering a concurrent one", async () => {
  const psid = "6009900005555";
  await inbound(psid, "m.ticket.v1.2", "stale write");
  const message = await messageWithTicket("m.ticket.v1.2");
  const created = await apiJson<{ ticket: TicketDto }>("/tickets", {
    method: "POST",
    body: JSON.stringify({ conversationId: message!.conversationId }),
  });
  const stale = created.ticket.version;

  const first = await api(`/tickets/${created.ticket.id}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedVersion: stale, priority: "urgent" }),
  });
  expect(first.status).toBe(200);

  const second = await api(`/tickets/${created.ticket.id}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedVersion: stale, priority: "low" }),
  });
  // 409, not 400 — the caller's input was fine, their view was old.
  expect(second.status).toBe(409);
  expect((await second.json()).error).toBe("version_conflict");
});

test("/v1 SLA policy drives the due dates of tickets opened after it", async () => {
  await apiJson("/ticket-sla", {
    method: "POST",
    body: JSON.stringify({ priority: "urgent", firstResponseMins: 15, resolutionMins: 60 }),
  });
  const { policies } = await apiJson<{ policies: Array<{ priority: string; firstResponseMins: number | null }> }>(
    "/ticket-sla",
  );
  expect(policies.find((p) => p.priority === "urgent")?.firstResponseMins).toBe(15);

  const psid = "6009900006666";
  await inbound(psid, "m.ticket.v1.3", "urgent please");
  const message = await messageWithTicket("m.ticket.v1.3");
  const created = await apiJson<{ ticket: TicketDto }>("/tickets", {
    method: "POST",
    body: JSON.stringify({ conversationId: message!.conversationId, priority: "urgent" }),
  });
  expect(created.ticket.sla.firstResponseDueAt).toBeTruthy();
  const due = new Date(created.ticket.sla.firstResponseDueAt!).getTime();
  expect(due - Date.now()).toBeGreaterThan(13 * 60_000);
  expect(due - Date.now()).toBeLessThan(16 * 60_000);
});

test("solved means solved: an inbound attaches to a LIVE ticket, and never reopens a solved one", async () => {
  // Auto-REOPEN was removed 2026-08-03 ("nothing opens or reopens a ticket
  // but a person raising one") — this spec previously asserted the reopen
  // window and blocked deploys once the behavior was (deliberately) gone.
  // The contract now: an inbound ATTACHES to the thread's live ticket, and
  // after a solve it carries NO ticket at all — a later message is a new
  // issue somebody must choose to raise.
  const psid = "6009900007777";
  await inbound(psid, "m.ticket.v1.4a", "first issue");
  const seed = await messageWithTicket("m.ticket.v1.4a");
  const raised = await apiJson<{ ticket: TicketDto }>("/tickets", {
    method: "POST",
    body: JSON.stringify({ conversationId: seed!.conversationId }),
  });

  // While the ticket is LIVE the follow-up attaches to it.
  await inbound(psid, "m.ticket.v1.4b", "more details");
  const attached = await messageWithTicket("m.ticket.v1.4b");
  expect(attached!.ticketId).toBe(raised.ticket.id);

  await apiJson(`/tickets/${raised.ticket.id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "solved", resolutionCode: "fixed" }),
  });

  // After the solve: the next inbound neither reopens the solved ticket nor
  // opens anything — it carries no ticket, and the solve stands.
  await inbound(psid, "m.ticket.v1.4c", "it broke again");
  const afterSolve = await messageWithTicket("m.ticket.v1.4c");
  expect(afterSolve!.ticketId).toBeNull();
  const stillSolved = await db().ticket.findUniqueOrThrow({
    where: { id: raised.ticket.id },
    select: { status: true },
  });
  expect(stillSolved.status).toBe("solved");

  // `ticketReopenWindowHours` is retired from the settings schema — Zod
  // strips unknown keys, so an integration still sending it gets a no-op
  // (not a 400), and nothing reads the column.
  await apiJson("/tickets-settings", {
    method: "PATCH",
    body: JSON.stringify({ ticketReopenWindowHours: 0 }),
  });
});

// ---------------------------------------------------------------------------
// Assignment follow-through. Assigning a conversation must give the thread's
// ACTIVE ticket the same owner when the ticket has none — without it, every
// ticket raised before the thread found its agent would sit unassigned
// forever while the conversation itself is owned.
// ---------------------------------------------------------------------------

test("assigning the conversation gives its unowned active ticket the same owner", async () => {
  const psid = "6009900008888";
  await inbound(psid, "m.ticket.assign.1", "who owns this");
  const message = await messageWithTicket("m.ticket.assign.1");
  const raised = await apiJson<{ ticket: TicketDto }>("/tickets", {
    method: "POST",
    body: JSON.stringify({ conversationId: message!.conversationId, subject: "Needs an owner" }),
  });
  message!.ticketId = raised.ticket.id;

  const ticketBefore = await db().ticket.findUniqueOrThrow({
    where: { id: message!.ticketId! },
    select: { assignedUserId: true },
  });
  expect(ticketBefore.assignedUserId).toBeNull();

  // Mint our OWN member rather than borrowing one from the shared roster:
  // earlier specs in this team deactivate teammates to exercise the rebalance
  // path, and assigning to a deactivated user is a 400 by design — so whether
  // an active one exists depends on which specs ran before us.
  const workspace = await db().workspace.findUniqueOrThrow({
    where: { id: META_TEST_TEAM_ID },
    select: { organizationId: true },
  });
  // Two statements, not one nested create: Prisma refuses a scalar FK
  // (`workspaceId`) alongside a nested relation write in the same `data`.
  const owner = await db().user.create({
    data: {
      name: "Ticket owner",
      email: `ticket-owner-${Date.now()}@e2e.test`,
      organizationId: workspace.organizationId,
      // Created directly in the DB, so it is verified by construction — the
      // column defaults to FALSE and `resolveSession` refuses an unverified
      // user, which surfaces as a 403 `email_not_verified` far from the cause.
      emailVerified: true,
    },
    select: { id: true },
  });
  const member = await db().workspaceMember.create({
    data: { workspaceId: META_TEST_TEAM_ID, userId: owner.id, role: "agent" },
    select: { userId: true },
  });

  const res = await api(`/conversations/${message!.conversationId}/assign`, {
    method: "POST",
    body: JSON.stringify({ assignedUserId: member.userId }),
  });
  expect(res.status, await res.text()).toBeLessThan(300);

  const ticketAfter = await db().ticket.findUniqueOrThrow({
    where: { id: message!.ticketId! },
    select: { assignedUserId: true, status: true },
  });
  expect(ticketAfter.assignedUserId).toBe(member.userId);
});
