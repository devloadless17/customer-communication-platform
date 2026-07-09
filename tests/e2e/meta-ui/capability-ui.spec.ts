/**
 * Capability-driven inbox UI for the Meta social channels. A conversation's
 * channel — not a hardcoded `if (whatsapp)` — must drive the composer
 * affordances. This opens seeded Messenger + Instagram threads in the REAL
 * inbox and asserts the channel-derived UI:
 *
 *   - the channel-aware reply placeholder ("Reply on Messenger/Instagram…"),
 *   - NO template button (templates:false for social),
 *   - the interactive "Send buttons" affordance IS present (quick replies work),
 *   - the correct channel badge in the thread.
 *
 * Runs in the MAIN suite (browser + app-admin session). It seeds into the
 * app-admin team and removes exactly what it seeded in afterEach — no global
 * wipe, so it's safe to run on its own.
 */

import { test, expect, type Page } from "@playwright/test";

import { db, appAdmin } from "../_helpers/db";

let seededContactIds: string[] = [];

test.afterEach(async () => {
  const d = db();
  if (seededContactIds.length) {
    await d.message.deleteMany({ where: { contact: { id: { in: seededContactIds } } } }).catch(() => {});
    await d.conversation.deleteMany({ where: { contactId: { in: seededContactIds } } });
    await d.contact.deleteMany({ where: { id: { in: seededContactIds } } });
  }
  seededContactIds = [];
});

async function seedThread(channel: "messenger" | "instagram"): Promise<string> {
  const { teamId } = await appAdmin();
  const contact = await db().contact.create({
    data: {
      teamId,
      name: `E2E ${channel} Cap`,
      identityChannel: channel,
      externalContactId: `cap_${channel}_${Date.now()}`,
      lastInboundAt: new Date(), // window OPEN → composer enabled
    },
    select: { id: true },
  });
  seededContactIds.push(contact.id);
  const convo = await db().conversation.create({
    data: {
      teamId,
      contactId: contact.id,
      channel,
      status: "open",
      lastMessagePreview: "hi",
    },
    select: { id: true },
  });
  await db().message.create({
    data: {
      teamId,
      conversationId: convo.id,
      channel,
      externalId: `cap_in_${channel}_${Date.now()}`,
      direction: "in",
      status: "delivered",
      body: "hi there",
      timestamp: new Date(),
    },
  });
  return convo.id;
}

async function openThread(page: Page, conversationId: string) {
  await page.goto(`/inbox?c=${conversationId}`, { waitUntil: "domcontentloaded" });
}

test("Messenger thread: channel-aware composer, no template button, interactive present", async ({
  page,
}) => {
  const conversationId = await seedThread("messenger");
  await openThread(page, conversationId);

  // Channel-aware placeholder — proves conversation.channel reaches the composer.
  await expect(page.getByPlaceholder(/Reply on Messenger/i)).toBeVisible();
  // Templates are WhatsApp-only → the button must be absent.
  await expect(page.getByRole("button", { name: "Send a template" })).toHaveCount(0);
  // Interactive quick-replies ARE supported on Messenger.
  await expect(page.getByRole("button", { name: "Send buttons" })).toBeVisible();
  // The Messenger channel mark renders in the thread.
  await expect(page.getByRole("img", { name: "Messenger" }).first()).toBeVisible();
});

test("Instagram thread: channel-aware composer, no template button", async ({ page }) => {
  const conversationId = await seedThread("instagram");
  await openThread(page, conversationId);

  await expect(page.getByPlaceholder(/Reply on Instagram/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Send a template" })).toHaveCount(0);
  await expect(page.getByRole("img", { name: "Instagram" }).first()).toBeVisible();
});
