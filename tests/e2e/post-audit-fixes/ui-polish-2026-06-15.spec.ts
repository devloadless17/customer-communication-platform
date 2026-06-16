import { test, expect, type Page, type ConsoleMessage } from "@playwright/test";

import { db, superadminTeam } from "../_helpers/db";

/**
 * Positive e2e for the 2026-06-15 UI/UX polish waves. Runs against the
 * prod-imitate build (see playwright.config.ts) so the real server/client
 * boundaries are exercised.
 *
 * NON-DESTRUCTIVE on purpose: unlike the other post-audit specs this does NOT
 * call wipeTestData() (that unscoped-deletes the whole DB, which is fine on a
 * throwaway CI DB but would nuke a populated dev DB). It seeds ONE contact +
 * conversation + message under a unique phone and removes only those in
 * afterAll, so it can run safely against a dev DB with real data.
 *
 * Verifies the headline changes: the inbox list + contact panel mount clean
 * (the New-conversation compose icon and the panel Assignee/Stage sections were
 * later removed by request — those controls live in the thread header), the
 * signed-in /login bounce, and that the swept surfaces
 * (Switch/EmptyState/live-region/SSR-template work)
 * still mount with zero console/page/5xx errors in a real build.
 */

const KNOWN_NOISE = [
  "useInsertionEffect must not schedule updates",
  "cannot have a negative time stamp",
  "Download the React DevTools",
  "ERR_SSL_PROTOCOL_ERROR",
];

function track(page: Page): string[] {
  const errs: string[] = [];
  page.on("console", (m: ConsoleMessage) => {
    if (m.type() === "error" && !KNOWN_NOISE.some((n) => m.text().includes(n))) {
      errs.push(`console: ${m.text()}`);
    }
  });
  page.on("pageerror", (e) => {
    if (!KNOWN_NOISE.some((n) => e.message.includes(n))) {
      errs.push(`pageerror: ${e.message}`);
    }
  });
  page.on("response", (r) => {
    if (r.status() >= 500) errs.push(`5xx ${r.request().method()} ${r.url()}`);
  });
  return errs;
}

const PHONE = "+15550777013";
let teamId: string;
let contactId: string;
let conversationId: string;

test.beforeAll(async () => {
  teamId = (await superadminTeam()).teamId;
  const now = Date.now();
  // Idempotent: clear any leftover from a prior run of THIS spec (by its unique
  // phone) without touching anything else.
  await db().message.deleteMany({
    where: { conversation: { contact: { phoneNumber: PHONE } } },
  });
  await db().conversation.deleteMany({ where: { contact: { phoneNumber: PHONE } } });
  await db().contact.deleteMany({ where: { phoneNumber: PHONE } });

  const contact = await db().contact.create({
    data: {
      teamId,
      phoneNumber: PHONE,
      identityChannel: "whatsapp",
      name: "UI Polish E2E",
      source: "manual",
      lastInboundAt: new Date(now),
    },
  });
  contactId = contact.id;
  const conv = await db().conversation.create({
    data: {
      teamId,
      contactId: contact.id,
      channel: "whatsapp",
      status: "open",
      lastMessageAt: new Date(now),
      lastMessagePreview: "hi from the customer",
    },
  });
  conversationId = conv.id;
  await db().message.create({
    data: {
      teamId,
      conversationId,
      externalId: `ui-polish-${now}`,
      direction: "in",
      channel: "whatsapp",
      status: "delivered",
      body: "hi from the customer",
      timestamp: new Date(now),
      rawPayload: {},
    },
  });
});

test.afterAll(async () => {
  await db().message.deleteMany({ where: { conversationId } });
  await db().conversation.deleteMany({ where: { id: conversationId } });
  await db().contact.deleteMany({ where: { id: contactId } });
});

test("signed-in user hitting /login is bounced to /inbox", async ({ page }) => {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/\/inbox/, { timeout: 15_000 });
  expect(page.url()).toMatch(/\/inbox/);
});

test("inbox list mounts clean — New-conversation compose icon removed", async ({
  page,
}) => {
  const errs = track(page);
  await page.goto("/inbox", { waitUntil: "domcontentloaded" });
  // The list header renders (search box). The "New conversation" compose icon
  // was intentionally removed (useless feature), so it must NOT be present.
  await expect(page.getByPlaceholder(/Search contacts/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "New conversation" })).toHaveCount(0);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  expect(errs, "/inbox console/page/5xx").toEqual([]);
});

test("contact panel mounts clean — Assignee/Stage sections removed (they live in the thread header)", async ({
  page,
}) => {
  const errs = track(page);
  await page.goto(`/inbox?c=${conversationId}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-entry-kind]").first()).toBeVisible({
    timeout: 15_000,
  });
  // The redundant Assignee + Stage sections were removed from the right panel
  // (those controls live in the thread header now). The panel still renders its
  // remaining sections — assert the contact identity shows + the view is clean.
  await expect(page.getByText("UI Polish E2E").first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(400);
  expect(errs, "thread console/page/5xx").toEqual([]);
});

test.describe("swept surfaces stay clean in a real build", () => {
  for (const path of [
    "/settings/notifications", // Switch primitive
    "/settings/permissions", // Switch + sticky matrix
    "/contacts", // live regions + EmptyState
    "/broadcasts/new", // SSR-seeded templates
  ]) {
    test(`page ${path} renders without errors`, async ({ page }) => {
      const errs = track(page);
      const resp = await page.goto(path, { waitUntil: "domcontentloaded" });
      expect(resp?.status(), `${path} status`).toBeLessThan(400);
      await page
        .waitForLoadState("networkidle", { timeout: 12_000 })
        .catch(() => undefined);
      expect(errs, `${path} console/page/5xx`).toEqual([]);
    });
  }
});
