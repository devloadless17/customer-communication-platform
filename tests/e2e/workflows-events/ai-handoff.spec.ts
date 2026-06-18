import { createHash, randomBytes } from "node:crypto";

import { test, expect, type APIRequestContext } from "@playwright/test";

import { db, superadminTeam, pollUntil } from "../_helpers/db";

/**
 * AI customer-handoff policy — edge cases.
 *
 * When a customer hands off to a human, the AI flow calls
 * `POST /api/external/v1/conversations/:id/ai` with `{aiEnabled:false}`. This
 * endpoint is ONLY hit by that "human" branch, so the team's configured handoff
 * action (none / unassign / assign_fixed / round_robin) runs BY DEFAULT after
 * the pause — no n8n flag required. These specs drive that endpoint with a
 * seeded API key and assert the conversation's resulting assignee + ai state.
 *
 * Pure API + DB (no browser): we seed the key/agents/conversations directly and
 * observe the DB, so the suite is deterministic and fast.
 */

// ── fixtures shared across the describe ─────────────────────────────────────
let teamId: string;
let apiToken: string;
let agentA: string;
let agentB: string;
let apiKeyId: string;
const createdUserIds: string[] = [];

function newApiKey() {
  const token = `ccp_${randomBytes(24).toString("hex")}`;
  return {
    token,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    tokenPrefix: token.slice(0, 12),
  };
}

async function makeAgent(label: string): Promise<string> {
  const email = `e2e-handoff-${label}-${Date.now()}@loadless.test`;
  const u = await db().user.create({
    data: { teamId, role: "agent", name: `Handoff ${label}`, email, availabilityStatus: "available" },
    select: { id: true },
  });
  createdUserIds.push(u.id);
  return u.id;
}

let convoSeq = 0;
const createdContactIds: string[] = [];
const createdConvoIds: string[] = [];
/** Fresh contact + conversation. Each test gets its own so state can't leak. */
async function makeConversation(opts: {
  aiEnabled?: boolean;
  assignedUserId?: string | null;
  status?: "open" | "pending" | "closed";
} = {}): Promise<string> {
  convoSeq += 1;
  const phone = `+1555${Date.now().toString().slice(-7)}${String(convoSeq).padStart(2, "0")}`;
  const contact = await db().contact.create({
    data: { teamId, identityChannel: "whatsapp", phoneNumber: phone, name: `Handoff Contact ${convoSeq}` },
    select: { id: true },
  });
  createdContactIds.push(contact.id);
  const convo = await db().conversation.create({
    data: {
      teamId,
      contactId: contact.id,
      channel: "whatsapp",
      status: opts.status ?? "pending",
      aiEnabled: opts.aiEnabled ?? true,
      assignedUserId: opts.assignedUserId ?? null,
      lastMessageAt: new Date(),
      lastMessagePreview: "hi",
    },
    select: { id: true },
  });
  createdConvoIds.push(convo.id);
  return convo.id;
}

async function setHandoff(action: "none" | "unassign" | "assign_fixed" | "round_robin", assigneeId?: string | null) {
  await db().team.update({
    where: { id: teamId },
    data: {
      aiHandoffAction: action,
      ...(assigneeId !== undefined ? { aiHandoffAssigneeId: assigneeId } : {}),
    },
  });
}

/** Call the external AI-toggle endpoint with the seeded API key. */
async function aiToggle(
  request: APIRequestContext,
  conversationId: string,
  body: Record<string, unknown>,
) {
  const resp = await request.post(`/api/external/v1/conversations/${conversationId}/ai`, {
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    data: body,
  });
  return resp;
}

async function readConvo(id: string) {
  return db().conversation.findUniqueOrThrow({
    where: { id },
    select: { aiEnabled: true, assignedUserId: true, status: true },
  });
}

test.describe("AI customer-handoff policy", () => {
  test.beforeAll(async () => {
    const sa = await superadminTeam();
    teamId = sa.teamId;
    const key = newApiKey();
    const row = await db().teamApiKey.create({
      data: {
        teamId,
        name: `e2e-handoff-${Date.now()}`,
        tokenHash: key.tokenHash,
        tokenPrefix: key.tokenPrefix,
        scopes: ["*"],
        createdById: sa.userId,
      },
      select: { id: true },
    });
    apiKeyId = row.id;
    apiToken = key.token;
    agentA = await makeAgent("A");
    agentB = await makeAgent("B");
  });

  test.afterAll(async () => {
    // Reset team AI settings + clean up the rows we created.
    await db().team.update({
      where: { id: teamId },
      data: { aiHandoffAction: "none", aiHandoffAssigneeId: null, aiRoundRobinCursorUserId: null },
    });
    await db().teamApiKey.deleteMany({ where: { id: apiKeyId } });
    // Remove the conversations + contacts + agents this spec created so the
    // team is restored to its pre-test row set (children before parents).
    await db().conversation.deleteMany({ where: { id: { in: createdConvoIds } } });
    await db().contact.deleteMany({ where: { id: { in: createdContactIds } } });
    await db().user.deleteMany({ where: { id: { in: createdUserIds } } });
  });

  test("action=none → AI pauses, assignee untouched", async ({ request }) => {
    await setHandoff("none", null);
    const id = await makeConversation({ aiEnabled: true, assignedUserId: agentA });
    const resp = await aiToggle(request, id, { aiEnabled: false, silent: true });
    expect(resp.ok()).toBeTruthy();
    const c = await pollUntil(async () => {
      const x = await readConvo(id);
      return x.aiEnabled === false ? x : null;
    }, { label: "ai paused (none)" });
    expect(c.assignedUserId).toBe(agentA); // unchanged
  });

  test("action=unassign → AI pauses + assignee cleared", async ({ request }) => {
    await setHandoff("unassign", null);
    const id = await makeConversation({ aiEnabled: true, assignedUserId: agentA });
    const resp = await aiToggle(request, id, { aiEnabled: false, silent: true });
    expect(resp.ok()).toBeTruthy();
    const c = await pollUntil(async () => {
      const x = await readConvo(id);
      return x.aiEnabled === false && x.assignedUserId === null ? x : null;
    }, { label: "unassigned on handoff" });
    expect(c.assignedUserId).toBeNull();
  });

  test("action=assign_fixed → AI pauses + assigned to the fixed member", async ({ request }) => {
    await setHandoff("assign_fixed", agentB);
    const id = await makeConversation({ aiEnabled: true, assignedUserId: null });
    const resp = await aiToggle(request, id, { aiEnabled: false, silent: true });
    expect(resp.ok()).toBeTruthy();
    const c = await pollUntil(async () => {
      const x = await readConvo(id);
      return x.assignedUserId === agentB ? x : null;
    }, { label: "assigned to fixed member" });
    expect(c.aiEnabled).toBe(false);
  });

  test("action=assign_fixed with a DEACTIVATED member → falls back to unassigned, AI still paused", async ({ request }) => {
    // Configure the fixed assignee, THEN deactivate them (the assignee went
    // inactive after being configured — bypasses the settings-route guard on
    // purpose to simulate the drift). Handoff must not fail; it leaves the
    // thread unassigned for triage.
    await setHandoff("assign_fixed", agentB);
    await db().user.update({ where: { id: agentB }, data: { deactivatedAt: new Date() } });
    try {
      const id = await makeConversation({ aiEnabled: true, assignedUserId: null });
      const resp = await aiToggle(request, id, { aiEnabled: false, silent: true });
      expect(resp.ok()).toBeTruthy();
      const c = await pollUntil(async () => {
        const x = await readConvo(id);
        return x.aiEnabled === false ? x : null;
      }, { label: "ai paused despite invalid assignee" });
      expect(c.assignedUserId).toBeNull(); // graceful fallback, not agentB
    } finally {
      await db().user.update({ where: { id: agentB }, data: { deactivatedAt: null } });
    }
  });

  test("action=round_robin → rotates across active agents", async ({ request }) => {
    await setHandoff("round_robin", null);
    // Reset the cursor so the rotation is deterministic within this test.
    await db().team.update({ where: { id: teamId }, data: { aiRoundRobinCursorUserId: null } });

    const id1 = await makeConversation({ aiEnabled: true });
    const r1 = await aiToggle(request, id1, { aiEnabled: false, silent: true });
    expect(r1.ok()).toBeTruthy();
    const c1 = await pollUntil(async () => {
      const x = await readConvo(id1);
      return x.assignedUserId ? x : null;
    }, { label: "round-robin pick #1" });

    const id2 = await makeConversation({ aiEnabled: true });
    const r2 = await aiToggle(request, id2, { aiEnabled: false, silent: true });
    expect(r2.ok()).toBeTruthy();
    const c2 = await pollUntil(async () => {
      const x = await readConvo(id2);
      return x.assignedUserId ? x : null;
    }, { label: "round-robin pick #2" });

    // Both picks are real active members…
    const active = await db().user.findMany({
      where: { teamId, deactivatedAt: null },
      select: { id: true },
    });
    const activeIds = active.map((u) => u.id);
    expect(activeIds).toContain(c1.assignedUserId!);
    expect(activeIds).toContain(c2.assignedUserId!);
    // …and the rotation advanced (different agents back-to-back). Holds because
    // the team has ≥2 active available members (we seeded A + B).
    expect(c1.assignedUserId).not.toBe(c2.assignedUserId);
  });

  test("applyHandoffPolicy:false → AI pauses but NO assignment (opt-out)", async ({ request }) => {
    await setHandoff("assign_fixed", agentA);
    const id = await makeConversation({ aiEnabled: true, assignedUserId: null });
    const resp = await aiToggle(request, id, { aiEnabled: false, silent: true, applyHandoffPolicy: false });
    expect(resp.ok()).toBeTruthy();
    const c = await pollUntil(async () => {
      const x = await readConvo(id);
      return x.aiEnabled === false ? x : null;
    }, { label: "ai paused (opt-out)" });
    expect(c.assignedUserId).toBeNull(); // policy skipped
  });

  test("aiEnabled:true (resume) never runs the handoff", async ({ request }) => {
    await setHandoff("assign_fixed", agentB);
    const id = await makeConversation({ aiEnabled: false, assignedUserId: null });
    const resp = await aiToggle(request, id, { aiEnabled: true, silent: true });
    expect(resp.ok()).toBeTruthy();
    const c = await pollUntil(async () => {
      const x = await readConvo(id);
      return x.aiEnabled === true ? x : null;
    }, { label: "ai resumed" });
    expect(c.assignedUserId).toBeNull(); // turning AI back on assigns nobody
  });

  test("already-paused (no change) does NOT re-assign / churn", async ({ request }) => {
    await setHandoff("assign_fixed", agentB);
    const id = await makeConversation({ aiEnabled: true, assignedUserId: null });
    // First pause → handoff assigns agentB.
    expect((await aiToggle(request, id, { aiEnabled: false, silent: true })).ok()).toBeTruthy();
    await pollUntil(async () => ((await readConvo(id)).assignedUserId === agentB ? true : null), {
      label: "first pause assigns agentB",
    });
    // A human takes over → reassign to agentA manually.
    await db().conversation.update({ where: { id }, data: { assignedUserId: agentA } });
    // Duplicate "human" message → AI already off → changed=false → must NOT
    // overwrite agentA back to agentB.
    expect((await aiToggle(request, id, { aiEnabled: false, silent: true })).ok()).toBeTruthy();
    await new Promise((r) => setTimeout(r, 600)); // give any (wrong) async assign a chance to land
    const c = await readConvo(id);
    expect(c.assignedUserId).toBe(agentA); // unchanged — idempotent on already-paused
  });
});
