import { test, expect } from "@playwright/test";

/**
 * Two AI-assistant settings defects reported 2026-08-20 (org owner on a
 * MacBook vs an admin on Windows, same workspace):
 *
 * 1. Save failed with an unactionable error. RowList's "+ Add" appends `{}`,
 *    and the API schemas require fields on every row — so ONE forgotten blank
 *    row (an empty FAQ, holiday, or exception) failed the WHOLE save with
 *    "Validation failed" naming nothing. Untouched rows are now dropped before
 *    the PUT, and a genuinely invalid row's error names its field.
 *
 * 2. Unset schedule days showed a phantom time (e.g. "12:05") on macOS.
 *    Documented Safari 16+ bug: WebKit paints the current wall-clock time as
 *    ghost text inside an EMPTY <input type="time"> — and makes it
 *    non-editable. The editor no longer renders empty time inputs at all:
 *    closed days are a "Closed · Set hours" row, matching the availability
 *    and calling-hours editors.
 */

test("a stray empty FAQ row no longer blocks saving the AI settings", async ({ page }) => {
  await page.goto("/settings/ai-assistant");
  await expect(page.getByRole("heading", { name: "AI Assistant" })).toBeVisible({
    timeout: 30_000,
  });

  // Company identity — the tab the owner was filling when the save failed.
  await page.getByLabel("Company name").fill("E2E Co");

  // Plant the trap: an FAQ row added and never typed into. (FAQs require both
  // question and answer server-side, so an untouched row used to sink the save.)
  await page.getByRole("tab", { name: "Business Details" }).click();
  // The wrapping <Field label="FAQs"> makes "FAQs" the button's accessible
  // name; its visible text is "+ Add".
  await page.getByRole("button", { name: "FAQs" }).click();
  await expect(page.getByPlaceholder("Question").last()).toHaveValue("");

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("AI Assistant settings saved")).toBeVisible({
    timeout: 15_000,
  });
});

test("schedule days are Closed/Set-hours rows — no empty time inputs for Safari to haunt", async ({
  page,
}) => {
  await page.goto("/settings/ai-assistant");
  await expect(page.getByRole("heading", { name: "AI Assistant" })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("tab", { name: "Opening Hours" }).click();

  // Every rendered time input must carry a value — an empty one is exactly
  // what Safari 16+ ghosts a fake time into and refuses to let you edit.
  const empties = await page
    .locator('input[type="time"]')
    .evaluateAll((els) => els.filter((el) => (el as HTMLInputElement).value === "").length);
  expect(empties).toBe(0);

  // Open a closed day: seeded with editable defaults, not blank.
  const setHours = page.getByRole("button", { name: "Set hours" }).first();
  await expect(setHours).toBeVisible();
  await setHours.click();
  const monday = page.getByLabel("Monday — opening time");
  await expect(monday).toHaveValue("09:00");
  await monday.fill("08:30");
  await expect(monday).toHaveValue("08:30");

  // And close it again — back to the Closed row, no orphaned inputs.
  await page.getByRole("button", { name: "Mark Monday closed" }).click();
  await expect(page.getByLabel("Monday — opening time")).toHaveCount(0);

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("AI Assistant settings saved")).toBeVisible({
    timeout: 15_000,
  });
});
