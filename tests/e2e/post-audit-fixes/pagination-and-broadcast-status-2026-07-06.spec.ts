/**
 * Verifies the 2026-07-06 changes end-to-end:
 *   A. Contacts numbered pagination — offset backend + <Pagination> UI + the
 *      `paged` mode of useContactList + the SSR page-1 seed at 25/page.
 *   B. Calls numbered pagination — same <Pagination>, calls-service offset+count.
 *   C. Broadcast terminal status — an all-recipients-failed broadcast is stored
 *      `failed` (not `completed`), so it shows under the "Failed" filter and
 *      renders the red "All failed" badge; a `completed` one does NOT.
 *
 * Serial: each block wipes+seeds its own data, so they must not interleave.
 */
import { test, expect } from "@playwright/test";
import { db, appAdmin, wipeTestData } from "../_helpers/db";

test.describe.configure({ mode: "serial" });

let workspaceId: string;

test.beforeAll(async () => {
  const su = await appAdmin();
  workspaceId = su.workspaceId;
});

test.afterAll(async () => {
  // Purge by prefix (not just tracked ids) so a killed mid-run can't leave
  // orphan e2e_* broadcasts behind — wipeTestData doesn't cover broadcasts.
  const seeded = await db().broadcast.findMany({
    where: { templateName: { startsWith: "e2e_" } },
    select: { id: true },
  });
  if (seeded.length) {
    const ids = seeded.map((b) => b.id);
    await db().broadcastRecipient.deleteMany({ where: { broadcastId: { in: ids } } });
    await db().broadcast.deleteMany({ where: { id: { in: ids } } });
  }
  await wipeTestData();
  await db().$disconnect();
});

test.describe("A. Contacts numbered pagination", () => {
  test.beforeAll(async () => {
    await wipeTestData();
    await db().contact.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({
        workspaceId,
        phoneNumber: `+1555010${String(1000 + i)}`,
        identityChannel: "whatsapp" as const,
        name: `Pageus Contact ${String(i).padStart(2, "0")}`,
        source: "manual" as const,
      })),
    });
  });

  test("page 1 shows 25 of 30; Next advances to 26–30", async ({ page }) => {
    await page.goto("/contacts");

    // The range summary proves the offset backend + count + UI all agree.
    await expect(page.getByText(/1[–-]25 of 30/)).toBeVisible({ timeout: 30_000 });
    // Exactly one page's worth of rows (each contact row carries a
    // "Select <name>" checkbox; the select-all row's label differs).
    await expect(
      page.locator('[aria-label^="Select Pageus Contact"]'),
    ).toHaveCount(25);

    await page.getByRole("button", { name: "Next page" }).click();

    await expect(page.getByText(/26[–-]30 of 30/)).toBeVisible();
    await expect(
      page.locator('[aria-label^="Select Pageus Contact"]'),
    ).toHaveCount(5);
  });
});

test.describe("B. Calls numbered pagination", () => {
  test.beforeAll(async () => {
    await wipeTestData();
    const contact = await db().contact.create({
      data: {
        workspaceId,
        phoneNumber: "+15559990000",
        identityChannel: "whatsapp",
        name: "Calls Pager",
        source: "manual",
      },
      select: { id: true },
    });
    const conv = await db().conversation.create({
      data: { workspaceId, contactId: contact.id, channel: "whatsapp", status: "open" },
      select: { id: true },
    });
    const base = Date.parse("2026-06-01T12:00:00Z");
    await db().call.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({
        workspaceId,
        conversationId: conv.id,
        externalCallId: `e2e-page-call-${i}`,
        direction: "in" as const,
        status: "missed" as const,
        ringingAt: new Date(base - i * 60_000),
        rawPayload: {},
      })),
    });
  });

  test("page 1 shows 25 of 30; Next advances to 26–30", async ({ page }) => {
    // Calls history is a filter INSIDE the inbox (kind:"calls"), not a route.
    await page.goto("/inbox");
    await page.getByRole("button", { name: "Calls" }).first().click();

    await expect(page.getByText(/1[–-]25 of 30/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.getByText(/26[–-]30 of 30/)).toBeVisible();
  });
});

test.describe("C. Broadcast Failed filter + status", () => {
  test.beforeAll(async () => {
    // wipeTestData does NOT clear broadcasts, so purge any leftovers from prior
    // runs first — otherwise duplicate e2e_* rows accumulate and getByText
    // matches more than one.
    const stale = await db().broadcast.findMany({
      where: { templateName: { startsWith: "e2e_" } },
      select: { id: true },
    });
    if (stale.length) {
      const ids = stale.map((b) => b.id);
      await db().broadcastRecipient.deleteMany({ where: { broadcastId: { in: ids } } });
      await db().broadcast.deleteMany({ where: { id: { in: ids } } });
    }
    const mk = (
      name: string,
      status: "failed" | "completed",
      totalCount: number,
      failedCount: number,
      sentCount: number,
    ) =>
      db().broadcast.create({
        data: {
          workspaceId,
          templateName: name,
          templateId: `tpl_${name}`,
          templateLanguage: "en_US",
          variables: {},
          audienceMode: "all",
          status,
          totalCount,
          failedCount,
          sentCount,
        },
        select: { id: true },
      });
    // All recipients failed → stored `failed` (the fix). A partial/none-failed
    // run stays `completed`.
    await mk("e2e_all_failed_bcast", "failed", 2, 2, 0);
    await mk("e2e_completed_bcast", "completed", 1, 0, 1);
  });

  test("all-failed broadcast lives under Failed with an 'All failed' badge", async ({
    page,
  }) => {
    await page.goto("/broadcasts");

    // The browser renders each row in TWO responsive containers — a mobile
    // `<ul className="sm:hidden">` and the desktop table — so the name is in the
    // DOM twice; only the desktop one is visible at this viewport. Scope to
    // `:visible` so we assert against the shown row, not the hidden mobile copy.
    const failedRow = page.locator('a:visible', { hasText: "e2e_all_failed_bcast" });
    const completedRow = page.locator('a:visible', { hasText: "e2e_completed_bcast" });

    // Both present in the default "All" view.
    await expect(failedRow).toBeVisible({ timeout: 30_000 });
    await expect(completedRow).toBeVisible();

    // Filter to Failed → only the failed one remains, and its badge is red
    // "All failed" (count-aware: 2 recipients, all failed → stored `failed`).
    // exact — a failed broadcast also shows a "Retry N failed recipients" button
    // whose name substring-matches "Failed".
    await page.getByRole("button", { name: "Failed", exact: true }).click();

    await expect(failedRow).toBeVisible();
    await expect(page.locator('span:visible', { hasText: "All failed" })).toBeVisible();
    // The completed one is filtered out of BOTH containers entirely.
    await expect(page.getByText("e2e_completed_bcast")).toHaveCount(0);
  });
});

test.describe("D. Broadcasts numbered pagination", () => {
  test.beforeAll(async () => {
    // Exact count: the test DB owns all broadcast rows, so purge them all then
    // seed exactly 30 (spans 2 pages at 25/page).
    const all = await db().broadcast.findMany({ select: { id: true } });
    if (all.length) {
      const ids = all.map((b) => b.id);
      await db().broadcastRecipient.deleteMany({ where: { broadcastId: { in: ids } } });
      await db().broadcast.deleteMany({ where: { id: { in: ids } } });
    }
    const base = Date.parse("2026-06-01T12:00:00Z");
    await db().broadcast.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({
        workspaceId,
        templateName: `e2e_page_bcast_${String(i).padStart(2, "0")}`,
        templateId: `tpl_page_${i}`,
        templateLanguage: "en_US",
        variables: {},
        audienceMode: "all",
        status: "completed" as const,
        totalCount: 1,
        sentCount: 1,
        failedCount: 0,
        createdAt: new Date(base + i * 60_000),
      })),
    });
  });

  test("page 1 shows 25 of 30; Next advances to 26–30", async ({ page }) => {
    // Default view is the table + "All" filter, so /broadcasts shows page 1.
    await page.goto("/broadcasts");
    await expect(page.getByText(/1[–-]25 of 30/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.getByText(/26[–-]30 of 30/)).toBeVisible();
  });
});
