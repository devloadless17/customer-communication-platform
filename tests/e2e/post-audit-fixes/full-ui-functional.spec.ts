import { test, expect, type Page, type ConsoleMessage } from "@playwright/test";

import { db, appAdmin } from "../_helpers/db";

/**
 * FULL FUNCTIONAL UI sweep of the surfaces that the route-smoke suites only
 * prove "mount clean" — every settings catalog (tags / stages / contact-fields
 * / snippets), the contact-create dialog, team-chat send, org API keys,
 * outbound webhooks, plus the audience-group WhatsApp gate and read-only
 * assertions on the activity / permissions / whatsapp / notifications /
 * API-docs screens.
 *
 * Each test drives the REAL UI (clicks the real buttons, fills the real
 * inputs) and asserts the real outcome — for create/delete that means the row
 * actually appears / disappears (and the DB row is really there / really gone),
 * not just that the page rendered.
 *
 * SAFETY / ISOLATION
 *  - Every entity is namespaced with a per-run prefix (RUN) so a crash never
 *    collides with a prior run, and `afterAll` blanket-deletes anything still
 *    carrying that prefix — the suite leaves the shared team_1 exactly as it
 *    found it.
 *  - Nothing here touches WhatsApp: no customer Send, no template submit (the
 *    template form is Meta-gated and redirects away in dev), no broadcast
 *    submit. Team-chat sends are internal-only.
 *  - The change-password test deliberately submits a WRONG current password so
 *    it exercises the cross-process NestJS /api/auth/change-password route
 *    WITHOUT ever changing the app-admin's password (other specs log in as it).
 */

const RUN = `e2e-ui-${Date.now().toString(36)}`;
// 6 unique digits for the manually-created contact's Lebanon (+961) number.
const PHONE_DIGITS = String(Date.now()).slice(-6);

// Mirrors full-e2e-2026-06-16's tolerated noise: the app deliberately 404s on
// the optional /sounds/*.mp3 alert files (it synthesizes a Web-Audio tone as
// fallback — see apps/web/public/sounds/README.md) and on seeded stored://
// media blobs, both surfaced as a generic "Failed to load resource: 404".
const KNOWN_NOISE = [
  "useInsertionEffect must not schedule updates",
  "cannot have a negative time stamp",
  "Download the React DevTools",
  "ERR_SSL_PROTOCOL_ERROR",
  "Failed to load resource: the server responded with a status of 404",
  "/api/media/",
];

/** Per-test console / pageerror / 5xx collector — asserted empty at the end. */
function track(page: Page): string[] {
  const errs: string[] = [];
  page.on("console", (m: ConsoleMessage) => {
    if (m.type() === "error" && !KNOWN_NOISE.some((n) => m.text().includes(n))) {
      errs.push(`console: ${m.text()}`);
    }
  });
  page.on("pageerror", (e) => {
    if (!KNOWN_NOISE.some((n) => e.message.includes(n))) errs.push(`pageerror: ${e.message}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 500) errs.push(`5xx ${r.request().method()} ${r.url()}`);
  });
  return errs;
}

/** Click the confirm button inside the (portalled) confirm dialog. `.last()`
 *  targets the TOPMOST dialog — the confirm can stack over an editor dialog
 *  (e.g. delete-from-snippet-editor), and the confirm is the one opened last /
 *  portalled on top. With a single dialog, `.last()` is just that dialog. */
function confirmButton(page: Page, label: string) {
  return page.getByRole("dialog").last().getByRole("button", { name: label });
}

test.beforeAll(async () => {
  await appAdmin();
  await cleanup();
});

test.afterAll(async () => {
  await cleanup();
});

async function cleanup() {
  const { workspaceId } = await appAdmin();
  await db().tag.deleteMany({ where: { workspaceId, name: { startsWith: RUN } } });
  await db().contactStage.deleteMany({ where: { workspaceId, name: { startsWith: RUN } } });
  await db().contactFieldDefinition.deleteMany({ where: { workspaceId, label: { startsWith: RUN } } });
  await db().snippet.deleteMany({ where: { workspaceId, name: { startsWith: RUN } } });
  await db().workspaceApiKey.deleteMany({ where: { workspaceId, name: { startsWith: RUN } } });
  await db().outboundWebhook.deleteMany({ where: { workspaceId, name: { startsWith: RUN } } });
  await db().teamChannelMessage.deleteMany({ where: { body: { contains: RUN } } });
  await db().contact.deleteMany({ where: { workspaceId, phoneNumber: { contains: PHONE_DIGITS } } });
}

// ───────────────────────────────────────────────────────────────────────────
// 1. TAGS — full CRUD
// ───────────────────────────────────────────────────────────────────────────
test("settings/tags: create a tag then delete it", async ({ page }) => {
  const errs = track(page);
  const name = `${RUN}-tag`;
  await page.goto("/settings/tags");
  await expect(page.getByRole("heading", { name: "Tags" })).toBeVisible();

  // "Add tag" appears in BOTH the header and the empty-state when 0 tags exist.
  await page.getByRole("button", { name: "Add tag" }).first().click();
  await page.getByLabel("New tag name").fill(name);
  await page.getByRole("button", { name: "Create" }).click();

  const del = page.getByRole("button", { name: `Delete ${name}` });
  await expect(del).toBeVisible();
  expect(await db().tag.count({ where: { name } })).toBe(1);

  await del.click();
  await confirmButton(page, "Delete tag").click();
  await expect(del).toHaveCount(0);
  expect(await db().tag.count({ where: { name } })).toBe(0);
  expect(errs, "tags errors").toEqual([]);
});

// ───────────────────────────────────────────────────────────────────────────
// 2. STAGES — full CRUD
// ───────────────────────────────────────────────────────────────────────────
test("settings/stages: create a pipeline stage then delete it", async ({ page }) => {
  const errs = track(page);
  const name = `${RUN}-stage`;
  await page.goto("/settings/stages");
  await expect(page.getByRole("heading", { name: "Stages" })).toBeVisible();

  await page.getByRole("button", { name: "Add stage" }).first().click();
  await page.getByLabel("New stage name").fill(name);
  await page.getByRole("button", { name: "Create" }).click();

  const del = page.getByRole("button", { name: `Delete ${name}` });
  await expect(del).toBeVisible();
  expect(await db().contactStage.count({ where: { name } })).toBe(1);

  await del.click();
  await confirmButton(page, "Delete").click();
  await expect(del).toHaveCount(0);
  expect(await db().contactStage.count({ where: { name } })).toBe(0);
  expect(errs, "stages errors").toEqual([]);
});

// ───────────────────────────────────────────────────────────────────────────
// 3. CONTACT FIELDS — full CRUD
// ───────────────────────────────────────────────────────────────────────────
test("settings/contact-fields: create a custom field then delete it", async ({ page }) => {
  const errs = track(page);
  const label = `${RUN}-field`;
  await page.goto("/settings/contact-fields");
  await expect(page.getByRole("heading", { name: "Contact fields" })).toBeVisible();

  await page.getByRole("button", { name: "Add field" }).first().click();
  await page.getByLabel("New field name").fill(label);
  await page.getByRole("button", { name: "Create" }).click();

  const del = page.getByRole("button", { name: `Delete ${label}` });
  await expect(del).toBeVisible();
  expect(await db().contactFieldDefinition.count({ where: { label } })).toBe(1);

  await del.click();
  await confirmButton(page, "Delete field").click();
  await expect(del).toHaveCount(0);
  expect(await db().contactFieldDefinition.count({ where: { label } })).toBe(0);
  expect(errs, "contact-fields errors").toEqual([]);
});

// ───────────────────────────────────────────────────────────────────────────
// 4. SNIPPETS — full CRUD
// ───────────────────────────────────────────────────────────────────────────
test("settings/snippets: create a snippet then delete it", async ({ page }) => {
  const errs = track(page);
  const trigger = `${RUN.replace(/-/g, "_")}_snip`.toLowerCase();
  const label = `${RUN}-snippet-label`;
  await page.goto("/settings/snippets");
  await expect(page.getByRole("heading", { name: "Snippets" })).toBeVisible();

  await page.getByRole("button", { name: "New snippet" }).first().click();
  await page.getByPlaceholder("welcome_new_user").fill(trigger);
  await page.getByPlaceholder("Welcome a new customer").fill(label);
  await page.getByPlaceholder(/Hi \$var\.contact\.name/).fill("Hello from the e2e sweep");
  await page.getByRole("button", { name: "Create snippet" }).click();

  // onSaved keeps the editor open (now edit mode) AND splices into the list.
  await expect(page.getByText(label).first()).toBeVisible();
  expect(await db().snippet.count({ where: { name: trigger } })).toBe(1);

  // The editor for a saved snippet exposes a Delete button → confirm dialog.
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await confirmButton(page, "Delete").click();
  await expect(page.getByText(label)).toHaveCount(0);
  expect(await db().snippet.count({ where: { name: trigger } })).toBe(0);
  expect(errs, "snippets errors").toEqual([]);
});

// ───────────────────────────────────────────────────────────────────────────
// 5. CONTACTS — create via the New-contact dialog
// ───────────────────────────────────────────────────────────────────────────
test("contacts: create a contact through the dialog", async ({ page }) => {
  const errs = track(page);
  const name = `${RUN}-contact`;
  await page.goto("/contacts");
  await page.getByRole("button", { name: /new contact/i }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();

  // Default dial country is Lebanon (+961); phone field takes local digits.
  await page.getByPlaceholder("70 921 116").fill(`70${PHONE_DIGITS}`);
  await page.getByPlaceholder("Defaults to phone number").fill(name);
  await page.getByRole("button", { name: "Create contact" }).click();

  // onCreated closes the dialog and splices the row to the top of the list.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(name).first()).toBeVisible();
  expect(
    await db().contact.count({ where: { phoneNumber: { contains: PHONE_DIGITS } } }),
  ).toBe(1);
  expect(errs, "contacts create errors").toEqual([]);
});

// ───────────────────────────────────────────────────────────────────────────
// 6. AUDIENCE GROUPS — creation is correctly WhatsApp-gated in dev
// ───────────────────────────────────────────────────────────────────────────
test("broadcasts/groups: new-group is WhatsApp-gated when unconfigured", async ({ page }) => {
  // Audience groups exist to broadcast to, so /broadcasts/groups/new redirects
  // to the WhatsApp setup when the team has no phone number configured (the
  // dev state). Assert that real guard rather than seeding fake Meta creds on a
  // live-pilot box (which a background job could pick up and POST to Meta).
  const errs = track(page);
  await page.goto("/broadcasts/groups/new");
  await page.waitForURL(/\/settings\/whatsapp/, { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "WhatsApp" }).first()).toBeVisible();
  expect(errs, "group gate errors").toEqual([]);
});

// ───────────────────────────────────────────────────────────────────────────
// 7. TEAM CHAT — send a message into #general
// ───────────────────────────────────────────────────────────────────────────
test("team chat: send a message into #general", async ({ page }) => {
  const errs = track(page);
  const body = `hello from ${RUN}`;
  await page.goto("/team");
  await page.waitForURL(/\/team\/.+/, { timeout: 15_000 });

  const composer = page.getByRole("textbox", { name: /Message #/ });
  await expect(composer).toBeVisible();
  await composer.fill(body);
  await composer.press("Enter"); // Enter sends (no mention trigger active)

  // The composer clears on a successful optimistic send, and the row lands in
  // the DB. (We assert on the DB rather than the feed: #general is cluttered
  // with other specs' seeded media, so the virtualized feed may keep a just-
  // sent message off-screen / out of the DOM — the persisted row is the real
  // proof the composer → REST → DB path works.)
  await expect(composer).toHaveValue("");
  await expect
    .poll(() => db().teamChannelMessage.count({ where: { body } }), { timeout: 10_000 })
    .toBe(1);
  expect(errs, "team chat send errors").toEqual([]);
});

// ───────────────────────────────────────────────────────────────────────────
// 8. API KEYS — full create + revoke
// ───────────────────────────────────────────────────────────────────────────
test("settings/integrations: mint an org API key then revoke it", async ({ page }) => {
  const errs = track(page);
  const name = `${RUN}-key`;
  await page.goto("/settings/integrations");
  await expect(page.getByRole("heading", { name: "Organization API keys" })).toBeVisible();

  await page.getByPlaceholder("Organization").fill(name);
  await page.getByRole("button", { name: "Create key" }).click();

  // Reveal-once banner + the row in the active-keys list both appear.
  await expect(page.getByText(/only time it.ll be shown/i)).toBeVisible();
  const row = page.locator("li").filter({ hasText: name });
  await expect(row).toBeVisible();
  expect(await db().workspaceApiKey.count({ where: { name, revokedAt: null } })).toBe(1);

  await row.getByRole("button", { name: "Revoke" }).click();
  await confirmButton(page, "Revoke key").click();
  await expect(row).toHaveCount(0);
  expect(await db().workspaceApiKey.count({ where: { name, revokedAt: null } })).toBe(0);
  expect(errs, "api key errors").toEqual([]);
});

// ───────────────────────────────────────────────────────────────────────────
// 9. OUTBOUND WEBHOOKS — register one (UI create path)
// ───────────────────────────────────────────────────────────────────────────
test("settings/webhooks: register an outbound webhook", async ({ page }) => {
  const errs = track(page);
  const name = `${RUN}-hook`;
  await page.goto("/settings/integrations/webhooks");
  await expect(page.getByRole("heading", { name: "Webhooks", exact: true })).toBeVisible();

  // "New webhook" once ≥1 exists; "Create your first webhook" on the empty state.
  await page
    .getByRole("button", { name: /New webhook|Create your first webhook/ })
    .first()
    .click();
  const form = page.locator("form");
  await form.getByLabel("Name", { exact: true }).fill(name);
  await form.getByLabel("URL", { exact: true }).fill("https://example.com/e2e-hook");
  await form.getByRole("checkbox").first().check(); // subscribe to ≥1 event
  await page.getByRole("button", { name: "Create webhook" }).click();

  await expect(page.getByText(name).first()).toBeVisible();
  await expect
    .poll(() => db().outboundWebhook.count({ where: { name } }), { timeout: 10_000 })
    .toBe(1);
  expect(errs, "webhook create errors").toEqual([]);
});

// ───────────────────────────────────────────────────────────────────────────
// 10. CHANGE PASSWORD — wrong current password is rejected (no change made)
// ───────────────────────────────────────────────────────────────────────────
test("settings/account: wrong current password is rejected", async ({ page }) => {
  const errs = track(page);
  await page.goto("/settings/account");
  const current = page.getByPlaceholder("Current password");
  await expect(current).toBeVisible();

  await current.fill("definitely-not-the-password");
  await page.getByPlaceholder(/New password/).fill("brand-new-password-123");
  await page.getByRole("button", { name: "Update password" }).click();

  // The cross-process NestJS route must reject it with a visible error, NOT 5xx.
  await expect(page.getByRole("alert")).toBeVisible();
  expect(errs, "change-password errors").toEqual([]);
});

// ───────────────────────────────────────────────────────────────────────────
// 11. NOTIFICATIONS — a preference switch toggles (and reverts)
// ───────────────────────────────────────────────────────────────────────────
test("settings/notifications: a preference switch toggles", async ({ page }) => {
  const errs = track(page);
  await page.goto("/settings/notifications");
  await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();

  const sw = page.getByRole("switch").first();
  await expect(sw).toBeVisible();
  const before = (await sw.getAttribute("aria-checked")) ?? "false";
  await sw.click();
  await expect(sw).not.toHaveAttribute("aria-checked", before);
  await sw.click(); // revert to the original state
  await expect(sw).toHaveAttribute("aria-checked", before);
  expect(errs, "notifications errors").toEqual([]);
});

// ───────────────────────────────────────────────────────────────────────────
// 12. PERMISSIONS — the role matrix renders with real controls (read-only)
// ───────────────────────────────────────────────────────────────────────────
test("settings/permissions: role matrix renders with switches", async ({ page }) => {
  const errs = track(page);
  await page.goto("/settings/permissions");
  await expect(page.getByRole("heading", { name: "Role permissions" })).toBeVisible();
  // The matrix is data-driven — wait for the capability switches to hydrate.
  await expect(page.getByRole("switch").first()).toBeVisible();
  expect(await page.getByRole("switch").count()).toBeGreaterThan(0);
  expect(errs, "permissions errors").toEqual([]);
});

// ───────────────────────────────────────────────────────────────────────────
// 13. READ-ONLY SCREENS — activity / whatsapp / api-docs render real content
// ───────────────────────────────────────────────────────────────────────────
test("settings/activity: team activity table renders", async ({ page }) => {
  const errs = track(page);
  await page.goto("/settings/activity");
  const body = (await page.locator("body").innerText()).toLowerCase();
  expect(body).toMatch(/activity|messages|assigned|closed/);
  expect(errs, "activity errors").toEqual([]);
});

test("settings/whatsapp: connection screen renders", async ({ page }) => {
  const errs = track(page);
  await page.goto("/settings/whatsapp");
  await expect(page.getByRole("heading", { name: "WhatsApp" }).first()).toBeVisible();
  expect(errs, "whatsapp errors").toEqual([]);
});

test("docs/api: external API docs render", async ({ page }) => {
  const errs = track(page);
  await page.goto("/docs/api");
  const body = (await page.locator("body").innerText()).toLowerCase();
  expect(body).toMatch(/api|endpoint|authorization|contacts|messages/);
  expect(errs, "api docs errors").toEqual([]);
});
