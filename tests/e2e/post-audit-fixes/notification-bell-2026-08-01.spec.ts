import { expect, test } from "@playwright/test";

import { E2E_APP_WS_ID, appAdmin, db } from "../_helpers/db";

/**
 * The notification bell, in a browser.
 *
 * The domain rules (who gets told, who never does, read state) are proven in
 * `apps/api/test/notifications.spec.ts` against a real database. What THIS
 * covers is the part no unit test can: that the bell renders in the rail, that
 * its panel actually appears — it lives in a PORTAL because the rail and the
 * section sub-sidebar are siblings, so a `z-50` inside the rail was painted
 * over by the ticket views and the button looked broken — and that reading
 * clears the badge through the real route.
 *
 * The row is seeded directly rather than driven through an assignment: this
 * spec is about the surface, and the app-admin is the only session available,
 * so any action they took would (correctly) notify nobody.
 *
 *   pnpm exec playwright test tests/e2e/post-audit-fixes/notification-bell-2026-08-01.spec.ts
 */
test("shows what landed, and reading it clears the badge", async ({ page, context }) => {
  const { userId } = await appAdmin();
  const stamp = Date.now();
  const summary = `assigned you a ticket ${stamp}`;

  const seeded = await db().notification.create({
    data: {
      workspaceId: E2E_APP_WS_ID,
      userId,
      kind: "ticket_assigned",
      actorName: "Bell Fixture",
      ticketNumber: 4242,
      ticketSubject: `Bell fixture ${stamp}`,
      summary,
    },
    select: { id: true },
  });

  try {
    await context.addCookies([
      { name: "app-rail-collapsed", value: "false", url: "http://localhost:3000" },
    ]);
    await page.goto("/tickets");

    // The badge counts unread, server-authoritative on mount.
    const bell = page.getByRole("button", { name: /Notifications \(\d+ unread\)/ });
    await expect(bell).toBeVisible({ timeout: 30_000 });

    await bell.click();
    // The panel must be VISIBLE, not merely in the DOM — the bug it replaced
    // was a panel that opened correctly and was covered by the sub-sidebar.
    const heading = page.getByRole("heading", { name: "Notifications" });
    await expect(heading).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(summary)).toBeVisible();
    await expect(page.getByText(`Bell fixture ${stamp}`)).toBeVisible();
    // `exact` because the SUBJECT ("Bell fixture …") matches case-insensitively
    // too — the actor is the <strong>, the subject the line beneath it.
    await expect(page.getByText("Bell Fixture", { exact: true })).toBeVisible();

    // Reading clears it, through the real route.
    await page.getByRole("button", { name: "Mark all read" }).click();
    await expect
      .poll(
        async () =>
          (await db().notification.findUnique({
            where: { id: seeded.id },
            select: { readAt: true },
          }))?.readAt !== null,
        { timeout: 10_000 },
      )
      .toBe(true);

    // ...and the badge goes with it.
    await page.reload();
    await expect(page.getByRole("button", { name: "Notifications", exact: true })).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await db()
      .notification.delete({ where: { id: seeded.id } })
      .catch(() => undefined);
  }
});
