import { test, expect } from "@playwright/test";

import { appAdmin, db } from "../_helpers/db";

/**
 * Deleting a chat takes its TICKETS with it — and says so BEFORE the click.
 *
 * History: an org admin hit "Couldn't delete chats — Please try again", which
 * hid a deliberate refusal (the thread carried a ticket). The message was fixed
 * first; then the policy itself changed (2026-08-20): requiring a separate
 * ticket deletion made the common case a hunt, and left threads carrying a
 * ticket escalated INTO the workspace deletable by nobody, since that ticket's
 * delete button is hidden there.
 *
 * So the consequence moved to where it belongs — the confirmation, before the
 * destructive click, rather than an error after it. This asserts the warning is
 * present and that the delete actually goes through with the ticket gone.
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

test("the confirmation warns about tickets, and the delete takes them with it", async ({
  page,
}) => {
  await page.goto(`/inbox?c=${conversationId}`);
  await expect(page.getByText(`${PREFIX}hello`).first()).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: /conversation actions|more/i }).first().click();
  await page.getByRole("menuitem", { name: /delete/i }).first().click();

  // The consequence is stated up front — this is the only place someone can
  // learn that tickets die with the thread.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(/tickets raised on it/i, { timeout: 15_000 });
  await expect(dialog).toContainText(/escalated to/i);

  const confirmBtn = page.getByRole("button", { name: /^Delete chat$/ });
  await expect(confirmBtn).toBeVisible();
  // The dropdown stays mounted behind the dialog, so its Radix overlay makes
  // Playwright see <html> intercepting the pointer; a real click lands fine.
  await confirmBtn.evaluate((el) => (el as HTMLButtonElement).click());

  // Gone — thread and ticket both.
  await expect
    .poll(() => db().conversation.count({ where: { id: conversationId } }), { timeout: 20_000 })
    .toBe(0);
  expect(await db().ticket.count({ where: { workspaceId, subject: `${PREFIX}refund` } })).toBe(0);
});
