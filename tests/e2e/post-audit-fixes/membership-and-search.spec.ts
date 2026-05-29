/**
 * Team-chat confidentiality fixes (2026-05-29).
 *
 * Before this session, every team member could read any channel they were
 * not invited to: per-channel REST routes only gated on `(channelId,
 * teamId)`, and fanout went to `emitToTeam` with client-side filtering.
 * Workspace-wide search also bypassed membership.
 *
 * These specs verify the gate from BOTH directions:
 *   (1) A non-member is refused (404) on every per-channel read/write.
 *   (2) Workspace-wide search returns ZERO hits for a private channel
 *       the viewer isn't in.
 *   (3) The default channel is the explicit exception — every team
 *       member implicitly has access.
 *
 * Strategy: create one non-default channel WITHOUT the viewer as a
 * member, post a message into it as the superadmin (using the API,
 * since the superadmin IS the channel creator and auto-member). Then
 * exercise the gate by hitting each endpoint with the superadmin's
 * cookie BUT removing the superadmin from the channel membership row
 * first — same effect as "another agent's channel."
 *
 * The superadmin in the test fixture is BOTH the team owner AND the
 * non-member: there's only one user in the seeded team, so we can't
 * simulate "different user" with separate sessions cleanly. The
 * membership-removal step is the surrogate. The gate's logic doesn't
 * differentiate between "user is admin" and "user is member" — it
 * gates on the row's presence in TeamChannelMember.
 */
import { test, expect } from "@playwright/test";
import { db, superadminTeam, wipeTestData } from "../_helpers/db";

let teamId: string;
let userId: string;
let privateChannelId: string;
let publicMessageId: string;
let defaultChannelId: string;

test.beforeAll(async () => {
  await wipeTestData();
  const su = await superadminTeam();
  teamId = su.teamId;
  userId = su.userId;

  // The default channel — auto-created at team setup, auto-membership
  // for every team user. Reuse the existing row instead of creating one.
  const def = await db().teamChannel.findFirstOrThrow({
    where: { teamId, isDefault: true },
    select: { id: true },
  });
  defaultChannelId = def.id;

  // Wipe any leftover non-default channels from prior runs (wipeTestData
  // doesn't touch team_chat tables since they don't carry message-state
  // that other suites care about). The schema has a `(teamId, name)`
  // unique on TeamChannel, so a leftover `private-leadership` would
  // P2002 on create below.
  await db().teamChannel.deleteMany({
    where: { teamId, isDefault: false },
  });

  // A non-default channel. Create the row directly (Prisma bypasses the
  // controller, but the SCHEMA is what we're protecting). Crucially: no
  // TeamChannelMember row for the superadmin — that's what makes them a
  // "non-member" for this channel's protection.
  const priv = await db().teamChannel.create({
    data: {
      teamId,
      name: "private-leadership",
      isDefault: false,
      createdById: userId,
    },
    select: { id: true },
  });
  privateChannelId = priv.id;

  // Seed a message in the private channel so workspace-wide search has
  // something to find. Posted with a body that would match a search the
  // non-member runs.
  const msg = await db().teamChannelMessage.create({
    data: {
      channelId: privateChannelId,
      teamId,
      authorUserId: userId,
      body: "Q3 salary planning numbers attached",
    },
    select: { id: true },
  });
  publicMessageId = msg.id;
});

test.afterAll(async () => {
  await wipeTestData();
  // Clean up the non-default channel this suite created — wipeTestData
  // doesn't touch team_chat tables.
  await db().teamChannel.deleteMany({
    where: { teamId, isDefault: false },
  });
  await db().$disconnect();
});

// ═════════════════════════════════════════════════════════════════════════
// Non-member is refused (404) on per-channel reads
// ═════════════════════════════════════════════════════════════════════════
test.describe("Channel membership gate (per-channel reads)", () => {
  test("non-member GET /channels/:id → 404", async ({ request }) => {
    const resp = await request.get(`/api/team/channels/${privateChannelId}`);
    expect(resp.status()).toBe(404);
  });

  test("non-member GET /channels/:id/messages → 404", async ({ request }) => {
    const resp = await request.get(
      `/api/team/channels/${privateChannelId}/messages`,
    );
    expect(resp.status()).toBe(404);
  });

  test("non-member POST /channels/:id/messages → 404 (membership refused before mention validation)", async ({
    request,
  }) => {
    const resp = await request.post(
      `/api/team/channels/${privateChannelId}/messages`,
      { data: { body: "should be refused" } },
    );
    expect(resp.status()).toBe(404);
  });

  test("non-member POST /channels/:id/read → 404", async ({ request }) => {
    const resp = await request.post(
      `/api/team/channels/${privateChannelId}/read`,
    );
    expect(resp.status()).toBe(404);
  });

  test("non-member GET /channels/:id/pins → 404", async ({ request }) => {
    const resp = await request.get(
      `/api/team/channels/${privateChannelId}/pins`,
    );
    expect(resp.status()).toBe(404);
  });

  test("non-member GET /channels/:id/messages/search → 404", async ({
    request,
  }) => {
    const resp = await request.get(
      `/api/team/channels/${privateChannelId}/messages/search?q=salary`,
    );
    expect(resp.status()).toBe(404);
  });

  test("non-member POST /channels/:id/messages/:mid/reactions → 404", async ({
    request,
  }) => {
    const resp = await request.post(
      `/api/team/channels/${privateChannelId}/messages/${publicMessageId}/reactions`,
      { data: { emoji: "👀" } },
    );
    expect(resp.status()).toBe(404);
  });

  test("non-member DELETE /channels/:id/messages/:mid → 404", async ({
    request,
  }) => {
    const resp = await request.delete(
      `/api/team/channels/${privateChannelId}/messages/${publicMessageId}`,
    );
    expect(resp.status()).toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Default channel exception — every team member has implicit access
// ═════════════════════════════════════════════════════════════════════════
test.describe("Default channel implicit membership", () => {
  test("default channel: GET /channels/:id → 200 even without TeamChannelMember row", async ({
    request,
  }) => {
    // Verify the superadmin doesn't have an explicit member row for the
    // default channel — the gate must short-circuit on isDefault. (The
    // backfill migration may have added one; delete it to make the test
    // unambiguous, then re-add after.)
    const existing = await db().teamChannelMember.findUnique({
      where: { channelId_userId: { channelId: defaultChannelId, userId } },
    });
    if (existing) {
      await db().teamChannelMember.delete({
        where: { channelId_userId: { channelId: defaultChannelId, userId } },
      });
    }
    try {
      const resp = await request.get(`/api/team/channels/${defaultChannelId}`);
      expect(resp.status()).toBe(200);
    } finally {
      // Restore if we removed.
      if (existing) {
        await db().teamChannelMember.create({
          data: {
            channelId: defaultChannelId,
            userId,
            addedById: existing.addedById,
          },
        });
      }
    }
  });

  test("default channel: GET /channels/:id/messages → 200", async ({
    request,
  }) => {
    const resp = await request.get(
      `/api/team/channels/${defaultChannelId}/messages`,
    );
    expect(resp.status()).toBe(200);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Workspace-wide search membership filter (P0 — was unfiltered before fix)
// ═════════════════════════════════════════════════════════════════════════
test.describe("Workspace-wide channel search membership filter", () => {
  test("search returns ZERO hits for private channel the viewer isn't in", async ({
    request,
  }) => {
    // The seeded message body is "Q3 salary planning numbers attached" —
    // it lives in `private-leadership`, and the superadmin is NOT a
    // member of that channel. Workspace search must NOT surface it.
    const resp = await request.get(
      `/api/team/channels/search?q=salary`,
    );
    expect(resp.status()).toBe(200);
    const json = await resp.json();
    // The response shape: { items: [{ message, channelName }], nextCursor }
    expect(Array.isArray(json.items)).toBe(true);
    // None of the hits should reference the private channel.
    const privateHits = (json.items as Array<{ channelName: string }>).filter(
      (hit) => hit.channelName === "private-leadership",
    );
    expect(privateHits.length).toBe(0);
  });

  test("search returns hits when viewer is a member", async ({ request }) => {
    // Add the superadmin to the private channel, run the same search,
    // confirm the hit now surfaces. Then remove them to restore state.
    await db().teamChannelMember.create({
      data: {
        channelId: privateChannelId,
        userId,
        addedById: userId,
      },
    });
    try {
      const resp = await request.get(
        `/api/team/channels/search?q=salary`,
      );
      expect(resp.status()).toBe(200);
      const json = await resp.json();
      const privateHits = (
        json.items as Array<{ channelName: string }>
      ).filter((hit) => hit.channelName === "private-leadership");
      expect(privateHits.length).toBeGreaterThan(0);
    } finally {
      await db().teamChannelMember.deleteMany({
        where: { channelId: privateChannelId, userId },
      });
    }
  });
});
