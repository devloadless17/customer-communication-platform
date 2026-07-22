/**
 * `EmojiPopover` is shared by the team-chat composer/reaction toolbars AND the
 * customer inbox reply box. It gained an auto-flip (open BELOW the trigger when
 * opening upward would run off the top of the nearest clipping ancestor) so a
 * message hover-toolbar near the top of a scrolled feed stops being cut off.
 *
 * The reply box always has room above it, so the flip must NOT fire there. This
 * guards that: the inbox is the highest-quality surface in the app and the flip
 * is exactly the kind of shared-component change that regresses it silently.
 *
 * SAFE / self-cleaning: seeds one contact + conversation + message, removes them.
 */
import { test, expect } from "@playwright/test";
import { db, appAdmin } from "../_helpers/db";

const PREFIX = "e2e_inboxemoji_";
let workspaceId: string;
let contactId: string;

test.beforeAll(async () => {
  workspaceId = (await appAdmin()).workspaceId;
  const contact = await db().contact.create({
    data: {
      workspaceId,
      identityChannel: "whatsapp",
      phoneNumber: `9999${Date.now().toString().slice(-8)}`,
      name: `${PREFIX}Contact`,
      // Open messaging window. This spec is about popover PLACEMENT, and
      // without it the fixture was silently exercising a CLOSED window, where
      // the whole reply composer (textarea included) is disabled — so it was
      // asserting emoji insertion into a composer the agent could never
      // actually type in.
      lastInboundAt: new Date(),
    },
    select: { id: true },
  });
  contactId = contact.id;
  const convo = await db().conversation.create({
    data: {
      workspaceId,
      contactId,
      channel: "whatsapp",
      status: "open",
      lastMessageAt: new Date(),
      lastMessagePreview: "hello there",
    },
    select: { id: true },
  });
  await db().message.create({
    data: {
      workspaceId,
      conversationId: convo.id,
      channel: "whatsapp",
      direction: "in",
      externalId: `${PREFIX}${Date.now()}`,
      body: "hello there",
      status: "delivered",

    },
  });
});

test.afterAll(async () => {
  await db().message.deleteMany({ where: { workspaceId, conversation: { contactId } } });
  await db().conversation.deleteMany({ where: { workspaceId, contactId } });
  await db().contact.deleteMany({ where: { workspaceId, id: contactId } });
});

test("inbox reply-box emoji popover still opens UPWARD and inserts", async ({ page }) => {
  await page.goto("/inbox");
  const row = page.locator("div.h-20.cursor-pointer").first();
  await row.waitFor({ timeout: 30_000 });
  await row.click();

  const trigger = page.getByRole("button", { name: /insert emoji/i }).first();
  await trigger.waitFor({ timeout: 30_000 });
  await trigger.click();

  const geom = await page.evaluate(() => {
    const el = document.querySelector(".w-72.overflow-hidden.rounded-xl");
    if (!el) return null;
    const b = el.getBoundingClientRect();
    const anchor = (el.parentElement as HTMLElement).getBoundingClientRect();
    return {
      top: b.top,
      bottom: b.bottom,
      anchorTop: anchor.top,
      left: b.left,
      right: b.right,
      vw: window.innerWidth,
      docOverflow:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(geom).not.toBeNull();
  // The reply box has room above it, so the panel must still open UPWARD —
  // the flip I added for clipped scrollers must NOT fire here.
  expect(geom!.bottom).toBeLessThanOrEqual(geom!.anchorTop + 1);
  expect(geom!.top).toBeGreaterThanOrEqual(0);
  expect(geom!.right).toBeLessThanOrEqual(geom!.vw);
  expect(geom!.docOverflow).toBe(0);

  // And it still inserts at the caret.
  await page.locator(".w-72.overflow-hidden.rounded-xl button").nth(8).click();
  const box = page.locator("textarea").first();
  await expect(box).not.toHaveValue("");
});
