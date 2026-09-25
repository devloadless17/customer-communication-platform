/**
 * Assignment settings: TWO saves in ONE gesture must BOTH land.
 *
 * The name, keyword and "Wait … minutes" inputs are uncontrolled and save on
 * blur. So typing into one and then clicking a switch fires the input's blur (a
 * save) and the switch's change in the same gesture. A one-save-at-a-time guard
 * (`if (inFlight) return`) discarded the second with no feedback — and because
 * the input is uncontrolled, in the other order it kept SHOWING a value the
 * server never received.
 *
 * The saves are now queued and coalesced instead of dropped. These cases assert
 * the only thing that matters: the DATABASE, after the gesture. The automation
 * case also asserts the queued save carried the FRESH version, because a stale
 * one earns a 409 and a false "someone else changed these settings" toast.
 *
 *   pnpm exec playwright test tests/e2e/assignment-settings-saves.spec.ts
 */
import { test, expect } from "@playwright/test";

import { db, appAdmin } from "./_helpers/db";

const RUN = Date.now().toString().slice(-6);

let workspaceId: string;
/**
 * The settings row as it was BEFORE this file ran. The workspace is shared by
 * every e2e spec, and leaving `reassignOnOffline` on puts it on the
 * offline-rebalance sweeper, which really reassigns conversations under later
 * specs that never asked for it.
 */
let settingsBefore: {
  reassignOnOffline: boolean;
  reassignOfflineAfterMinutes: number;
  reassignOnDeactivate: boolean;
} | null = null;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  ({ workspaceId } = await appAdmin());
  settingsBefore = await db().assignmentSettings.findUnique({
    where: { workspaceId },
    select: { reassignOnOffline: true, reassignOfflineAfterMinutes: true, reassignOnDeactivate: true },
  });
});

test.afterAll(async () => {
  await db().assignmentRule.deleteMany({ where: { workspaceId, name: { contains: RUN } } });
  await db().team.deleteMany({ where: { workspaceId, name: `Saves E2E ${RUN}` } });
  if (settingsBefore) {
    await db().assignmentSettings.update({ where: { workspaceId }, data: settingsBefore });
  } else {
    // There was no row: remove the one this file created, back to defaults.
    await db().assignmentSettings.deleteMany({ where: { workspaceId } });
  }
});

test("rules: renaming then toggling in one gesture saves BOTH", async ({ page }) => {
  const policy = await db().team.create({ data: { workspaceId, name: `Saves E2E ${RUN}` } });
  const rule = await db().assignmentRule.create({
    data: {
      workspaceId,
      name: `Rule ${RUN}`,
      policyId: policy.id,
      position: 999,
      enabled: true,
      conditions: {},
    },
  });

  await page.goto("/settings/assignment");
  await page.getByRole("tab", { name: "Routing rules", exact: true }).click();

  const nameInput = page.locator(`input[value="Rule ${RUN}"]`);
  await expect(nameInput).toBeVisible({ timeout: 30_000 });
  await nameInput.fill(`Renamed ${RUN}`);
  // No blur yet: the click below is what blurs the input, so the rename's save
  // and the switch's save start in the same gesture — the case that lost one.
  const row = nameInput.locator("xpath=..");
  await row.getByRole("switch").click();

  await expect
    .poll(
      async () => {
        const r = await db().assignmentRule.findUnique({
          where: { id: rule.id },
          select: { name: true, enabled: true },
        });
        return r ? `${r.name}|${r.enabled}` : "missing";
      },
      { timeout: 20_000 },
    )
    .toBe(`Renamed ${RUN}|false`);
});

test("automation: typing minutes then flipping a toggle saves BOTH, with no false conflict", async ({
  page,
}) => {
  await db().assignmentSettings.upsert({
    where: { workspaceId },
    create: { workspaceId, reassignOnOffline: true, reassignOfflineAfterMinutes: 10 },
    update: { reassignOnOffline: true, reassignOfflineAfterMinutes: 10 },
  });
  const before = await db().assignmentSettings.findUniqueOrThrow({
    where: { workspaceId },
    select: { reassignOnDeactivate: true },
  });

  await page.goto("/settings/assignment");
  await page.getByRole("tab", { name: "When it runs", exact: true }).click();

  const minutes = page.locator('input[type="number"]').first();
  await expect(minutes).toBeVisible({ timeout: 30_000 });
  await minutes.fill("45");
  await page.getByRole("switch", { name: "Reassign when a teammate is deactivated" }).click();

  await expect
    .poll(
      async () => {
        const s = await db().assignmentSettings.findUniqueOrThrow({
          where: { workspaceId },
          select: { reassignOfflineAfterMinutes: true, reassignOnDeactivate: true },
        });
        return `${s.reassignOfflineAfterMinutes}|${s.reassignOnDeactivate}`;
      },
      { timeout: 20_000 },
    )
    .toBe(`45|${!before.reassignOnDeactivate}`);

  // A queued save built on the stale `settings.version` would have 409'd.
  await expect(page.getByText("Someone else changed these settings")).toHaveCount(0);
});
