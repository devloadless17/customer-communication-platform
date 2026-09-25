import type { Locator } from "@playwright/test";

/**
 * Wait until React has HYDRATED the element — attached its event handlers.
 *
 * A server-rendered control is visible, stable, and "clickable" by Playwright's
 * actionability checks BEFORE React hydrates it, and a click in that window is
 * simply lost: nothing is listening yet. The dev build's JavaScript can take
 * seconds to execute, so a spec that clicks right after `page.goto` passed or
 * failed on timing alone — the contact drawer and the contacts "Next page"
 * button both did, cold AND warm.
 *
 * Measured, not assumed (2026-09-26): on /contacts the row button had no React
 * props at the moment it became visible and an immediate click opened nothing;
 * waiting for hydration (≈250ms warm) and clicking once opened the drawer.
 *
 * React stamps every element it owns with a `__reactProps$<id>` key when it
 * creates or hydrates it — the signal waited on here.
 */
export async function waitForHydrated(locator: Locator, timeout = 30_000): Promise<void> {
  const target = locator.first();
  await target.waitFor({ state: "visible", timeout });
  const deadline = Date.now() + timeout;
  for (;;) {
    // Re-resolved on EVERY check, from this side. The element can be REPLACED
    // after first paint — /contacts re-renders its pagination footer once its
    // data loads — and polling one captured node would watch a detached
    // element that never hydrates. The same replacement is why a click that
    // raced it was lost.
    const hydrated = await target
      .evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$")))
      .catch(() => false);
    if (hydrated) return;
    if (Date.now() > deadline) {
      throw new Error(`element was never hydrated within ${timeout}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
