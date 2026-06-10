import { test, expect } from "@playwright/test";

import { db } from "../_helpers/db";

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
    const user = await prisma.user.findFirst({
      where: { email: "ali@loadless.ai" },
      select: { teamId: true, id: true },
    });
    if (!user) throw new Error("superadmin not seeded");
    const channel = await prisma.teamChannel.findFirst({
      where: { teamId: user.teamId },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (!channel) throw new Error("no channel for superadmin team");

    const stamp = Date.now();
    const OLD = `E2E-reconnect-OLD-${stamp}`;
    const NEW = `E2E-reconnect-NEW-${stamp}`;
    const msg = await prisma.teamChannelMessage.create({
      data: {
        channelId: channel.id,
        teamId: user.teamId,
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
      await prisma.teamChannelMessage
        .delete({ where: { id: msg.id } })
        .catch(() => undefined);
    }
  });
});
