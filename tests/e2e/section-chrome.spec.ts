import { test, expect } from "@playwright/test";

/**
 * Every section renders its own left rail, and ticket/flag views are real URLs.
 *
 * This exists because /tickets and /flags shipped WITHOUT a layout: they
 * rendered bare inside the app shell — no sub-sidebar, no padding, the page
 * title flush against the viewport edge — while every sibling section had one.
 * Nothing failed; it just looked broken, which no unit test can see.
 *
 * The assertions are deliberately structural (does the section have its rail,
 * does a view change the URL and the selection) rather than pixel-based, so
 * they keep their meaning through restyling.
 */

/** Sections with a contextual left rail, and a heading unique to each rail. */
const SECTIONS = [
  { path: "/tickets", rail: "Tickets", item: "Assigned to me" },
  { path: "/flags", rail: "Flagged", item: "Assigned to me" },
  { path: "/settings", rail: "Workspace settings", item: "Members" },
  { path: "/organization", rail: "Organization settings", item: "Workspaces" },
  { path: "/account", rail: "Personal settings", item: "Notifications" },
] as const;

for (const section of SECTIONS) {
  test(`${section.path} renders its own sub-sidebar`, async ({ page }) => {
    // Generous: a cold dev server compiles the route on first hit, which can
    // take ~30s and has nothing to do with what is under test.
    test.setTimeout(90_000);
    await page.goto(section.path);
    // Scoped to the sidebar element on purpose. Several sections name their
    // rail the same as their page <h1> ("Tickets"), so an unscoped heading
    // lookup is a strict-mode collision rather than a real assertion.
    await expect(
      page.locator("aside").getByRole("heading", { name: section.rail, exact: true }).first(),
    ).toBeVisible({ timeout: 45_000 });
    await expect(
      page.locator("aside").getByRole("link", { name: section.item }).first(),
    ).toBeVisible();
  });
}

test("ticket views are linkable URLs, not hidden component state", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/tickets");
  await page.locator("aside").getByRole("link", { name: "Assigned to me" }).click();

  // A view must survive being copied into another tab — that is the whole
  // reason it lives in the URL rather than in useState.
  await expect(page).toHaveURL(/\/tickets\?view=mine/);

  await page.reload();
  await expect(page).toHaveURL(/\/tickets\?view=mine/);
  // …and the reloaded page still shows it selected.
  await expect(
    page.locator("aside").getByRole("link", { name: "Assigned to me" }),
  ).toHaveAttribute("aria-current", /page|true/);
});

test("flag views keep the other filters when you switch one", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/flags");
  await page.locator("aside").getByRole("link", { name: "Assigned to me" }).click();
  await expect(page).toHaveURL(/assignee=me/);

  // Switching the flag TYPE must not silently drop the assignee filter — the
  // classic "each filter resets the others" bug.
  //
  // Target by HREF, not by label: the only unambiguous marker of a flag-type
  // link is that it sets `definitionId`. Matching on text picked up the
  // "Flag types" settings link in the Configure group instead.
  const flagType = page.locator('aside a[href*="definitionId="]').first();
  if ((await flagType.count()) === 0) {
    // This workspace has no flag definitions, so there is no second filter to
    // compose with. Skip loudly rather than assert something vacuous.
    test.skip(true, "workspace has no flag definitions to filter by");
    return;
  }
  await flagType.click();

  await expect(page).toHaveURL(/definitionId=/);
  // The assignee filter survived — that is the whole point.
  await expect(page).toHaveURL(/assignee=me/);
});
