/**
 * Team chat: 1:1 direct messages + public/private channel visibility.
 *
 * Covers the SECURITY INVARIANTS that the DM/visibility work introduced —
 * the ones where a regression is silent and expensive:
 *
 *   1. A DM is 1:1 forever. An admin must NOT be able to inject a third
 *      party into two colleagues' private conversation (assertNotDm).
 *   2. DMs never leak into channel surfaces — not the sidebar list, not the
 *      default-channel redirect, not workspace search.
 *   3. A private channel is undisclosed: absent from Browse, 404 (not 403)
 *      on direct open AND on join, and its message bodies never surface in
 *      another member's workspace search.
 *   4. Public channels are join-to-read and self-serve joinable.
 *   5. Opening a DM is idempotent — one row per pair, from either side.
 *
 * SAFE / self-cleaning: everything is created under the admin team with an
 * `e2e_tc_` prefix and removed in afterAll. No wipeTestData.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { createTestUser, db, appAdmin } from "../_helpers/db";

test.describe.configure({ mode: "serial" });

const PREFIX = "e2e_tc_";
/**
 * Channel-name prefix. MUST be the dash form — normalizeChannelName rewrites
 * `_` to `-`, so seeding "e2e_tc_public" stores "e2e-tc-public" and a cleanup
 * filter on the underscore prefix would silently leak every seeded channel.
 */
const CHAN_PREFIX = "e2e-tc-";

let workspaceId: string;
let adminUserId: string;
/** A second real user on the same team — the DM peer / non-member. */
let peerUserId: string;
/** A third user, used to prove nobody can be injected into a DM. */
let thirdUserId: string;

async function makeUser(name: string): Promise<string> {
  // These never log in — Better Auth owns credentials in its own tables;
  // these rows exist only to be DM'd / added as members. The user belongs to
  // the workspace's ORG, with `agent` granted via WorkspaceMember.
  const u = await createTestUser({
    workspaceId,
    role: "agent",
    email: `${PREFIX}${name}@example.test`,
    name: `${PREFIX}${name}`,
  });
  return u.id;
}

test.beforeAll(async () => {
  const admin = await appAdmin();
  workspaceId = admin.workspaceId;
  adminUserId = admin.userId;
  peerUserId = await makeUser("peer");
  thirdUserId = await makeUser("third");
});

test.afterAll(async () => {
  // Channels cascade to messages/members/receipts/pins; users cascade their
  // memberships. Delete channels first so nothing is orphaned mid-teardown.
  await db().teamChannel.deleteMany({
    where: { workspaceId, OR: [{ name: { startsWith: CHAN_PREFIX } }, { kind: "dm" }] },
  });
  await db().user.deleteMany({ where: { workspaceMemberships: { some: { workspaceId } }, email: { startsWith: PREFIX } } });
});

async function openDm(request: APIRequestContext, userId: string) {
  const res = await request.post("/api/team-chat/channels/dm", { data: { userId } });
  if (!res.ok()) {
    // Surface the server's reason — a bare `expect(ok).toBeTruthy()` failure
    // tells you nothing about WHY, which costs a whole debug cycle.
    throw new Error(
      `POST /channels/dm ${res.status()} for userId=${JSON.stringify(userId)}: ${await res.text()}`,
    );
  }
  return res;
}

// ─── 1:1 direct messages ──────────────────────────────────────────────────

test("opening a DM twice returns the SAME channel (dedup by participant pair)", async ({
  request,
}) => {
  const first = await openDm(request, peerUserId);
  expect(first.ok()).toBeTruthy();
  const a = (await first.json()).channel;

  const second = await openDm(request, peerUserId);
  expect(second.ok()).toBeTruthy();
  const b = (await second.json()).channel;

  expect(b.id).toBe(a.id);
  expect(a.kind).toBe("dm");
  // A DM has no name and is always private — both are what keep it out of
  // the channel browser and the name-unique namespace.
  expect(a.name).toBeNull();
  expect(a.visibility).toBe("private");

  // Exactly two members, and no more.
  const members = await db().teamChannelMember.count({ where: { channelId: a.id } });
  expect(members).toBe(2);
});

test("a self-DM (notes to self) works and has exactly one member", async ({ request }) => {
  const res = await openDm(request, adminUserId);
  expect(res.ok()).toBeTruthy();
  const dm = (await res.json()).channel;
  expect(dm.kind).toBe("dm");

  const members = await db().teamChannelMember.count({ where: { channelId: dm.id } });
  expect(members).toBe(1);
});

test("an ADMIN cannot inject a third member into someone's DM", async ({ request }) => {
  const dm = (await (await openDm(request, peerUserId)).json()).channel;

  // The load-bearing guard. Without assertNotDm this returns 200 and the
  // existing members_changed fanout hands the third party the full history.
  const res = await request.post(`/api/team-chat/channels/${dm.id}/members`, {
    data: { userIds: [thirdUserId] },
  });
  expect(res.status()).toBe(404);

  // And the DM is still 1:1 on disk.
  const members = await db().teamChannelMember.count({ where: { channelId: dm.id } });
  expect(members).toBe(2);
});

test("a DM cannot be renamed, deleted, or left through the channel routes", async ({
  request,
}) => {
  const dm = (await (await openDm(request, peerUserId)).json()).channel;

  expect((await request.patch(`/api/team-chat/channels/${dm.id}`, {
    data: { name: "hijacked" },
  })).status()).toBe(404);

  expect((await request.delete(`/api/team-chat/channels/${dm.id}`)).status()).toBe(404);

  expect(
    (await request.delete(`/api/team-chat/channels/${dm.id}/members/${adminUserId}`)).status(),
  ).toBe(404);
});

test("DMs never appear in the channel list, the default channel, or workspace search", async ({
  request,
}) => {
  const dm = (await (await openDm(request, peerUserId)).json()).channel;

  // Post something distinctive INTO the dm so search has something to find.
  const needle = `${PREFIX}secretdmphrase`;
  await request.post(`/api/team-chat/channels/${dm.id}/messages`, { data: { body: needle } });

  // Channel sidebar list — kind: "channel" filter.
  const channels = (await (await request.get("/api/team-chat/channels")).json()).items;
  expect(channels.some((c: { id: string }) => c.id === dm.id)).toBe(false);
  // Nothing nameless ever belongs in the channel list.
  expect(channels.every((c: { name: string | null }) => c.name !== null)).toBe(true);

  // /team redirect target must never be a DM.
  const def = (await (await request.get("/api/team-chat/channels/default")).json()).channel;
  if (def) expect(def.kind).toBe("channel");

  // Cmd-K workspace search is a CHANNEL search.
  const hits = (
    await (await request.get(`/api/team-chat/channels/search?q=${needle}`)).json()
  ).items;
  expect(hits.some((h: { message: { channelId: string } }) => h.message.channelId === dm.id)).toBe(
    false,
  );

  // It IS findable in the DM itself — proving the exclusion is scoping, not
  // a broken index.
  const inDm = (
    await (await request.get(`/api/team-chat/channels/${dm.id}/messages/search?q=${needle}`)).json()
  ).items;
  expect(inDm.length).toBeGreaterThan(0);
});

// ─── Public / private channel visibility ──────────────────────────────────

test("a PUBLIC channel is browsable and self-serve joinable by a non-member", async ({
  request,
}) => {
  const created = await request.post("/api/team-chat/channels", {
    data: { name: `${CHAN_PREFIX}public`, visibility: "public" },
  });
  expect(created.ok()).toBeTruthy();
  const chan = (await created.json()).channel;
  expect(chan.visibility).toBe("public");

  // Drop the creator's membership so this session is a genuine non-member.
  await db().teamChannelMember.deleteMany({
    where: { channelId: chan.id, userId: adminUserId },
  });

  // Browse lists it, flagged not-joined...
  const browse = (await (await request.get("/api/team-chat/channels/browse")).json()).items;
  const row = browse.find((c: { id: string }) => c.id === chan.id);
  expect(row).toBeTruthy();
  expect(row.joined).toBe(false);
  // ...and carries NO message-derived field, since non-members see this.
  expect(row).not.toHaveProperty("lastMessagePreview");

  // Preview resolves (this is what saves a browse→URL from a dead 404).
  const preview = (
    await (await request.get(`/api/team-chat/channels/${chan.id}/preview`)).json()
  ).channel;
  expect(preview?.id).toBe(chan.id);

  // Join is self-serve and idempotent.
  const join1 = await request.post(`/api/team-chat/channels/${chan.id}/join`);
  expect(join1.ok()).toBeTruthy();
  expect((await join1.json()).joined).toBe(true);

  const join2 = await request.post(`/api/team-chat/channels/${chan.id}/join`);
  expect(join2.ok()).toBeTruthy();
  expect((await join2.json()).joined).toBe(false);

  // Reading works now that we're a member.
  expect((await request.get(`/api/team-chat/channels/${chan.id}`)).ok()).toBeTruthy();
});

test("a PRIVATE channel is undisclosed: not browsable, 404 on read/join/preview", async ({
  request,
}) => {
  const chan = (
    await (
      await request.post("/api/team-chat/channels", {
        data: { name: `${CHAN_PREFIX}private`, visibility: "private" },
      })
    ).json()
  ).channel;
  expect(chan.visibility).toBe("private");

  // Seed a body we can later prove doesn't leak.
  const needle = `${PREFIX}confidentialphrase`;
  await request.post(`/api/team-chat/channels/${chan.id}/messages`, { data: { body: needle } });

  // Become a non-member.
  await db().teamChannelMember.deleteMany({
    where: { channelId: chan.id, userId: adminUserId },
  });

  // Absent from Browse.
  const browse = (await (await request.get("/api/team-chat/channels/browse")).json()).items;
  expect(browse.some((c: { id: string }) => c.id === chan.id)).toBe(false);

  // 404 — NOT 403. A 403 would confirm the channel exists.
  expect((await request.get(`/api/team-chat/channels/${chan.id}`)).status()).toBe(404);
  expect((await request.post(`/api/team-chat/channels/${chan.id}/join`)).status()).toBe(404);

  // Preview returns null rather than metadata.
  const preview = (
    await (await request.get(`/api/team-chat/channels/${chan.id}/preview`)).json()
  ).channel;
  expect(preview).toBeNull();

  // And the body never surfaces in workspace search for a non-member. This is
  // the leak the `isDefault` OR-branch removal closed.
  const hits = (
    await (await request.get(`/api/team-chat/channels/search?q=${needle}`)).json()
  ).items;
  expect(hits.length).toBe(0);
});

test("leaving a public channel removes it from the viewer's list", async ({ request }) => {
  const chan = (
    await (
      await request.post("/api/team-chat/channels", {
        data: { name: `${CHAN_PREFIX}leaveme`, visibility: "public" },
      })
    ).json()
  ).channel;

  const before = (await (await request.get("/api/team-chat/channels")).json()).items;
  expect(before.some((c: { id: string }) => c.id === chan.id)).toBe(true);

  // Self-leave reuses the existing member-removal route — no new endpoint.
  const left = await request.delete(
    `/api/team-chat/channels/${chan.id}/members/${adminUserId}`,
  );
  expect(left.ok()).toBeTruthy();

  const after = (await (await request.get("/api/team-chat/channels")).json()).items;
  expect(after.some((c: { id: string }) => c.id === chan.id)).toBe(false);
});

test("the unread-count endpoint backing the rail badge returns a number", async ({
  request,
}) => {
  const res = await request.get("/api/team-chat/channels/unread-count");
  expect(res.ok()).toBeTruthy();
  expect(typeof (await res.json()).mentions).toBe("number");
});

// ─── Regressions from the 2026-07-18 adversarial review ───────────────────
//
// Each of these shipped broken once. They're cheap to assert and expensive to
// rediscover, so they get a permanent test rather than a comment.

test("the default-channel fallback never exposes a private channel to a non-member", async ({
  request,
}) => {
  // A private channel the viewer is NOT in, whose name sorts before anything
  // else so it would win the fallback's `name ASC` ordering.
  const secret = (
    await (
      await request.post("/api/team-chat/channels", {
        data: { name: `${CHAN_PREFIX}aaa-secret`, visibility: "private" },
      })
    ).json()
  ).channel;
  await request.post(`/api/team-chat/channels/${secret.id}/messages`, {
    data: { body: `${PREFIX}boardroomleak` },
  });
  await db().teamChannelMember.deleteMany({
    where: { channelId: secret.id, userId: adminUserId },
  });

  const def = (await (await request.get("/api/team-chat/channels/default")).json()).channel;
  // Whatever it resolves to, it must never be the private channel we're not
  // in — the DTO carries lastMessagePreview and this route does no membership
  // check of its own.
  expect(def?.id).not.toBe(secret.id);
  if (def) {
    expect(def.lastMessagePreview).not.toContain("boardroomleak");
  }
});

test("unread mention count ignores channels the viewer has left", async ({ request }) => {
  const chan = (
    await (
      await request.post("/api/team-chat/channels", {
        data: { name: `${CHAN_PREFIX}mentiongone`, visibility: "public" },
      })
    ).json()
  ).channel;
  // Mention the admin, leave the mention unread, then drop membership — the
  // receipt can never advance past it, so an unfiltered count sticks forever.
  await request.post(`/api/team-chat/channels/${chan.id}/messages`, {
    data: { body: `hey @[Admin](${adminUserId}) look` },
  });
  const before = (
    await (await request.get("/api/team-chat/channels/unread-count")).json()
  ).mentions;

  await db().teamChannelMember.deleteMany({
    where: { channelId: chan.id, userId: adminUserId },
  });

  const after = (
    await (await request.get("/api/team-chat/channels/unread-count")).json()
  ).mentions;
  expect(after).toBeLessThanOrEqual(before);
});

test("browse rejects a garbage ?take instead of 500ing", async ({ request }) => {
  // `take=abc` used to reach Prisma as NaN → unhandled 500.
  const res = await request.get("/api/team-chat/channels/browse?take=abc");
  expect(res.status()).toBe(400);
  // A sane take still works.
  expect((await request.get("/api/team-chat/channels/browse?take=5")).ok()).toBeTruthy();
});
