/**
 * Select-type custom fields — the client-named "stage-like" dimensions.
 *
 * Drives the REAL wiring end-to-end: the settings editor creates a dropdown
 * field with options, the contact drawer's pill picker writes the OPTION ID
 * through the optimistic save path, the contacts browser filters by option
 * (mode=equals), and the /v1 surface manages the catalog + accepts option
 * name-or-id on contact writes (the CRM-sync contract).
 *
 *   E2E_BASE_URL=http://localhost:3010 npx playwright test tests/e2e/contact-select-fields.spec.ts --project=chromium
 */
import { test, expect } from "@playwright/test";

import { generateApiKey } from "../../apps/api/src/auth/api-key";
import { db, appAdmin, wipeTestData, E2E_APP_WS_ID } from "./_helpers/db";

// Unique per run so a crashed run's leftovers can't collide on the
// [workspaceId, key] unique or the duplicate-label guard.
const RUN = Date.now().toString().slice(-6);
const FIELD_LABEL = `Src E2E ${RUN}`;
const FIELD_KEY = `src_e2e_${RUN}`;
const CONTACT_NAME = `Select Fields Contact ${RUN}`;
const CONTACT_PHONE = `+1555${RUN}0`;

let workspaceId: string;
let apiToken: string;
let contactId: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await wipeTestData();
  const su = await appAdmin();
  workspaceId = su.workspaceId;

  const key = generateApiKey();
  await db().workspaceApiKey.create({
    data: {
      workspaceId,
      name: "E2E select-fields key",
      tokenHash: key.tokenHash,
      tokenPrefix: key.tokenPrefix,
      createdById: su.userId,
      scopes: ["*"],
    },
  });
  apiToken = key.token;

  const contact = await db().contact.create({
    data: {
      workspaceId,
      phoneNumber: CONTACT_PHONE,
      identityChannel: "whatsapp",
      name: CONTACT_NAME,
      source: "manual",
    },
  });
  contactId = contact.id;
});

test.afterAll(async () => {
  await db()
    .contactFieldDefinition.deleteMany({ where: { workspaceId: E2E_APP_WS_ID } })
    .catch(() => undefined);
  await wipeTestData();
});

test("settings: create a dropdown field and manage its options", async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto("/settings/contact-fields");
  // Two "Add field" buttons on an empty list (page header + empty state).
  await page.getByRole("button", { name: "Add field" }).first().click();

  await page.getByLabel("New field name").fill(FIELD_LABEL);
  await page.getByRole("radio", { name: "Dropdown" }).click();
  await page.getByRole("button", { name: "Create" }).click();

  // The new row renders with its immutable key and the (empty) options badge.
  await expect(page.getByText(FIELD_KEY, { exact: true })).toBeVisible({ timeout: 15_000 });
  const badge = page.getByRole("button", { name: /Dropdown · 0 options/ });
  await expect(badge).toBeVisible();

  // Expand and add two options.
  await badge.click();
  const addInput = page.getByLabel(`Add option to ${FIELD_LABEL}`);
  await addInput.fill("CRM");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("button", { name: "CRM", exact: true })).toBeVisible();

  await addInput.fill("Website");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("button", { name: "Website", exact: true })).toBeVisible();

  // Duplicate name (case-insensitive) is refused with the structured error.
  await addInput.fill("crm");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText(/already exists on this field/)).toBeVisible();

  // The catalog persisted with ordered positions.
  const defs = await db().contactFieldDefinition.findMany({
    where: { workspaceId, key: FIELD_KEY },
    include: { options: { orderBy: { position: "asc" } } },
  });
  expect(defs).toHaveLength(1);
  expect(defs[0]!.type).toBe("select");
  expect(defs[0]!.options.map((o) => o.name)).toEqual(["CRM", "Website"]);
});

test("drawer: the pill picker sets the value and stores the OPTION ID", async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto("/contacts");
  await page.getByText(CONTACT_NAME, { exact: true }).first().click();

  // The drawer renders the select field as a picker, not a text input. The
  // empty pill reads "Set…" (the stage picker's says "Set stage…", so the
  // name is unambiguous).
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByText(FIELD_LABEL, { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await drawer.getByRole("button", { name: "Set…", exact: true }).click();
  await drawer.getByRole("button", { name: "CRM", exact: true }).click();

  // The pill trigger now shows the option name (title carries label + name).
  await expect(drawer.locator(`button[title="${FIELD_LABEL}: CRM"]`)).toBeVisible();

  // The DB stores the option ID (rename-stable), never the name.
  const def = await db().contactFieldDefinition.findFirstOrThrow({
    where: { workspaceId, key: FIELD_KEY },
    include: { options: true },
  });
  const crm = def.options.find((o) => o.name === "CRM")!;
  await expect
    .poll(async () => {
      const c = await db().contact.findUniqueOrThrow({
        where: { id: contactId },
        select: { customFields: true },
      });
      return (c.customFields as Record<string, string>)[FIELD_KEY];
    })
    .toBe(crm.id);
});

test("browser: filter by option (equals) and read the chip by NAME", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);

  // A second contact carrying the OTHER option, created over /v1 by option
  // NAME — proving the equals filter excludes it while including contact A.
  const created = await request.post("/api/external/v1/contacts", {
    headers: { Authorization: `Bearer ${apiToken}` },
    data: {
      phoneNumber: `+1555${RUN}9`,
      name: `${CONTACT_NAME} B`,
      customFields: { [FIELD_KEY]: "Website" },
    },
  });
  expect(created.ok()).toBeTruthy();

  await page.goto("/contacts");
  await expect(page.getByText(`${CONTACT_NAME} B`, { exact: true }).first()).toBeVisible({
    timeout: 20_000,
  });

  await page.getByRole("button", { name: "More", exact: true }).click();
  // The select field renders per-option radio rows in the More menu. Scoped to
  // buttons WITHOUT a title attribute: since the contacts table grew editable
  // select-field row lanes (2026-08-10), each row also renders a "CRM" pill —
  // but the pill carries title="<label>: <name>" while the menu row does not.
  await page.locator("button:not([title])", { hasText: /^CRM$/ }).click();

  // Chip shows label + option NAME (not the id); contact A (CRM) survives
  // the server-side equals filter, contact B (Website) drops out.
  await expect(page.getByText(`${FIELD_LABEL}: CRM`)).toBeVisible();
  await expect(page.getByText(CONTACT_NAME, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(`${CONTACT_NAME} B`, { exact: true })).toHaveCount(0, {
    timeout: 15_000,
  });
});

test("/v1: catalog CRUD + name-or-id contact writes (CRM sync contract)", async ({
  request,
}) => {
  const auth = { Authorization: `Bearer ${apiToken}` };

  // The catalog lists the field with type + options.
  const list = await request.get("/api/external/v1/contact-fields", { headers: auth });
  expect(list.ok()).toBeTruthy();
  const { items } = (await list.json()) as {
    items: Array<{
      id: string;
      key: string;
      type: string;
      options?: Array<{ id: string; name: string }>;
    }>;
  };
  const field = items.find((f) => f.key === FIELD_KEY)!;
  expect(field.type).toBe("select");
  const website = field.options!.find((o) => o.name === "Website")!;
  const crm = field.options!.find((o) => o.name === "CRM")!;

  // PATCH by option NAME (case-insensitive) → the id is stored.
  const patch = await request.patch(`/api/external/v1/contacts/${contactId}`, {
    headers: auth,
    data: { customFields: { [FIELD_KEY]: "website" } },
  });
  expect(patch.ok()).toBeTruthy();
  const stored = await db().contact.findUniqueOrThrow({
    where: { id: contactId },
    select: { customFields: true },
  });
  expect((stored.customFields as Record<string, string>)[FIELD_KEY]).toBe(website.id);

  // An unknown value is refused with the structured error naming the options.
  const bad = await request.patch(`/api/external/v1/contacts/${contactId}`, {
    headers: auth,
    data: { customFields: { [FIELD_KEY]: "Nope" } },
  });
  expect(bad.status()).toBe(400);
  expect(((await bad.json()) as { error: string }).error).toBe("invalid_option");

  // Deleting the in-use option without a move target → 409 + count.
  const del409 = await request.delete(
    `/api/external/v1/contact-fields/${field.id}/options/${website.id}`,
    { headers: auth },
  );
  expect(del409.status()).toBe(409);
  const conflict = (await del409.json()) as { error: string; contactCount: number };
  expect(conflict.error).toBe("option_in_use");
  expect(conflict.contactCount).toBeGreaterThanOrEqual(1);

  // Delete WITH a move target → carrying contacts re-point in the same tx.
  const delMove = await request.delete(
    `/api/external/v1/contact-fields/${field.id}/options/${website.id}`,
    { headers: auth, data: { moveToOptionId: crm.id } },
  );
  expect(delMove.ok()).toBeTruthy();
  const moved = await db().contact.findUniqueOrThrow({
    where: { id: contactId },
    select: { customFields: true },
  });
  expect((moved.customFields as Record<string, string>)[FIELD_KEY]).toBe(crm.id);

  // Rename the surviving option — the stored contact value (the ID) is
  // untouched; the rename is metadata-only. That's the payoff of id-storage.
  const rename = await request.patch(
    `/api/external/v1/contact-fields/${field.id}/options/${crm.id}`,
    { headers: auth, data: { name: "CRM Renamed" } },
  );
  expect(rename.ok()).toBeTruthy();
  const afterRename = await db().contact.findUniqueOrThrow({
    where: { id: contactId },
    select: { customFields: true },
  });
  expect((afterRename.customFields as Record<string, string>)[FIELD_KEY]).toBe(crm.id);
});
