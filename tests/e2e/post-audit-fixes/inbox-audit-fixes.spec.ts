import { test, expect, type Page } from "@playwright/test";

import { db, superadminTeam, wipeTestData } from "../_helpers/db";

/**
 * Verifies the inbox-audit fixes shipped 2026-06-09 that the existing suite
 * doesn't cover:
 *
 *   J — a failed inbound media download (empty body + no media columns)
 *       renders an "Attachment unavailable" placeholder, not a blank bubble.
 *   K — in-thread search shows the SERVER's true match total and loads past the
 *       old 100-match cap (paginates the cursor), so a common word in a long
 *       thread reads e.g. "1 of 110", not "1 of 100".
 *
 * Runs against the prod-imitate stack (see playwright.config.ts). Data is set up
 * via Prisma directly (the parser/Meta path isn't needed — a failed-media row is
 * just an inbound Message with empty body and null media columns, exactly what
 * meta.controller.ts leaves after a download fails).
 */

const PHONE = "+15550009999";
let workspaceId: string;
let conversationId: string;

async function openThread(page: Page): Promise<void> {
  await page.goto(`/inbox?c=${conversationId}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-entry-kind]").first()).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(500); // socket subscribe + gate reveal settle
}

test.beforeAll(async () => {
  const su = await superadminTeam();
  workspaceId = su.workspaceId;
  await wipeTestData();

  const now = Date.now();
  const contact = await db().contact.create({
    data: {
      workspaceId,
      phoneNumber: PHONE,
      identityChannel: "whatsapp",
      name: "Audit Fix Contact",
      source: "manual",
      lastInboundAt: new Date(now),
    },
  });
  const conv = await db().conversation.create({
    data: {
      workspaceId,
      contactId: contact.id,
      channel: "whatsapp",
      status: "open",
      lastMessageAt: new Date(now),
      lastMessagePreview: "needle",
    },
  });
  conversationId = conv.id;

  // (J) one normal text + one failed-media inbound (empty body, no media cols).
  await db().message.create({
    data: {
      workspaceId,
      conversationId,
      externalId: `audit-normal-${now}`,
      direction: "in",
      channel: "whatsapp",
      status: "delivered",
      body: "a perfectly normal message",
      timestamp: new Date(now - 2000),
      rawPayload: {},
    },
  });
  await db().message.create({
    data: {
      workspaceId,
      conversationId,
      externalId: `audit-failedmedia-${now}`,
      direction: "in",
      channel: "whatsapp",
      status: "delivered",
      body: "", // caption-less; media download failed → columns stripped
      timestamp: new Date(now - 1000),
      rawPayload: {},
    },
  });

  // (K) 110 inbound messages containing "needle" — past the old 100 cap.
  await db().message.createMany({
    data: Array.from({ length: 110 }, (_, i) => ({
      workspaceId,
      conversationId,
      externalId: `audit-needle-${now}-${i}`,
      direction: "in" as const,
      channel: "whatsapp" as const,
      status: "delivered" as const,
      body: `needle match number ${i}`,
      timestamp: new Date(now - 500_000 + i * 1000),
      rawPayload: {},
    })),
  });
});

test.afterAll(async () => {
  await wipeTestData();
  await db().$disconnect();
});

test.describe("Inbox audit fixes (2026-06-09)", () => {
  test("J: failed inbound media renders an 'Attachment unavailable' placeholder, not a blank bubble", async ({
    page,
  }) => {
    await openThread(page);
    // Exactly one placeholder (the failed-media row); the normal text message
    // must NOT trigger it.
    await expect(page.getByText("Attachment unavailable")).toHaveCount(1);
    await expect(page.getByText("a perfectly normal message")).toBeVisible();
  });

  test("K: in-thread search shows the real total (>100) and loads past the old 100 cap", async ({
    page,
  }) => {
    await openThread(page);
    await page.getByRole("button", { name: "Search this conversation" }).click();
    await page.getByPlaceholder(/Search messages/i).fill("needle");
    // Debounced fetch (200ms) + cursor pagination of all pages. The count span
    // reads "{n} of {total}" — assert the TRUE total, which the old single
    // take=100 request capped at 100.
    await expect(page.getByText(/of\s+110\b/)).toBeVisible({ timeout: 15_000 });
  });
});
