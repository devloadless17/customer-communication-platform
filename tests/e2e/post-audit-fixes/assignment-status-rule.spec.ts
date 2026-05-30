/**
 * Assignment → status side-effect rule (audit 2026-05-30 pass 2, M7 + M3).
 *
 * The locked product rule (memory `project_assignment_status_rules`):
 * **assignment NEVER sets `open` — only the assignee chatting does.**
 *   - assign (user)  + closed  → pending   (reopen into triage)
 *   - assign (user)  + pending → unchanged (stays pending)
 *   - assign (user)  + open    → unchanged (stays open)
 *   - unassign (null)+ open    → pending   (back to triage)
 *   - everything else          → unchanged
 *
 * A divergent client copy in contact-panel.tsx had resurrected the removed
 * `assign → open` rule, producing a phantom "Open" badge + a false activity
 * pill that no server frame ever corrected (because the server, correctly,
 * publishes NOTHING on assign+pending). Both the header AssignmentDropdown and
 * the contact-panel picker now call one shared predictor
 * (features/inbox/lib/predict-status.ts) that mirrors this server rule.
 *
 * This spec pins the SERVER rule end-to-end — the source of truth the client
 * predictor must match. If the server rule ever changes, the shared predictor
 * (and its mirror doc on conversations.service.ts:assign) must change with it.
 */
import { test, expect } from "@playwright/test";
import { db, superadminTeam, wipeTestData } from "../_helpers/db";

let teamId: string;
let userId: string;

test.beforeAll(async () => {
  await wipeTestData();
  const su = await superadminTeam();
  teamId = su.teamId;
  userId = su.userId;
});

test.afterAll(async () => {
  await wipeTestData();
  await db().$disconnect();
});

let convSeq = 0;
async function makeConversation(
  status: "open" | "pending" | "closed",
  assignedUserId: string | null,
): Promise<string> {
  convSeq += 1;
  const contact = await db().contact.create({
    data: {
      teamId,
      phoneNumber: `+1555444${String(1000 + convSeq).slice(-4)}`,
      identityChannel: "whatsapp",
      name: `Assign rule ${status} ${convSeq}`,
      source: "manual",
    },
  });
  const conv = await db().conversation.create({
    data: {
      teamId,
      contactId: contact.id,
      channel: "whatsapp",
      status,
      assignedUserId,
      lastMessageAt: new Date(),
    },
  });
  return conv.id;
}

async function statusOf(id: string): Promise<string> {
  const row = await db().conversation.findUniqueOrThrow({
    where: { id },
    select: { status: true },
  });
  return row.status;
}

test.describe("Assignment → status side-effect (server rule = client predictor)", () => {
  test("assign a CLOSED conversation → reopens to pending (NOT open)", async ({
    request,
  }) => {
    const id = await makeConversation("closed", null);
    const resp = await request.post(`/api/conversations/${id}/assign`, {
      data: { assignedUserId: userId },
    });
    expect(resp.status()).toBe(200);
    // The bug would have produced "open" here. The rule says "pending".
    expect(await statusOf(id)).toBe("pending");
  });

  test("assign a PENDING conversation → stays pending (NOT open)", async ({
    request,
  }) => {
    const id = await makeConversation("pending", null);
    const resp = await request.post(`/api/conversations/${id}/assign`, {
      data: { assignedUserId: userId },
    });
    expect(resp.status()).toBe(200);
    // This is the case the old contact-panel optimistically (and wrongly)
    // flipped to "open" with a phantom pill the server never confirmed.
    expect(await statusOf(id)).toBe("pending");
  });

  test("assign an OPEN conversation → stays open", async ({ request }) => {
    const id = await makeConversation("open", null);
    const resp = await request.post(`/api/conversations/${id}/assign`, {
      data: { assignedUserId: userId },
    });
    expect(resp.status()).toBe(200);
    expect(await statusOf(id)).toBe("open");
  });

  test("unassign an OPEN conversation → drops to pending", async ({
    request,
  }) => {
    const id = await makeConversation("open", userId);
    const resp = await request.post(`/api/conversations/${id}/assign`, {
      data: { assignedUserId: null },
    });
    expect(resp.status()).toBe(200);
    expect(await statusOf(id)).toBe("pending");
  });

  test("unassign a PENDING conversation → stays pending", async ({
    request,
  }) => {
    const id = await makeConversation("pending", userId);
    const resp = await request.post(`/api/conversations/${id}/assign`, {
      data: { assignedUserId: null },
    });
    expect(resp.status()).toBe(200);
    expect(await statusOf(id)).toBe("pending");
  });

  test("unassign a CLOSED conversation → stays closed", async ({ request }) => {
    const id = await makeConversation("closed", userId);
    const resp = await request.post(`/api/conversations/${id}/assign`, {
      data: { assignedUserId: null },
    });
    expect(resp.status()).toBe(200);
    expect(await statusOf(id)).toBe("closed");
  });
});
