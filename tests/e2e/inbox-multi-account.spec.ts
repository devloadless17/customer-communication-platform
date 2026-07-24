import { test, expect } from "@playwright/test";

import { appAdmin, db } from "./_helpers/db";

/**
 * The multi-account inbox, driven through the real UI.
 *
 * A workspace can connect several WhatsApp numbers. The product decision is a
 * UNIFIED inbox — every number in one list, each row labelled with the account
 * it arrived on — plus an on-demand narrow. That is a chain of four things that
 * are individually plausible and only work together:
 *
 *   the directory fetch → the row chip → the picker → the refetch key
 *
 * and every link in it is invisible to a unit test. Two of them were already
 * wrong once: the directory endpoint shipped 401-ing (swallowed by a
 * `.catch(() => [])`, so the chip silently never rendered), and the account
 * narrow was initially left out of `filterKey` — which is the ONLY thing that
 * triggers a refetch, so picking a number lit the button and changed nothing.
 *
 * Neither failure throws. Both look exactly like "this workspace has one
 * number." So this spec asserts the visible outcome at every link.
 */

const P = "MA-";

/**
 * A conversation ROW, located by the contact it is with.
 *
 * Not `getByText(name)`: the name also appears inside the row's message preview
 * ("MA-Alice says hi"), so a bare text match hits two nodes and trips strict
 * mode. The row is a button whose accessible name concatenates avatar initial,
 * channel, contact and account — matching on the contact alone is precise
 * enough and survives the chip text changing.
 */
const row = (page: import("@playwright/test").Page, name: string) =>
  page.getByRole("button", { name: new RegExp(name) });

/**
 * An entry in the sub-sidebar's Accounts picker.
 *
 * Two traps, both of which produce a locator that looks right and isn't:
 *   - NOT `exact` — the button renders a `ChannelBadge` whose title joins the
 *     accessible name, so the real name is "WhatsApp MA-Sales line".
 *   - SCOPED to the sidebar — a conversation ROW carries the same account name
 *     in its attribution chip and `title`, so an unscoped match resolves to
 *     both the picker entry and the row, and strict mode rejects it.
 */
const accountOption = (page: import("@playwright/test").Page, label: string) =>
  page.locator("aside").getByRole("button", { name: new RegExp(label) });
const ACCOUNT_A = `${P}Sales line`;
const ACCOUNT_B = `${P}Support line`;

let workspaceId = "";
let accountAId = "";
let accountBId = "";

test.beforeAll(async () => {
  const d = db();
  ({ workspaceId } = await appAdmin());

  // Two WhatsApp accounts. `isActive` matters: the picker dims inactive rows,
  // and an inactive account would also drop out of default resolution.
  const mk = async (label: string, external: string, isDefault: boolean) =>
    (
      await d.channelConnection.upsert({
        where: {
          workspaceId_channel_externalAccountId: {
            workspaceId,
            channel: "whatsapp",
            externalAccountId: external,
          },
        },
        create: {
          workspaceId,
          channel: "whatsapp",
          externalAccountId: external,
          label,
          isDefault,
          isActive: true,
          config: { phoneNumberId: external, displayPhoneNumber: `+1 555 ${external}` },
        },
        update: { label, isDefault, isActive: true },
        select: { id: true },
      })
    ).id;

  // NEITHER fixture account is the default.
  //
  // A workspace may hold exactly one default per channel — a partial unique
  // index enforces it (migration 20260723160000). An earlier version of this
  // fixture wrote `isDefault: true` on account A while the workspace's REAL
  // WhatsApp connection was already default, which left three defaults behind
  // and made "which number do we send from" nondeterministic for every later
  // spec and for the dev app. Nothing here needs a default: the picker and the
  // attribution chip key off `channelConnectionId`, not `isDefault`.
  accountAId = await mk(ACCOUNT_A, "5550000001", false);
  accountBId = await mk(ACCOUNT_B, "5550000002", false);

  // One conversation on each account, each with a recognisable contact name so
  // the assertions read off the visible list rather than internal ids.
  const mkThread = async (name: string, phone: string, accountId: string) => {
    const contact = await d.contact.create({
      data: { workspaceId, name, phoneNumber: phone, identityChannel: "whatsapp" },
    });
    await d.conversation.create({
      data: {
        workspaceId,
        contactId: contact.id,
        channel: "whatsapp",
        channelConnectionId: accountId,
        status: "open",
        lastMessagePreview: `${name} says hi`,
        lastMessageAt: new Date(),
      },
    });
  };
  await mkThread(`${P}Alice`, "5551110001", accountAId);
  await mkThread(`${P}Bob`, "5551110002", accountBId);
});

test.afterAll(async () => {
  const d = db();
  // Conversations cascade from the contact; the accounts go last so nothing
  // still references them. BOTH fixture accounts are removed — leaving one
  // behind is what polluted the workspace last time, and since neither is the
  // default there is nothing to preserve.
  await d.contact.deleteMany({ where: { workspaceId, name: { startsWith: P } } });
  await d.channelConnection.deleteMany({
    where: {
      workspaceId,
      channel: "whatsapp",
      externalAccountId: { in: ["5550000001", "5550000002"] },
    },
  });
});

test("the inbox is unified — both numbers' conversations in one list, each labelled", async ({
  page,
}) => {
  await page.goto("/inbox");

  // Both threads present without touching any filter. This is the product
  // decision under test: multi-account does NOT mean switching inboxes.
  await expect(row(page, `${P}Alice`)).toBeVisible();
  await expect(row(page, `${P}Bob`)).toBeVisible();

  // And each row says WHICH number it came in on — asserted through the row's
  // own accessible name, so this fails if the chip stops rendering (which is
  // exactly what happened when the directory endpoint shipped 401-ing).
  await expect(row(page, `${P}Alice`)).toHaveAccessibleName(/Sales/);
  await expect(row(page, `${P}Bob`)).toHaveAccessibleName(/Support/);
});

test("picking an account narrows the list, and 'All accounts' restores it", async ({ page }) => {
  await page.goto("/inbox");
  await expect(row(page, `${P}Bob`)).toBeVisible();

  // The picker only exists above one account per channel — its presence is
  // itself part of the contract. It renders EXPANDED, so the account buttons
  // are directly clickable; clicking the "Accounts" header would collapse it.
  await expect(page.locator("aside").getByRole("button", { name: /^Accounts/i })).toBeVisible();
  await accountOption(page, ACCOUNT_A).click();

  // The narrow must actually reach the server. If `accountId` were missing from
  // `filterKey` the button would light and this row would stay.
  await expect(row(page, `${P}Bob`)).toHaveCount(0);
  await expect(row(page, `${P}Alice`)).toBeVisible();

  await page.locator("aside").getByRole("button", { name: "All accounts" }).click();
  await expect(row(page, `${P}Bob`)).toBeVisible();
});

test("the narrow composes with a preset instead of replacing it", async ({ page }) => {
  // The reason the account narrow is a SECOND dimension rather than another
  // `Filter` variant: "Unassigned" and "on the Sales number" are different
  // questions. Folding accounts into the exclusive union would have forced a
  // choice between them, and picking a number would silently reset the preset.
  await page.goto("/inbox");
  await accountOption(page, ACCOUNT_A).click();
  await expect(row(page, `${P}Alice`)).toBeVisible();

  // Switch the preset — the account narrow must survive it.
  await page.locator("aside").getByRole("button", { name: /^Unassigned/ }).first().click();
  // Both threads are unassigned, so only the account narrow can still be
  // excluding Bob. That is the composition being asserted.
  await expect(row(page, `${P}Bob`)).toHaveCount(0);
  await expect(row(page, `${P}Alice`)).toBeVisible();
});

test("the narrow is NOT remembered across a reload", async ({ page }) => {
  // Deliberate, and the opposite of how the preset behaves. A remembered
  // account narrow is a silent trap: the agent returns to an inbox missing
  // every conversation on the other numbers, with nothing on screen explaining
  // why. "All accounts" is the honest state to land on.
  await page.goto("/inbox");
  await accountOption(page, ACCOUNT_A).click();
  await expect(row(page, `${P}Bob`)).toHaveCount(0);

  await page.reload();
  await expect(row(page, `${P}Bob`)).toBeVisible();
});
