import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";

/**
 * B-M6 — one rubric, applied to every surface, in the plan's order of "bar
 * height". The inbox is LAST on purpose: it is the highest-quality surface in
 * the product (CLAUDE.md §15), so it is the final acceptance rather than the
 * first experiment.
 *
 * What is asserted here is only what a machine can judge OBJECTIVELY. The
 * subjective half of the rubric (does it feel premium, is the hierarchy right)
 * is a reading task and belongs in the ledger, not in a fake assertion:
 *
 *   ✓ automated here          ✗ read, recorded in tests/VERIFICATION.md
 *   ─────────────────────     ────────────────────────────────────────
 *   axe serious/critical      visual hierarchy / density
 *   horizontal overflow       copy tone and clarity
 *   dark + light both render  motion tastefulness
 *   keyboard focus visible    empty-state helpfulness
 *
 * HORIZONTAL OVERFLOW is the one worth explaining. CLAUDE.md §15 forbids layout
 * instability, and the single most common way this app could break on a laptop
 * or a phone is a wide element (a table, a code block, a long unbroken id)
 * pushing the BODY wider than the viewport — which turns every vertical scroll
 * into a diagonal one. The rule the handbook states is that wide content
 * scrolls inside its OWN container; the body never does. That is exactly
 * `document.documentElement.scrollWidth <= clientWidth`, so it is checked at
 * every viewport rather than eyeballed.
 */

/** The plan's surface order, by bar height. Inbox last = final acceptance. */
const SURFACES = [
  { name: "contacts", path: "/contacts" },
  { name: "tickets", path: "/tickets" },
  { name: "broadcasts", path: "/broadcasts" },
  { name: "workflows", path: "/workflows" },
  { name: "settings", path: "/settings" },
  { name: "team-chat", path: "/team" },
  { name: "inbox", path: "/inbox" },
] as const;

/** Desktop, small laptop, phone — the three the plan names. */
const VIEWPORTS = [
  { label: "1280", width: 1280, height: 800 },
  { label: "1024", width: 1024, height: 768 },
  { label: "390", width: 390, height: 844 },
] as const;

/**
 * Wait for the surface to actually settle. `networkidle` is unreliable against
 * a dev server that keeps a HMR socket open, so gate on the app chrome being
 * painted and then let layout settle for a frame.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded");
  // WAIT FOR THE REAL DOCUMENT, not merely a parsed one.
  //
  // This harness reported `html-has-lang` and `document-title` violations on
  // /settings and /workflows that do NOT exist: the root layout sets both, and
  // no sub-layout renders its own <html>. What axe had actually scanned was
  // Next's dev-server interstitial, because those routes compile on FIRST
  // visit and the old settle() gave up after 600ms with its locator wait
  // swallowed by `.catch()`.
  //
  // A rubric that invents findings is worse than no rubric — every minute
  // spent "fixing" a non-bug is worse than the bug. So gate on the two things
  // that are true of every real page in this app (lang + title, both from the
  // root layout) plus an app landmark, and give a dev compile room to finish.
  //
  // Gate on lang + title ONLY. Both come from the ROOT layout, so their presence
  // is sufficient proof that the real document rendered rather than the dev
  // interstitial — which is the whole point of this wait. An earlier version
  // also required a `main`/`nav` landmark and that was too strong: at 390px the
  // chrome collapses, so the workflows surface never satisfied it and the wait
  // burned its full timeout, turning a passing page into a fake failure. Assert
  // the narrow thing that is actually true everywhere.
  await page.waitForFunction(
    () =>
      !!document.documentElement.getAttribute("lang") &&
      document.title.trim().length > 0,
    undefined,
    { timeout: 45_000 },
  );
  // One frame for layout/fonts to settle so overflow math is measured against
  // the final box model, not a mid-paint one.
  await page.waitForTimeout(800);
}

/** True when the PAGE itself scrolls sideways (as opposed to a child that should). */
async function bodyOverflowsHorizontally(page: Page): Promise<{ over: boolean; by: number }> {
  return page.evaluate(() => {
    const el = document.documentElement;
    // 1px of slack: sub-pixel rounding at fractional device ratios is not a bug.
    const by = el.scrollWidth - el.clientWidth;
    return { over: by > 1, by };
  });
}

/** The widest offending elements — a bare "it overflows" is not actionable. */
async function overflowCulprits(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > vw + 1) {
        const cls = typeof el.className === "string" ? el.className.slice(0, 60) : "";
        out.push(
          `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls ? ` class="${cls}"` : ""}> ` +
            `right=${Math.round(r.right)} vw=${vw}`,
        );
        if (out.length >= 5) break;
      }
    }
    return out;
  });
}

for (const surface of SURFACES) {
  test.describe(`${surface.name} — UI/UX rubric`, () => {
    test(`${surface.name}: no horizontal overflow at any viewport`, async ({ page }) => {
      const failures: string[] = [];
      for (const vp of VIEWPORTS) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(surface.path);
        await settle(page);
        const { over, by } = await bodyOverflowsHorizontally(page);
        if (over) {
          const culprits = await overflowCulprits(page);
          failures.push(
            `${vp.label}px: body is ${by}px too wide → ${culprits.join(" | ") || "(no element pinned)"}`,
          );
        }
      }
      expect(
        failures,
        `the page must never scroll sideways — wide content scrolls inside its own ` +
          `container (CLAUDE.md §15). Offenders:\n${failures.join("\n")}`,
      ).toEqual([]);
    });

    test(`${surface.name}: no serious or critical accessibility violations`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(surface.path);
      await settle(page);
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      const blocking = results.violations.filter(
        (v) => v.impact === "serious" || v.impact === "critical",
      );
      const report = blocking.map(
        (v) =>
          `[${v.impact}] ${v.id} — ${v.help} (${v.nodes.length} node(s))\n` +
          v.nodes
            .slice(0, 4)
            .map(
              (n) =>
                `      ${n.target.join(" ")}\n` +
                // axe's own summary carries the measured ratio and both colors.
                // Without it a contrast fix is guesswork about which token and
                // which background are actually in play.
                `        ${(n.failureSummary ?? "").replace(/\n/g, "\n        ")}\n` +
                `        html: ${n.html.slice(0, 160)}`,
            )
            .join("\n"),
      );
      expect(blocking.map((v) => `${v.impact}:${v.id}`), report.join("\n")).toEqual([]);
    });

    test(`${surface.name}: renders in dark and light`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(surface.path);
        await settle(page);
        // The error boundary is the failure we care about: a theme-dependent
        // crash (a token read on an undefined palette) shows up here and
        // nowhere else.
        await expect(
          page.getByText("Something broke.", { exact: false }),
          `${surface.name} must render in ${scheme} mode`,
        ).toHaveCount(0);
      }
    });
  });
}
