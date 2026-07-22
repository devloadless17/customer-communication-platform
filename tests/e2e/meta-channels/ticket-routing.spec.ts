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

test("an inbound message auto-opens a ticket and stamps it on the message", async () => {
  const psid = "6009900001111";
  const mid = "m.ticket.in.1";
  const res = await inbound(psid, mid, "my order never arrived");
  expect(res.status).toBe(200);

  const message = await messageWithTicket(mid);
  expect(message).not.toBeNull();
  // The wiring assertion: ingest routed this message to a ticket.
  expect(message!.ticketId).toBeTruthy();

  const ticket = await db().ticket.findUniqueOrThrow({
    where: { id: message!.ticketId! },
    select: { status: true, source: true, number: true, workspaceId: true, channel: true },
  });
  expect(ticket.status).toBe("new");
  // Opened by the message, not by a person.
  expect(ticket.source).toBe("auto");
  expect(ticket.workspaceId).toBe(META_TEST_TEAM_ID);
  expect(ticket.channel).toBe("messenger");
  expect(ticket.number).toBeGreaterThan(0);

  // The conversation points at it, and the inbox badge counter agrees.
  const convo = await db().conversation.findUniqueOrThrow({
    where: { id: message!.conversationId },
    select: { activeTicketId: true, openTicketCount: true },
  });
  expect(convo.activeTicketId).toBe(message!.ticketId);
  expect(convo.openTicketCount).toBe(1);
});

test("a follow-up message joins the SAME ticket — one issue, not two", async () => {
  const psid = "6009900002222";
  await inbound(psid, "m.ticket.in.2a", "hello");
  await inbound(psid, "m.ticket.in.2b", "still waiting");

  const first = await messageWithTicket("m.ticket.in.2a");
  const second = await messageWithTicket("m.ticket.in.2b");
  expect(first!.ticketId).toBeTruthy();
  expect(second!.ticketId).toBe(first!.ticketId);

  const tickets = await db().ticket.count({
    where: { workspaceId: META_TEST_TEAM_ID, conversationId: first!.conversationId },
  });
  expect(tickets).toBe(1);
});

test("a redelivered webhook does not open a second ticket", async () => {
  const psid = "6009900003333";
  const mid = "m.ticket.in.3";
  await inbound(psid, mid, "duplicate me");
  // Meta delivers at-least-once; the dedupe gate must stop the whole tail of
  // the pipeline, ticket routing included.
  await inbound(psid, mid, "duplicate me");

  const message = await messageWithTicket(mid);
  const tickets = await db().ticket.count({
    where: { workspaceId: META_TEST_TEAM_ID, conversationId: message!.conversationId },
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

test("/v1 lists the tickets ingest opened, filtered by status", async () => {
  const all = await apiJson<{ tickets: TicketDto[] }>("/tickets");
  expect(all.tickets.length).toBeGreaterThan(0);

  // The status filter is a real filter, not decoration: every row it returns
  // carries the status asked for. Asserting on the WHOLE board's status would
  // be wrong — a ticket auto-opened on an already-assigned thread inherits its
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

  // A SECOND ticket on the same thread, created deliberately — a person can
  // raise two issues at once, and that is the whole reason tickets are a
  // separate entity from the conversation.
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

test("/v1 ticket settings turn auto-open off, and inbound stops opening tickets", async () => {
  await apiJson("/tickets-settings", {
    method: "PATCH",
    body: JSON.stringify({ ticketAutoOpen: false }),
  });

  const psid = "6009900007777";
  await inbound(psid, "m.ticket.v1.4", "no ticket for me");
  const message = await messageWithTicket("m.ticket.v1.4");
  expect(message).not.toBeNull();
  // The message still lands — ticketing is off, not broken.
  expect(message!.ticketId).toBeNull();

  // Restore, so this spec leaves the shared team as it found it.
  await apiJson("/tickets-settings", {
    method: "PATCH",
    body: JSON.stringify({ ticketAutoOpen: true }),
  });
});

// ---------------------------------------------------------------------------
// Auto-assignment follow-through. The ordering here is the whole point:
// auto-assign runs DETACHED in the background tier, so it lands AFTER ingest
// has already opened the ticket. Without the follow-through, every auto-opened
// ticket on an auto-assigned thread stays unassigned forever.
// ---------------------------------------------------------------------------

test("assigning the conversation gives its auto-opened ticket the same owner", async () => {
  const psid = "6009900008888";
  await inbound(psid, "m.ticket.assign.1", "who owns this");
  const message = await messageWithTicket("m.ticket.assign.1");
  expect(message!.ticketId).toBeTruthy();

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
