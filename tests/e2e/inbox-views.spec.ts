import { test, expect } from "@playwright/test";

import { db, superadminTeam } from "./_helpers/db";

/**
 * Saved inbox views, driven through the real UI.
 *
 * The unit spec proves the RULES (visibility boundary, WHERE composition,
 * dangling-id policy). This proves the WIRING — the part no unit test can see:
 *
 *   - the builder dialog actually POSTs and the view appears in the rail,
 *   - clicking it changes the conversation list (and its header),
 *   - the choice survives a reload (the `v:` cookie + the layout's re-validation),
 *   - deleting the ACTIVE view falls back instead of stranding the list on an
 *     id that 404s on every request.
 *
 * That last one is the specific failure this file is worth having for: every
 * layer is individually fine, and the inbox is simply empty forever.
 *
 *   E2E_BASE_URL=http://localhost:3000 npx playwright test tests/e2e/inbox-views.spec.ts --project=chromium
 */

const VIEW_NAME = `E2E Unassigned ${Date.now().toString().slice(-6)}`;

test.afterAll(async () => {
  // Clean up after ourselves — a spec that leaves rows behind makes the NEXT
  // run's "views" rail non-deterministic, and the per-scope cap real.
  await db()
    .inboxView.deleteMany({ where: { name: { startsWith: "E2E Unassigned" } } })
    .catch(() => undefined);
});

test("create a view, filter by it, and survive a reload", async ({ page }) => {
  test.setTimeout(120_000);
  await superadminTeam();

  await page.goto("/inbox");

  // The rail section must exist before anything else is meaningful.
  const rail = page.locator("aside");
  await expect(rail.getByRole("button", { name: "Views", exact: true })).toBeVisible({
    timeout: 45_000,
  });

  await rail.getByRole("button", { name: "New view" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Name").fill(VIEW_NAME);

  // Two criteria, so the summary line has something real to read back.
  await dialog.getByRole("button", { name: "Open", exact: true }).click();
  await dialog.getByRole("button", { name: "Unassigned", exact: true }).click();

  // The live summary is the dialog's whole payoff — it must reflect the
  // clicks, not a stale render.
  await expect(dialog.getByText("Open · Unassigned")).toBeVisible();

  await dialog.getByRole("button", { name: "Create view" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });

  // It lands in the rail AND becomes the active filter (creating a view is a
  // request to look at it).
  // Target by `title`, not by accessible name: the row button and its
  // "Actions for …" menu trigger both carry the view name, so a name-based
  // locator is a strict-mode collision rather than an assertion. The title is
  // `"<name> — <summary>"`, which only the row has.
  const viewRow = rail.locator(`button[title^="${VIEW_NAME} "]`);
  await expect(viewRow).toBeVisible();
  await expect(viewRow).toHaveAttribute("aria-pressed", "true");

  // The list header follows the active view — proof the page island and the
  // layout rail agree about which filter is live.
  await expect(page.getByRole("heading", { name: VIEW_NAME })).toBeVisible({
    timeout: 15_000,
  });

  // Survives a hard reload: the `v:<id>` cookie round-trips and the layout
  // re-validates the id against the views it loaded.
  await page.reload();
  await expect(page.getByRole("heading", { name: VIEW_NAME })).toBeVisible({
    timeout: 45_000,
  });
});

test("deleting the active view falls back instead of stranding the list", async ({ page }) => {
  test.setTimeout(120_000);
  await superadminTeam();

  const name = `E2E Unassigned del ${Date.now().toString().slice(-6)}`;
  await page.goto("/inbox");

  const rail = page.locator("aside");
  await expect(rail.getByRole("button", { name: "Views", exact: true })).toBeVisible({
    timeout: 45_000,
  });
  await rail.getByRole("button", { name: "New view" }).click();

  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByRole("button", { name: "Create view" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });

  const viewRow = rail.locator(`button[title^="${name} "]`);
  await expect(viewRow).toHaveAttribute("aria-pressed", "true");

  // Delete it while it is the ACTIVE filter.
  await rail.getByRole("button", { name: `Actions for ${name}` }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete view" }).click();

  await expect(viewRow).toBeHidden({ timeout: 15_000 });

  // The list must NOT be stuck asking for a deleted id. It falls back to the
  // default preset, which renders its own header.
  await expect(page.getByRole("heading", { name: "Active", exact: true })).toBeVisible({
    timeout: 15_000,
  });
});
