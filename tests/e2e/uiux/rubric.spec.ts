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
 *   cumulative layout shift
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

declare global {
  interface Window {
    /** Accumulated layout-shift score, summed by the observer below. */
    __cls?: number;
    /** Previously focused node, for by-reference identity across Tab presses. */
    __prevFocus?: Element | null;
  }
}

/** The plan's surface order, by bar height. Inbox last = final acceptance. */
const SURFACES = [
  { name: "contacts", path: "/contacts" },
  { name: "tickets", path: "/tickets" },
  { name: "broadcasts", path: "/broadcasts" },
  { name: "workflows", path: "/workflows" },
  // Added 2026-07-29. `/reports` is a 528-line client dashboard that shipped in
  // the unaudited delta and had never been through this rubric — the suite
  // stayed at 53 checks across the whole feature landing, which is precisely
  // how the settings subpages went unscanned until the deep sweep found 10 of
  // 16 failing. A surface the rubric does not name is a surface the rubric
  // cannot vouch for, however green the total looks.
  { name: "reports", path: "/reports" },
  { name: "settings", path: "/settings" },
  // Added 2026-07-31 (structure program): four whole feature landings had
  // never been through the full rubric — same class as /reports above.
  { name: "flags", path: "/flags" },
  { name: "templates", path: "/templates" },
  { name: "organization", path: "/organization" },
  { name: "account", path: "/account" },
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
  try {
    await page.waitForFunction(
      () =>
        !!document.documentElement.getAttribute("lang") &&
        document.title.trim().length > 0,
      undefined,
      { timeout: 45_000 },
    );
  } catch (err) {
    // Next's dev error overlay can take the document over, and then this wait
    // dies after 45s with "Timeout exceeded" — which says nothing about the
    // actual problem. Surface the overlay's own message instead: an opaque
    // hang is the least actionable failure a harness can produce.
    const overlay = await page
      .locator("nextjs-portal")
      .first()
      .innerText()
      .catch(() => "");
    if (overlay.trim()) {
      throw new Error(
        `page did not settle — Next dev overlay is showing:\n${overlay.slice(0, 600)}`,
      );
    }
    throw err;
  }
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

    test(`${surface.name}: keyboard focus is always visible and never lost`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(surface.path);
      await settle(page);

      // Tab through the first stretch of the tab order.
      //
      // WHAT IS *NOT* A BUG, learned the hard way: focus reaching <body> is the
      // browser WRAPPING its tab order after the last control — completely
      // normal. An earlier version of this test called that "stranded" and so
      // failed all seven surfaces at once, which would have been reported as
      // "keyboard navigation is broken app-wide". It isn't. When a check fails
      // everywhere identically, suspect the check.
      //
      // What genuinely matters, and is asserted below:
      //   NAVIGABLE — a real number of distinct controls actually receive
      //               focus, so the surface can be operated without a mouse.
      //   VISIBLE   — every focused control shows an indicator. Tailwind draws
      //               focus with `ring`, i.e. a box-shadow, so testing outline
      //               alone would be wrong.
      //   NOT STUCK — focus keeps advancing rather than pinning to one element.
      const STEPS = 25;
      const invisible: string[] = [];
      const seen = new Set<string>();
      let stuckRun = 0;
      let worstStuck = 0;

      for (let i = 0; i < STEPS; i++) {
        await page.keyboard.press("Tab");
        const info = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          // IDENTITY IS COMPARED IN PAGE CONTEXT, by reference. A previous
          // version compared a className-derived label and reported every
          // surface as "trapped", because a row of buttons that share classes
          // produced identical labels — two different elements looked like one
          // stuck element. Only the DOM node itself is a reliable identity.
          const changed = el !== (window.__prevFocus ?? null);
          window.__prevFocus = el;
          if (!el || el === document.body) return { tag: "BODY", visible: true, changed };
          const cs = getComputedStyle(el);
          const outline =
            cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth || "0") > 0;
          const shadow = cs.boxShadow !== "none" && cs.boxShadow.trim().length > 0;
          // AN INDICATOR MAY BE DRAWN ON A DESCENDANT. The inbox resize handle
          // is the case that taught this: it is a correctly-built separator
          // (aria-valuemin/max/now, a key handler, tabIndex) whose focus ring
          // is painted by `group-focus-visible:bg-primary` on a CHILD span.
          // Inspecting only the focused element's own computed style called it
          // indicator-less, which was simply false.
          //
          // So also accept the app's declared convention: a `focus-visible:` /
          // `focus:` / `group-focus-visible:` utility on the element or any
          // descendant. This is a heuristic — it proves a focus style was
          // DECLARED, not that it is perceivable — and its real job is catching
          // controls that declare nothing at all. A stricter test would diff a
          // screenshot of the element focused vs blurred; that is the upgrade
          // path if this ever passes something it shouldn't.
          const declaresFocusStyle = (node: Element): boolean => {
            const cls = typeof node.className === "string" ? node.className : "";
            return /(^|\s|:)(group-)?focus(-visible)?:/.test(cls);
          };
          const declared =
            declaresFocusStyle(el) || Array.from(el.querySelectorAll("*")).some(declaresFocusStyle);
          const label =
            `${el.tagName.toLowerCase()}` +
            `${el.id ? `#${el.id}` : ""}` +
            `${typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 8).join(".")}` : ""}` +
            `${el.getAttribute("tabindex") ? `[tabindex=${el.getAttribute("tabindex")}]` : ""}`;
          // `nextjs-portal` is Next's DEV-ONLY tooling overlay (the error
          // indicator). It is not app code and does not exist in a production
          // build, so holding it to the app's focus-indicator rule would be a
          // permanent false finding on every surface that renders it.
          const isDevOverlay = el.tagName.toLowerCase() === "nextjs-portal";
          return { tag: label, visible: outline || shadow || declared || isDevOverlay, changed };
        });

        if (info.tag === "BODY") {
          // Tab order wrapped. Keep going — the next Tab re-enters the document.
          stuckRun = 0;
          continue;
        }
        seen.add(info.tag);
        if (!info.visible) invisible.push(info.tag);
        if (info.changed) {
          stuckRun = 0;
        } else {
          stuckRun += 1;
          worstStuck = Math.max(worstStuck, stuckRun);
        }
      }

      expect(
        seen.size,
        `${surface.name} must be operable by keyboard — only ${seen.size} distinct ` +
          `control(s) took focus across ${STEPS} tabs`,
      ).toBeGreaterThanOrEqual(3);
      expect(worstStuck, "focus stopped advancing — the tab order is trapped").toBeLessThan(3);
      expect(
        [...new Set(invisible)],
        `these took focus with NO visible indicator (no outline, no ring) — a ` +
          `keyboard user cannot see where they are`,
      ).toEqual([]);
    });

    test(`${surface.name}: cumulative layout shift stays under the "good" threshold`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      // Start observing BEFORE navigation so shifts during hydration count —
      // that is exactly where this app could shift (RSC shell paints, then a
      // client component swaps in). CLAUDE.md §15: "No layout shift, no
      // flicker, no visual instability."
      await page.addInitScript(() => {
        window.__cls = 0;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const e = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
            // Shifts within 500ms of a real interaction are user-initiated and
            // excluded by the Web Vitals definition itself.
            if (!e.hadRecentInput) {
              window.__cls = (window.__cls ?? 0) + e.value;
            }
          }
        }).observe({ type: "layout-shift", buffered: true });
      });
      await page.goto(surface.path);
      await settle(page);
      // Let late work (fonts, virtualized lists, avatars) land before reading.
      await page.waitForTimeout(1500);
      const cls = await page.evaluate(() => window.__cls ?? 0);
      console.log(`[uiux:cls] ${surface.name} = ${cls.toFixed(4)}`);
      // Google's "good" bar. Measured against the DEV server, which is the
      // PESSIMISTIC case (uncompiled routes, no bundle splitting) — a prod
      // build should only be better, so a green result here is trustworthy and
      // a red one is worth reading before believing.
      expect(cls, `${surface.name} shifts too much during load (CLS ${cls.toFixed(4)} > 0.1)`)
        .toBeLessThan(0.1);
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

/**
 * DEEP SWEEP — the settings subpages.
 *
 * The seven surfaces above are the top-level ones the plan named, but /settings
 * is a hub: the pages that actually carry the channel-connection warnings,
 * destructive confirmations and provider callouts all live one level down, and
 * scanning the hub never touched them. They are also where the hand-rolled
 * `border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400`
 * warning callout is duplicated — a trio that `--warning-bg/-fg/-border` exists
 * to express, complete with a MANUAL dark: variant that cannot track the
 * tokens' OKLCH dark-mode shifts.
 *
 * Axe-only here, deliberately: the goal is evidence about whether that pattern
 * actually fails contrast before anyone refactors ~145 literal call sites.
 * Re-running the full five-dimension rubric on 20 more routes would triple the
 * runtime to re-prove things the hub already established.
 */
const SETTINGS_SUBPAGES = [
  "ai-assistant",
  "assignment",
  "channels",
  "contact-fields",
  "instagram",
  "integrations",
  "members",
  "message-flags",
  "messenger",
  "meta",
  "permissions",
  "snippets",
  "stages",
  "tags",
  "tickets",
  "whatsapp",
  // Added 2026-07-31 — the two subpages the hand-named list had silently
  // missed, found by the completeness guard below.
  "activity",
  "webchatwidget",
] as const;

for (const page_ of SETTINGS_SUBPAGES) {
  test(`settings/${page_}: no serious or critical accessibility violations`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/settings/${page_}`);
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
              `        ${(n.failureSummary ?? "").replace(/\n/g, "\n        ")}\n` +
              `        html: ${n.html.slice(0, 160)}`,
          )
          .join("\n"),
    );
    expect(blocking.map((v) => `${v.impact}:${v.id}`), report.join("\n")).toEqual([]);
  });
}

/**
 * Feature SUBPAGES — axe-only, same reasoning as SETTINGS_SUBPAGES: the hub
 * pages above carry the full five-dimension rubric; their static subroutes
 * get the accessibility gate so no reachable screen ships unscanned.
 * (Added 2026-07-31, structure program.)
 */
const FEATURE_SUBPAGES = [
  "/broadcasts/new",
  "/broadcasts/groups",
  "/broadcasts/groups/new",
  "/templates/new",
  "/templates/library",
  "/templates/authentication",
  "/organization/members",
  "/organization/workspaces",
  "/reports/campaigns",
  "/account/notifications",
  "/workflows/new",
  // Found by the completeness guard on its first run — nested under a hub
  // neither hand-list could express. The guard paying for itself immediately.
  "/settings/integrations/webhooks",
] as const;

for (const path of FEATURE_SUBPAGES) {
  test(`${path}: no serious or critical accessibility violations`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(path);
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
          .map((n) => `      ${n.target.join(" ")}\n        html: ${n.html.slice(0, 160)}`)
          .join("\n"),
    );
    expect(blocking.map((v) => `${v.impact}:${v.id}`), report.join("\n")).toEqual([]);
  });
}

/**
 * COMPLETENESS GUARD — the lesson this rubric has now taught twice (the
 * settings deep-sweep found 10/16 subpages failing; /reports sat unscanned
 * through a whole feature landing): a surface the rubric does not NAME is a
 * surface it cannot vouch for, however green the total looks. So the route
 * list is DERIVED from the filesystem and every static (app) route must be
 * claimed by a rubric tier or an explicit exclusion — adding a page without
 * deciding its rubric coverage fails this test, in CI, before it ships.
 */
test("every static (app) route is named by a rubric tier or excluded with a reason", async () => {
  const { readdirSync, statSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const appRoot = join(__dirname, "../../../apps/web/src/app/(app)");

  const routes: string[] = [];
  const walk = (dir: string, route: string) => {
    if (existsSync(join(dir, "page.tsx"))) routes.push(route || "/");
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (!statSync(full).isDirectory()) continue;
      if (entry.startsWith("[")) continue; // dynamic — needs a real id; covered by its parent's tier
      walk(full, `${route}/${entry}`);
    }
  };
  walk(appRoot, "");

  const covered = new Set<string>([
    ...SURFACES.map((s) => s.path),
    ...FEATURE_SUBPAGES,
    ...SETTINGS_SUBPAGES.map((p) => `/settings/${p}`),
  ]);
  const EXCLUDED: Record<string, string> = {
    "/settings/team": "redirect stub to /settings/members",
    "/settings/workspace": "redirect stub to /settings",
  };

  const unclaimed = routes.filter((r) => !covered.has(r) && !(r in EXCLUDED));
  expect(
    unclaimed,
    "route(s) with no rubric tier — add to SURFACES (full rubric), FEATURE_SUBPAGES / SETTINGS_SUBPAGES (axe gate), or EXCLUDED with a reason",
  ).toEqual([]);
});
