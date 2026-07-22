import { test, expect } from "@playwright/test";

import { db, APP_ADMIN_EMAIL } from "../_helpers/db";

const AUTH = "tests/e2e/.auth/app-admin.json";

/**
 * Verifies the team-chat channel-feed reconnect convergence fix
 * (audit finding state-management-1). A socket drop longer than Socket.io's
 * connection-state-recovery window, during which a teammate EDITS a message
 * that's already loaded in the feed, must converge on reconnect. The delta
 * backfill (`?after=<latest loaded createdAt>`) CANNOT carry that edit (the
 * message's createdAt is <= the loaded tail), so this exercises the new
 * `recoverOnReconnect` full-page refetch specifically — not the delta path.
 */
test.describe("Team-chat reconnect convergence (state-management-1)", () => {
  test("edit to a loaded message converges on reconnect (delta backfill can't)", async ({
    browser,
  }) => {
    const prisma = db();
    // Look up the BROWSING identity (the app-admin the AUTH storageState points
    // at), NOT the superadmin — it must be a member of the channel under test.
    const user = await prisma.user.findFirst({
      where: { email: APP_ADMIN_EMAIL },
      select: {
        id: true,
        workspaceMemberships: { select: { workspaceId: true }, orderBy: { createdAt: "asc" }, take: 1 },
      },
    });
    if (!user) throw new Error("e2e app-admin not seeded");

    const stamp = Date.now();
    const OLD = `E2E-reconnect-OLD-${stamp}`;
    const NEW = `E2E-reconnect-NEW-${stamp}`;

    // Use a DEDICATED channel, NOT the shared default "general". Other suites
    // post MEDIA to general; in dev those media URLs 404 and render as fixed-
    // height skeletons that throw off the feed's scroll-to-bottom, so a freshly
    // appended tail message may never paint — making this spec's PRECONDITION
    // (the OLD body is loaded) flaky. An isolated, empty channel keeps it
    // deterministic. Reconnect convergence itself is channel-agnostic.
    const channel = await prisma.teamChannel.create({
      data: {
        workspaceId: user.workspaceMemberships[0]!.workspaceId,
        name: `e2e-reconnect-${stamp}`,
        isDefault: false,
        createdById: user.id,
      },
      select: { id: true },
    });
    // Non-default channels are members-only (listChannelsForUser filters on
    // membership) — the browsing user must be a member to load the feed.
    await prisma.teamChannelMember.create({
      data: { channelId: channel.id, userId: user.id, addedById: user.id },
    });
    const msg = await prisma.teamChannelMessage.create({
      data: {
        channelId: channel.id,
        workspaceId: user.workspaceMemberships[0]!.workspaceId,
        authorUserId: user.id,
        body: OLD,
      },
      select: { id: true },
    });

    const ctxB = await browser.newContext({ storageState: AUTH });
    try {
      const pageB = await ctxB.newPage();
      await pageB.goto(`/team/${channel.id}`, { waitUntil: "domcontentloaded" });
      // The OLD body must be loaded into the live feed before we drop the socket.
      await expect(pageB.locator(`text=${OLD}`).first()).toBeVisible({
        timeout: 15_000,
      });
      await pageB.waitForTimeout(800); // socket subscribe settle

      // Force a REAL disconnect via the socket handle. (Playwright's
      // context.setOffline does NOT reliably close an already-open WebSocket,
      // so it can't exercise the `connect`-driven reconnect path.) The socket
      // stays down while we mutate, so the edit is NOT delivered as a live frame.
      await pageB.evaluate(() => {
        (
          window as unknown as { __ccpSocket?: { disconnect: () => void } }
        ).__ccpSocket?.disconnect();
      });
      await pageB.waitForTimeout(500);

      // Edit the ALREADY-LOADED message while B is disconnected. createdAt is
      // unchanged, so a delta `?after=` backfill would skip it — only the
      // reconnect full-refetch (recoverOnReconnect) can surface this.
      await prisma.teamChannelMessage.update({
        where: { id: msg.id },
        data: { body: NEW, editedAt: new Date() },
      });

      // Reconnect → `connect` fires → recoverOnReconnect refetches + replaces.
      await pageB.evaluate(() => {
        (
          window as unknown as { __ccpSocket?: { connect: () => void } }
        ).__ccpSocket?.connect();
      });

      // The edited body must converge; the stale body must be gone.
      await expect(pageB.locator(`text=${NEW}`).first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(pageB.locator(`text=${OLD}`)).toHaveCount(0);
    } finally {
      await ctxB.close();
      // Deleting the channel cascades its messages + memberships (onDelete:
      // Cascade on both relations), fully cleaning up the isolated fixture.
      await prisma.teamChannel
        .delete({ where: { id: channel.id } })
        .catch(() => undefined);
    }
  });
});
