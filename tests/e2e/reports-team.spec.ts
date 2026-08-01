import { test, expect } from "@playwright/test";

import { appAdmin, db } from "./_helpers/db";

/**
 * The /reports/team surface, end-to-end in a real browser.
 *
 * The aggregate MATH is proven against a real database in
 * apps/api/test/reports-team.spec.ts — this spec covers what only a browser
 * can: the page renders behind the capability gate, the old settings URL
 * redirects, the controls actually interact (sort, custom range, CSV
 * download), the drill-down sheet opens, and the live strip paints. The
 * assertions are structural, not exact-count: the shared e2e workspace can
 * hold other specs' leftovers, and re-asserting sums here would just re-test
 * the vitest spec against dirtier data.
 *
 * Fixtures live in the e2e workspace; tickets + presence rows are
 * self-cleaned (wipeTestData doesn't cover them — the isolation canary
 * would flag a leak).
 */

const S = `rteam${Date.now().toString().slice(-7)}`;

let workspaceId = "";
let adminUserId = "";
let contactId = "";
let conversationId = "";

test.beforeAll(async () => {
  const admin = await appAdmin();
  workspaceId = admin.workspaceId;
  adminUserId = admin.userId;
  const d = db();

  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const halfHourAgo = new Date(Date.now() - 30 * 60 * 1000);

  const contact = await d.contact.create({
    data: {
      workspaceId,
      name: `Report Customer ${S}`,
      identityChannel: "whatsapp",
      phoneNumber: `9611${Date.now().toString().slice(-7)}`,
    },
    select: { id: true },
  });
  contactId = contact.id;

  // One closed, answered conversation carrying every per-agent signal.
  const conv = await d.conversation.create({
    data: {
      workspaceId,
      contactId,
      channel: "whatsapp",
      status: "closed",
      createdAt: hourAgo,
      firstResponseAt: halfHourAgo,
      firstResponseByUserId: adminUserId,
      closedAt: halfHourAgo,
      closedByUserId: adminUserId,
    },
    select: { id: true },
  });
  conversationId = conv.id;

  await d.message.createMany({
    data: [
      {
        workspaceId,
        conversationId,
        channel: "whatsapp" as const,
        externalId: `${S}_in`,
        body: "hello",
        direction: "in" as const,
        timestamp: hourAgo,
      },
      {
        workspaceId,
        conversationId,
        channel: "whatsapp" as const,
        externalId: `${S}_out`,
        body: "hi there",
        direction: "out" as const,
        timestamp: halfHourAgo,
        senderUserId: adminUserId,
      },
    ],
  });
  await d.conversationEvent.create({
    data: {
      workspaceId,
      conversationId,
      kind: "assigned",
      after: { assignedUserId: adminUserId },
      at: hourAgo,
    },
  });
  await d.call.create({
    data: {
      workspaceId,
      conversationId,
      externalCallId: `${S}_call`,
      rawPayload: {},
      direction: "in",
      status: "completed",
      answeredByUserId: adminUserId,
      ringingAt: hourAgo,
      answeredAt: new Date(hourAgo.getTime() + 5000),
      endedAt: new Date(hourAgo.getTime() + 125_000),
      durationSeconds: 120,
    },
  });
  await d.ticket.create({
    data: {
      workspaceId,
      conversationId,
      channel: "whatsapp",
      number: 970_000 + (Date.now() % 10_000),
      subject: `Report ticket ${S}`,
      createdAt: hourAgo,
      createdById: adminUserId,
      status: "solved",
      resolvedAt: halfHourAgo,
      resolvedById: adminUserId,
    },
  });
  const now = new Date();
  await d.agentPresenceDaily.upsert({
    where: {
      workspaceId_userId_date: {
        workspaceId,
        userId: adminUserId,
        date: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
      },
    },
    create: {
      workspaceId,
      userId: adminUserId,
      date: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
      onlineMinutes: 45,
    },
    update: { onlineMinutes: { increment: 45 } },
  });
});

test.afterAll(async () => {
  const d = db();
  // Self-clean, children first. Tickets + presence aren't in wipeTestData's
  // scope; the rest is deleted here anyway so this spec leaves zero residue.
  await d.ticket.deleteMany({ where: { workspaceId, subject: { contains: S } } });
  await d.agentPresenceDaily.deleteMany({ where: { workspaceId, userId: adminUserId } });
  if (conversationId) {
    await d.conversationEvent.deleteMany({ where: { conversationId } });
    await d.call.deleteMany({ where: { conversationId } });
    await d.message.deleteMany({ where: { conversationId } });
    await d.conversation.delete({ where: { id: conversationId } }).catch(() => {});
  }
  if (contactId) await d.contact.delete({ where: { id: contactId } }).catch(() => {});
});

test("the old settings URL redirects to /reports/team", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/settings/activity");
  await expect(page).toHaveURL(/\/reports\/team/, { timeout: 45_000 });
});

test("the page renders every section with live data", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/reports/team");

  // Section switcher + header.
  const nav = page.getByRole("navigation", { name: "Reports sections" });
  await expect(nav.getByRole("link", { name: "Overview" })).toBeVisible({ timeout: 45_000 });
  await expect(nav.getByRole("link", { name: "Team" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Team", exact: true })).toBeVisible();

  // Live strip paints from the RSC seed (no data wait).
  await expect(page.getByRole("heading", { name: "Right now" })).toBeVisible();

  // Headline tiles (loaded state — the skeleton has no text).
  await expect(page.getByText("Active agents")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Median first response")).toBeVisible();

  // Charts + heatmap + table shells.
  await expect(page.getByRole("heading", { name: "Team activity per day" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Leaderboard" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Busiest hours" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();

  // The seeded inbound gives the heatmap at least one populated cell.
  await expect(page.locator('[aria-label*="incoming"]').first()).toBeVisible();

  // Grouped table headers and the admin's row.
  const table = page.locator("table", { has: page.getByRole("columnheader", { name: "Median FRT" }) });
  for (const group of ["Conversations", "Messages", "Calls", "Tickets", "Time"]) {
    await expect(table.locator("thead").getByText(group, { exact: true })).toBeVisible();
  }
  await expect(
    table.getByRole("button", { name: "E2E Admin" }).first(),
  ).toBeVisible();
});

test("sorting, custom range, drill-down and CSV all interact", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/reports/team");
  const table = page.locator("table", { has: page.getByRole("columnheader", { name: "Median FRT" }) });
  await expect(table.getByRole("button", { name: "E2E Admin" }).first()).toBeVisible({
    timeout: 45_000,
  });

  // Sort: clicking a header marks it aria-sort; clicking again flips it.
  const closedHeader = table.getByRole("columnheader", { name: "Closed" });
  await closedHeader.getByRole("button").click();
  await expect(closedHeader).toHaveAttribute("aria-sort", "descending");
  await closedHeader.getByRole("button").click();
  await expect(closedHeader).toHaveAttribute("aria-sort", "ascending");

  // Custom range: the pill reveals two date inputs seeded from the current
  // window, and the report still renders (same window, now editable).
  await page.getByRole("radio", { name: "Custom" }).click();
  await expect(page.getByLabel("Report start date")).toBeVisible();
  await expect(page.getByLabel("Report end date")).toBeVisible();
  await expect(table.getByRole("button", { name: "E2E Admin" }).first()).toBeVisible({
    timeout: 30_000,
  });

  // Drill-down: row click opens the sheet with the agent's sections and the
  // lazily-fetched per-day chart section.
  await table.getByRole("button", { name: "E2E Admin" }).first().click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("heading", { name: /E2E Admin/ })).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "Conversations" })).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "Per day" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).not.toBeVisible();

  // CSV: the export button produces a named download.
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^team-report_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);
});

test("the overview links into the full team report", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible({
    timeout: 45_000,
  });
  await page.getByRole("link", { name: "View full team report" }).click();
  await expect(page).toHaveURL(/\/reports\/team/);
  await expect(page.getByRole("heading", { name: "Right now" })).toBeVisible();
});
