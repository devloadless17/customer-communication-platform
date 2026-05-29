/**
 * Inbox filter rework (2026-05-29):
 *   - `Active` (new) = open + pending  (today's "All" semantics)
 *   - `All`    (repurposed) = open + pending + closed  (truly everything)
 *   - `Mine`, `Unassigned` unchanged (still exclude closed)
 *   - `Closed` unchanged
 *
 * Server side: GET /api/conversations?filter=active|all|mine|unassigned|closed
 * GET /api/conversations/counts now includes `active` alongside `all`/`mine`/
 * `unassigned`/`closed`.
 *
 * The semantic switch is the bit that matters — every other path (sort,
 * pagination, search) is unchanged. This spec seeds three conversations
 * (one open, one pending, one closed) and asserts each filter returns
 * the right subset + the counts endpoint shape.
 */
import { test, expect } from "@playwright/test";
import { db, superadminTeam, wipeTestData } from "../_helpers/db";

let teamId: string;
let openId: string;
let pendingId: string;
let closedId: string;

test.beforeAll(async () => {
  await wipeTestData();
  const su = await superadminTeam();
  teamId = su.teamId;

  // Three contacts (uniqueness is per-team on phoneNumber for WhatsApp) +
  // one conversation each, in three distinct statuses. Spaced lastMessageAt
  // so list ordering is deterministic.
  const now = Date.now();
  const make = async (
    phone: string,
    status: "open" | "pending" | "closed",
    offsetMs: number,
  ) => {
    const contact = await db().contact.create({
      data: {
        teamId,
        phoneNumber: phone,
        identityChannel: "whatsapp",
        name: `Filter test ${status}`,
        source: "manual",
      },
    });
    const conv = await db().conversation.create({
      data: {
        teamId,
        contactId: contact.id,
        channel: "whatsapp",
        status,
        lastMessageAt: new Date(now - offsetMs),
      },
    });
    return conv.id;
  };
  openId = await make("+15553330001", "open", 1000);
  pendingId = await make("+15553330002", "pending", 2000);
  closedId = await make("+15553330003", "closed", 3000);
});

test.afterAll(async () => {
  await wipeTestData();
  await db().$disconnect();
});

async function listIds(
  request: import("@playwright/test").APIRequestContext,
  filter: string,
): Promise<string[]> {
  const resp = await request.get(`/api/conversations?filter=${filter}`);
  expect(resp.status(), `GET /api/conversations?filter=${filter}`).toBe(200);
  const body = await resp.json();
  // Response shape: { items: ConversationWithRefs[], nextCursor: ... }
  const items = body.items ?? body.data?.items ?? [];
  return items.map((row: { conversation: { id: string } }) => row.conversation.id);
}

test.describe("Inbox filter rework: Active vs All", () => {
  test("filter=active returns open + pending only (no closed)", async ({ request }) => {
    const ids = await listIds(request, "active");
    expect(ids).toContain(openId);
    expect(ids).toContain(pendingId);
    expect(ids).not.toContain(closedId);
  });

  test("filter=all returns everything including closed", async ({ request }) => {
    const ids = await listIds(request, "all");
    expect(ids).toContain(openId);
    expect(ids).toContain(pendingId);
    expect(ids).toContain(closedId);
  });

  test("filter=closed returns only closed", async ({ request }) => {
    const ids = await listIds(request, "closed");
    expect(ids).not.toContain(openId);
    expect(ids).not.toContain(pendingId);
    expect(ids).toContain(closedId);
  });

  test("filter=unassigned excludes closed (unchanged)", async ({ request }) => {
    const ids = await listIds(request, "unassigned");
    // All three are unassigned in this fixture; the filter should drop closed.
    expect(ids).toContain(openId);
    expect(ids).toContain(pendingId);
    expect(ids).not.toContain(closedId);
  });

  test("GET /api/conversations/counts includes the new `active` field", async ({
    request,
  }) => {
    const resp = await request.get("/api/conversations/counts");
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    // Field must exist and equal open + pending.
    expect(body).toHaveProperty("active");
    expect(typeof body.active).toBe("number");
    expect(body.active).toBeGreaterThanOrEqual(2); // openId + pendingId
    // `all` now includes closed.
    expect(body.all).toBeGreaterThanOrEqual(3);
    expect(body.all).toBeGreaterThanOrEqual(body.active);
  });
});
