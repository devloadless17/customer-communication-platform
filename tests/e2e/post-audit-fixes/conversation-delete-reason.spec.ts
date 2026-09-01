import { test, expect } from "@playwright/test";

import { appAdmin, db } from "../_helpers/db";

/**
 * Deleting a chat that carries a TICKET must say WHY.
 *
 * Reported 2026-08-20: an org admin hit "Couldn't delete chats — Please try
 * again." and retrying never worked. It never could: the server refuses with
 * 409 `conversation_has_tickets` and a written explanation (deleting the thread
 * would destroy the tickets' history, files, and any department they were
 * escalated to — the FK is onDelete: Cascade, so the guard is the ONLY
 * protection). The client discarded the body and rendered generic retry advice,
 * turning a deliberate, actionable refusal into an apparent bug.
 */
const PREFIX = "e2e_cdr_";

let workspaceId: string;
let conversationId: string;
const NAME = `${PREFIX}Yara`;

test.beforeAll(async () => {
  const admin = await appAdmin();
  workspaceId = admin.workspaceId;

  const contact = await db().contact.create({
    data: {
      workspaceId,
      name: NAME,
      phoneNumber: `+95${Date.now().toString().slice(-9)}`,
      identityChannel: "whatsapp",
      lastInboundAt: new Date(),
    },
  });
  const conversation = await db().conversation.create({
    data: { workspaceId, contactId: contact.id, channel: "whatsapp", status: "open" },
  });
  conversationId = conversation.id;
  await db().message.create({
    data: {
      workspaceId,
      conversationId,
      externalId: `${PREFIX}${conversationId}_0`,
      body: `${PREFIX}hello`,
      direction: "in",
      channel: "whatsapp",
      timestamp: new Date(),
    },
  });
  // The ticket that makes the thread undeletable.
  const maxNumber = await db().ticket.aggregate({
    where: { workspaceId },
    _max: { number: true },
  });
  await db().ticket.create({
    data: {
      workspaceId,
      number: (maxNumber._max.number ?? 0) + 1,
      conversationId,
      channel: "whatsapp",
      subject: `${PREFIX}refund`,
    },
  });
});

test.afterAll(async () => {
  await db().ticket.deleteMany({ where: { workspaceId, subject: { startsWith: PREFIX } } });
  await db().message.deleteMany({ where: { workspaceId, externalId: { startsWith: PREFIX } } });
  await db().conversation.deleteMany({ where: { workspaceId, id: conversationId } });
  await db().contact.deleteMany({ where: { workspaceId, name: { startsWith: PREFIX } } });
});

test("the refusal explains the tickets instead of saying 'try again'", async ({ page }) => {
  await page.goto(`/inbox?c=${conversationId}`);
  await expect(page.getByText(`${PREFIX}hello`).first()).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: /conversation actions|more/i }).first().click();
  await page.getByRole("menuitem", { name: /delete/i }).first().click();
  // The dropdown stays mounted behind the confirm dialog, so its Radix overlay
  // makes Playwright's actionability check see <html> intercepting the pointer.
  // A real click lands fine (this is how the defect was reported); force past
  // the harness's strictness rather than weakening the product.
  const confirmBtn = page.getByRole("button", { name: /^Delete chat$/ });
  await expect(confirmBtn).toBeVisible();
  await confirmBtn.evaluate((el) => (el as HTMLButtonElement).click());

  // The actionable sentence, not the dead-end retry advice.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(/carries 1 ticket/i, { timeout: 15_000 });
  await expect(dialog).toContainText(/Delete the ticket/i);
  await expect(dialog).not.toContainText(/Please try again/i);

  // And the thread survived.
  await page
    .getByRole("button", { name: /^OK$/ })
    .evaluate((el) => (el as HTMLButtonElement).click());
  expect(await db().conversation.count({ where: { id: conversationId } })).toBe(1);
});
