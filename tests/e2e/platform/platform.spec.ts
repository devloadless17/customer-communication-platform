import { test, expect } from "@playwright/test";

import { db } from "../_helpers/db";

/**
 * Platform (super-admin) surface + the org-approval gate, end-to-end against
 * the prod-imitate stack. Added 2026-06-10 with the org-approval feature.
 *
 * Uses the SUPERADMIN storageState (the customer-app specs use app-admin) —
 * the super-admin lives only in the platform shell.
 */
test.use({ storageState: "tests/e2e/.auth/superadmin.json" });

test.describe("platform shell", () => {
  test("super-admin lands on /platform with Overview + Organizations nav", async ({ page }) => {
    await page.goto("/platform");
    await expect(page.getByRole("heading", { name: /overview/i })).toBeVisible();
    // The dedicated platform rail — NOT the customer AppRail.
    await expect(page.getByRole("link", { name: /organizations/i }).first()).toBeVisible();
    // Customer-app nav must NOT be present in the platform shell.
    await expect(page.getByRole("link", { name: /^inbox$/i })).toHaveCount(0);
  });

  test("super-admin is blocked from the customer app (/inbox → /platform)", async ({ page }) => {
    await page.goto("/inbox");
    await expect(page).toHaveURL(/\/platform/);
  });

  test("organizations list renders", async ({ page }) => {
    await page.goto("/platform/organizations");
    await expect(page.getByRole("heading", { name: /organizations/i })).toBeVisible();
  });
});

test.describe("org-approval gate (register → approve → suspend)", () => {
  // One throwaway org per run; cleaned up at the end.
  const email = `e2e-gate-${Date.now()}@example.com`;
  const password = "Test1234!";
  let organizationId: string | null = null;
  let workspaceId: string | null = null;

  test.afterAll(async () => {
    if (organizationId) {
      // Deleting the ORG cascades to its workspace(s) AND its users.
      await db().organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    }
  });

  test("pending org is gated, approval lets it in, suspend cuts it off", async ({
    page,
    browser,
  }) => {
    // ── 1. A brand-new org self-registers in a CLEAN (no-session) context ──
    const orgContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const orgPage = await orgContext.newPage();
    await orgPage.goto("/register");
    await orgPage.fill('input[name="orgName"]', "E2E Gate Co");
    await orgPage.fill('input[name="name"]', "Gate Admin");
    await orgPage.fill('input[name="email"]', email);
    await orgPage.fill('input[name="password"]', password);
    await orgPage.fill('input[name="confirmPassword"]', password);
    await Promise.all([
      orgPage.waitForURL(/\/pending/, { timeout: 30_000 }),
      orgPage.click('button[type="submit"]'),
    ]);
    // The gate screen renders — the org is created but locked out. Match the
    // heading specifically (the page <title> also echoes via Next's route
    // announcer, which would make a bare getByText non-strict).
    await expect(
      orgPage.getByRole("heading", { name: /awaiting approval/i }),
    ).toBeVisible();

    // Resolve the new org's id by its admin email (precise — not "newest pending").
    const created = await db().user.findFirst({
      where: { email },
      select: { organizationId: true },
    });
    expect(created?.organizationId, "new org row exists").toBeTruthy();
    organizationId = created!.organizationId;
    // The signup provisions exactly one starter workspace under the new org.
    const ws = await db().workspace.findFirstOrThrow({
      where: { organizationId: organizationId! },
      select: { id: true },
    });
    workspaceId = ws.id;
    expect(
      (await db().organization.findUnique({ where: { id: organizationId! }, select: { status: true } }))?.status,
    ).toBe("pending");

    // A pending org can't reach the customer app even with its session.
    await orgPage.goto("/inbox");
    await expect(orgPage).toHaveURL(/\/pending/);

    // ── 2. Super-admin APPROVES via the platform UI ──
    await page.goto(`/platform/organizations/${workspaceId}`);
    await page.getByRole("button", { name: /approve organization/i }).click();
    // Status flips to Active (the Approve button is replaced by Suspend).
    await expect(page.getByRole("button", { name: /suspend access/i })).toBeVisible({
      timeout: 15_000,
    });
    expect(
      (await db().organization.findUnique({ where: { id: organizationId! }, select: { status: true } }))?.status,
    ).toBe("active");

    // ── 3. The org admin can now use the app (approve busts their session cache) ──
    await orgPage.goto("/");
    await expect(orgPage).toHaveURL(/\/inbox/, { timeout: 15_000 });

    // ── 4. Super-admin SUSPENDS ──
    await page.goto(`/platform/organizations/${workspaceId}`);
    await page.getByRole("button", { name: /suspend access/i }).click();
    await page.getByRole("button", { name: /confirm suspend/i }).click();
    await expect(page.getByRole("button", { name: /reactivate/i })).toBeVisible({
      timeout: 15_000,
    });
    expect(
      (await db().organization.findUnique({ where: { id: organizationId! }, select: { status: true } }))?.status,
    ).toBe("suspended");

    // ── 5. The org admin is locked out again ──
    await orgPage.goto("/inbox");
    await expect(orgPage).toHaveURL(/\/pending/, { timeout: 15_000 });
    await expect(
      orgPage.getByRole("heading", { name: /suspended/i }),
    ).toBeVisible();

    await orgContext.close();
  });
});
