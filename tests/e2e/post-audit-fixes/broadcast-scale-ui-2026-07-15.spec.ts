/**
 * Large-broadcast UI states (2026-07-15): the `materializing` status a broadcast
 * sits in while its recipients are inserted asynchronously (audiences too big to
 * build in the create request). Asserts:
 *   - the list badge renders "Preparing recipients" (spinner tone), and
 *   - the detail page shows the materializing copy + a "Stop broadcast" control.
 *
 * SAFE / self-cleaning: seeds ONE broadcast under the admin team with an
 * `e2e_scale_` templateName prefix and deletes only that in afterAll. It does
 * NOT call wipeTestData, so it never touches the maintainer's real inbox data
 * (unlike the older destructive broadcast specs).
 */
import { test, expect } from "@playwright/test";
import { db, appAdmin } from "../_helpers/db";

test.describe.configure({ mode: "serial" });

const PREFIX = "e2e_scale_";
let teamId: string;
let broadcastId: string;

test.beforeAll(async () => {
  const su = await appAdmin();
  teamId = su.teamId;
  // A broadcast frozen in `materializing` — as if its large audience is still
  // being inserted by the materialize worker. Provisional totalCount, no
  // recipients yet (the worker would add them). No wipe: this is the only row
  // we touch and we purge it by id below.
  const b = await db().broadcast.create({
    data: {
      teamId,
      status: "materializing",
      kind: "template",
      targetMode: "contact",
      channel: "whatsapp",
      templateName: `${PREFIX}ramadan_promo`,
      templateLanguage: "en",
      variables: { body: [] },
      audienceMode: "all",
      totalCount: 50_000,
    },
    select: { id: true },
  });
  broadcastId = b.id;
});

test.afterAll(async () => {
  await db()
    .broadcast.deleteMany({ where: { templateName: { startsWith: PREFIX } } })
    .catch(() => undefined);
  await db().$disconnect();
});

test("list shows the 'Preparing recipients' badge for a materializing broadcast", async ({
  page,
}) => {
  await page.goto("/broadcasts");
  // The list renders responsive double-DOM (mobile cards + desktop table), so a
  // `.first()` may resolve a display:none copy — assert the label RENDERS
  // (count ≥ 1) rather than fighting which copy is visible at the test viewport.
  await expect
    .poll(() => page.getByText("e2e_scale_ramadan_promo").count(), { timeout: 30_000 })
    .toBeGreaterThan(0);
  await expect(page.getByText("Preparing recipients").first()).toBeAttached();
});

test("detail page shows materializing progress copy + a Stop control", async ({ page }) => {
  await page.goto(`/broadcasts/${broadcastId}`);
  // Provisional recipient count + the "sending starts automatically" reassurance.
  await expect(page.getByText(/Preparing 50,000 recipients/)).toBeVisible({ timeout: 30_000 });
  // A materializing broadcast is cancelable — the Stop control is present.
  await expect(page.getByRole("button", { name: /Stop broadcast/i })).toBeVisible();
});
