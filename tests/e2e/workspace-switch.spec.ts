import { test, expect } from "@playwright/test";

import { db, superadminTeam } from "./_helpers/db";

/**
 * The workspace switcher, driven through the real UI.
 *
 * This exists because of a bug that no unit test could have caught: the
 * switcher POSTed a JSON body through `apiFetch`, which did NOT default
 * `content-type: application/json`. Express skipped the unparsed body, the
 * route saw `{}`, Zod rejected it, and the 400 was swallowed by a silent
 * `return` — so clicking a workspace did *nothing at all*, with no error, no
 * navigation, and nothing in the console.
 *
 * Every layer was individually "fine". Only clicking the thing finds it, which
 * is exactly what this spec does.
 */

const SECOND_WORKSPACE = "E2E Switch Target";

let secondWorkspaceId = "";

test.beforeAll(async () => {
  const { workspaceId } = await superadminTeam();
  const base = await db().workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { organizationId: true },
  });

  // A SECOND workspace in the same org, with the app-admin as a member — the
  // switcher only offers workspaces you can actually act in.
  const existing = await db().workspace.findFirst({
    where: { organizationId: base.organizationId, name: SECOND_WORKSPACE },
    select: { id: true },
  });
  secondWorkspaceId =
    existing?.id ??
    (
      await db().workspace.create({
        data: { name: SECOND_WORKSPACE, organizationId: base.organizationId },
        select: { id: true },
      })
    ).id;

  const members = await db().workspaceMember.findMany({
    where: { workspaceId },
    select: { userId: true },
  });
  for (const m of members) {
    await db().workspaceMember.upsert({
      where: { userId_workspaceId: { userId: m.userId, workspaceId: secondWorkspaceId } },
      create: { userId: m.userId, workspaceId: secondWorkspaceId, role: "admin" },
      update: {},
    });
  }
});

test.afterAll(async () => {
  // Put every session back on the original workspace so later specs aren't
  // silently scoped to the throwaway one.
  const { workspaceId } = await superadminTeam();
  await db().session.updateMany({
    where: { activeWorkspaceId: secondWorkspaceId },
    data: { activeWorkspaceId: workspaceId },
  });
  await db().workspaceMember.deleteMany({ where: { workspaceId: secondWorkspaceId } });
  await db().workspace.deleteMany({ where: { id: secondWorkspaceId } });
});

test("clicking a workspace in the switcher actually switches to it", async ({ page }) => {
  await page.goto("/inbox");

  // The rail badge IS the switcher trigger.
  await page.getByRole("button", { name: "Switch workspace" }).click();

  const target = page.getByRole("menuitem", { name: SECOND_WORKSPACE });
  await expect(target).toBeVisible();
  await target.click();

  // A switch is a FULL navigation (the socket must re-handshake into the new
  // `ws:` room), so the tab lands back on /inbox — and, critically, the rail
  // now shows the new workspace. Asserting only the URL would have passed even
  // while the switch silently failed.
  await page.waitForURL(/\/inbox/, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Switch workspace" })).toContainText(
    SECOND_WORKSPACE,
    { timeout: 20_000 },
  );

  // And the server agrees — the durable per-device choice was persisted, not
  // just painted client-side.
  await expect
    .poll(
      async () =>
        db().session.count({ where: { activeWorkspaceId: secondWorkspaceId } }),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
});

test("the switcher shows the organization above its workspaces", async ({ page }) => {
  await page.goto("/inbox");
  await page.getByRole("button", { name: "Switch workspace" }).click();

  // The dropdown is where the org → workspace hierarchy is discoverable, so
  // both levels must be present — this is the fix for "I don't get how
  // organization/workspaces is set up".
  await expect(page.getByText("Organization", { exact: true })).toBeVisible();
  await expect(page.getByText("Workspaces", { exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /New workspace/ })).toBeVisible();
});
