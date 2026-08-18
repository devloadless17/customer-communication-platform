/**
 * Contact segments — the directory is who you can PHONE, everyone else is a
 * channel segment.
 *
 * Drives the real page: the default view's reachability gate, the per-channel
 * segments in the sub-sidebar (with counts), the removable chip that explains
 * the default, and the two paths where getting this wrong is expensive —
 * "select all N matching" inside a segment (it must expand to exactly the rows
 * on screen) and group-by-person (which drops the channel filter but must keep
 * the reach gate).
 *
 * The fixtures are one contact per reachability shape, because the whole design
 * turns on the difference between them: a phone is the directory, an email is a
 * segment, and a web-chat visitor with neither is not a contact at all.
 *
 *   E2E_BASE_URL=http://localhost:3010 npx playwright test tests/e2e/contacts-segments.spec.ts --project=chromium
 */
import { test, expect, type Page } from "@playwright/test";

import { db, appAdmin, wipeTestData } from "./_helpers/db";

const RUN = Date.now().toString().slice(-6);
const P = `ZZ${RUN}`; // name prefix, so assertions ignore any other fixtures

let workspaceId: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await wipeTestData();
  workspaceId = (await appAdmin()).workspaceId;

  const mk = (
    name: string,
    identityChannel: "whatsapp" | "instagram" | "messenger" | "webchatwidget",
    phoneNumber: string | null,
    email: string | null,
    externalContactId: string | null,
  ) =>
    db().contact.create({
      data: { workspaceId, name, identityChannel, phoneNumber, email, externalContactId },
    });

  await Promise.all([
    mk(`${P} WA Phone`, "whatsapp", `+961${RUN}1`, null, null),
    mk(`${P} IG Bare`, "instagram", null, null, `ig_${RUN}`),
    mk(`${P} IG Email`, "instagram", null, `ig${RUN}@e2e.test`, `ig2_${RUN}`),
    mk(`${P} Messenger`, "messenger", null, null, `psid_${RUN}`),
    mk(`${P} WC Email`, "webchatwidget", null, `wc${RUN}@e2e.test`, `w:vis_${RUN}a`),
    // The one person nobody can contact again: a browser session with no
    // address. Must never appear anywhere in the directory.
    mk(`${P} WC Anon`, "webchatwidget", null, null, `w:vis_${RUN}b`),
  ]);
});

test.afterAll(async () => {
  await db().contact.deleteMany({ where: { workspaceId, name: { startsWith: P } } });
});

/** Contact names as rendered — leaf spans, not whole rows (which also carry
 *  avatars, checkboxes and metadata). */
async function rowNames(page: Page, prefix: string): Promise<string[]> {
  return page.evaluate((pfx) => {
    return [...document.querySelectorAll("main span")]
      .filter((n) => n.children.length === 0 && (n.textContent ?? "").trim().startsWith(pfx))
      .map((n) => (n.textContent ?? "").trim())
      .sort();
  }, prefix);
}

async function gotoContacts(page: Page, query = ""): Promise<void> {
  await page.goto(`/contacts${query}`);
  await page.waitForLoadState("networkidle");
  // The sub-sidebar header says "Contacts" too — scope to the page heading.
  await expect(page.locator("#main-content").getByRole("heading", { name: "Contacts" })).toBeVisible();
}

test("the default view is the directory — only contacts with a phone", async ({ page }) => {
  await gotoContacts(page);
  await expect.poll(() => rowNames(page, P)).toEqual([`${P} WA Phone`]);
});

test("the default explains itself with a removable chip", async ({ page }) => {
  await gotoContacts(page);
  const chip = page.getByText("Has phone", { exact: true });
  await expect(chip).toBeVisible();

  // Removing it widens to everyone REACHABLE — which is still not the
  // anonymous visitor, because they are not a contact at any setting.
  await page.getByRole("button", { name: /clear all/i }).click();
  await page.waitForLoadState("networkidle");
  await expect.poll(() => rowNames(page, P)).toHaveLength(5);
  expect(await rowNames(page, P)).not.toContain(`${P} WC Anon`);
});

test("channel segments carry counts and lift the phone gate", async ({ page }) => {
  await gotoContacts(page);

  const instagram = page.locator('a[href*="channel=instagram"]');
  await expect(instagram).toBeVisible();
  // The segment link must lift the gate, or it would show only the phone-havers
  // on that channel — which for Instagram is usually nobody.
  await expect(instagram).toHaveAttribute("href", /reach=any/);
  await expect(instagram).toContainText("2");

  // The web-chat badge counts the emailable visitor but NOT the anonymous one.
  await expect(page.locator('a[href*="channel=webchatwidget"]')).toContainText("1");

  await instagram.click();
  await page.waitForURL(/channel=instagram/);
  await expect.poll(() => rowNames(page, P)).toEqual([`${P} IG Bare`, `${P} IG Email`]);
});

test("a segment can be narrowed to who you can email", async ({ page }) => {
  await gotoContacts(page, "?channel=instagram&reach=email");
  await expect.poll(() => rowNames(page, P)).toEqual([`${P} IG Email`]);
});

test("the unreachable web-chat visitor is a contact in no view", async ({ page }) => {
  for (const q of ["", "?reach=any", "?channel=webchatwidget&reach=any"]) {
    await gotoContacts(page, q);
    await expect.poll(() => rowNames(page, P)).not.toContain(`${P} WC Anon`);
  }
});

test("select-all inside a segment targets exactly the visible rows", async ({ page }) => {
  await gotoContacts(page, "?channel=instagram&reach=any");
  // The header checkbox selects the page; the count it reports is what a bulk
  // action would touch, so it must equal the segment — never the whole workspace.
  await page.locator('input[type="checkbox"]').first().check();
  await expect(page.getByText(/2\s+selected/i)).toBeVisible();
});

test("group-by-person keeps the reach gate", async ({ page }) => {
  await gotoContacts(page);
  await page.getByRole("button", { name: "Group by person" }).click();
  // Person mode deliberately drops the CHANNEL filter (a person spans channels)
  // but reachability is a property of the row, so the gate still applies.
  await expect.poll(() => rowNames(page, P)).toEqual([`${P} WA Phone`]);
});
