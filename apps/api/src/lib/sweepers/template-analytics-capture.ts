// Note: no `server-only` import — the NestJS api process loads this on boot
// via @swc-node/register, outside the Next bundler context.

import { db } from "@/lib/db";
import { refreshTemplateAnalytics } from "@/lib/analytics/template-analytics";
import { isPoolClosedError, withSweeperMutex } from "@/lib/sweepers/_mutex";

/**
 * Capture Meta's READ and CLICK figures before they expire.
 *
 * THE PROBLEM THIS SOLVES IS PERMANENT DATA LOSS. Meta reports read and
 * URL-button-click counts for roughly SEVEN DAYS after the fact, then stops.
 * Everything else about a campaign — the delivery funnel, failures, cost — can
 * be re-derived or re-fetched later. Read and click cannot: once the window
 * closes, those numbers are gone from every source we have.
 *
 * Without this sweep, a customer only ever gets read/click data for campaigns
 * they happened to open the report on within a week. That is an arbitrary
 * outcome that looks like a broken feature, and it is not recoverable after the
 * fact.
 *
 * So: campaigns that finished inside the window get re-fetched on a slow cycle,
 * and the rollup's COALESCE upsert (see lib/analytics/template-analytics.ts)
 * keeps whatever was captured once Meta goes quiet.
 *
 * DELIBERATELY SLOW AND BOUNDED. Meta's analytics figures move on a scale of
 * hours, not minutes, and the aggregate barely changes once a campaign has
 * finished. This is a data-preservation backstop, not a live feed — the report
 * is served from the stored rollup either way, and an admin who wants it NOW
 * has the Refresh button.
 */

const SWEEP_INTERVAL_MS = 6 * 60 * 60_000; // every 6h
/**
 * Meta's read/click window is ~7 days. Sweeping campaigns finished within SIX
 * gives a full day of margin: at a 6-hourly cadence a campaign gets several
 * more chances to be captured before the window shuts, so one failed Graph call
 * — or one restart — doesn't cost the data.
 */
const CAPTURE_WINDOW_DAYS = 6;
/** Bound per tick so a busy tenant can't burst Graph calls. */
const MAX_WORKSPACES_PER_TICK = 10;

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

async function runTick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await withSweeperMutex("template-analytics-capture", sweepTemplateAnalyticsCaptureOnce);
  } catch (err) {
    // The pool is gone (hot-reload / shutdown) — stop rather than logging a
    // stack trace on every tick forever. Same contract as every sibling sweeper.
    if (isPoolClosedError(err)) {
      stopTemplateAnalyticsCaptureSweeper();
      return;
    }
    console.warn(
      "[template-analytics-capture] iteration failed:",
      err instanceof Error ? err.message : err,
    );
  } finally {
    inFlight = false;
  }
}

export function startTemplateAnalyticsCaptureSweeper(): void {
  if (timer) return;
  timer = setInterval(() => void runTick(), SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopTemplateAnalyticsCaptureSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Exported for tests, matching the sibling sweepers' convention. The scheduler uses
 * the mutex-wrapped call above; a spec drives this directly so the per-WABA insights
 * gate can be asserted without waiting on a timer.
 */
export async function sweepTemplateAnalyticsCaptureOnce(): Promise<void> {
  const since = new Date(Date.now() - CAPTURE_WINDOW_DAYS * 86_400_000);

  // Campaigns that finished inside the window, grouped by workspace. Only
  // TEMPLATE campaigns — a freeform Messenger/Instagram send has no Meta
  // template for these figures to belong to.
  const recent = await db.broadcast.findMany({
    where: {
      channel: "whatsapp",
      kind: "template",
      // Not just `completed`: a campaign that ended `failed` at 90% or was
      // canceled at 95% still has tens of thousands of BILLED sends whose
      // read/click figures are exactly as perishable. `canceled` rows carry no
      // completedAt, so they anchor on startedAt/createdAt — a canceled run
      // whose sends are recent enough to still be capturable started recently.
      status: { in: ["completed", "failed", "canceled"] },
      OR: [
        { completedAt: { gte: since } },
        { startedAt: { gte: since } },
        { startedAt: null, createdAt: { gte: since } },
      ],
      templateName: { not: null },
    },
    select: {
      workspaceId: true,
      templateName: true,
      templateLanguage: true,
      startedAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    // Generous: this collapses to a handful of workspaces below.
    take: 500,
  });
  if (recent.length === 0) return;

  // Only accounts that have actually TURNED ANALYTICS ON. Meta refuses the read
  // otherwise, so sweeping the rest would be a guaranteed error per tick — noisy
  // logs and wasted Graph budget for an account that opted out.
  //
  // Gated PER WABA, matching the granularity of the fetch below. Insights are a
  // WABA-level switch at Meta and this used to gate per WORKSPACE, so a workspace
  // with WABA-A enabled and WABA-B not swept B every tick and earned a guaranteed
  // Meta refusal for it — exactly the waste the gate exists to prevent, just moved
  // down a level when the flag became a WABA property.
  const candidates = [...new Set(recent.map((b) => b.workspaceId))];
  const enabledWabaIds = new Set(
    (
      await db.whatsappBusinessAccount.findMany({
        where: {
          insightsEnabledAt: { not: null },
          workspaceId: { in: candidates },
        },
        select: { id: true },
      })
    ).map((w) => w.id),
  );

  // `insightsEnabledAt` is stamped ONLY by our own enable button, but Meta
  // documents WhatsApp Manager as an equally valid way to confirm insights — so an
  // account switched on there reads as opted-out here and was skipped forever. That
  // is the one failure this sweeper exists to prevent: read and click counts are
  // perishable at ~7 days and recoverable from no other source. A stored rollup row
  // is proof Meta served analytics for that template (a manual Fetch or the
  // report's auto-fetch got through), so it counts as enablement regardless of which
  // switch was flipped.
  //
  // Resolved to the WABA through the template that owns the rollup, so the escape
  // hatch keeps the same per-WABA granularity as the gate above rather than
  // re-widening it to the whole workspace.
  const provenIds = (
    await db.templateAnalyticsDaily.findMany({
      where: { workspaceId: { in: candidates } },
      select: { templateExternalId: true },
      distinct: ["templateExternalId"],
    })
  ).map((r) => r.templateExternalId);
  if (provenIds.length > 0) {
    for (const t of await db.messageTemplate.findMany({
      where: { workspaceId: { in: candidates }, externalId: { in: provenIds } },
      select: { wabaAccountId: true },
      distinct: ["wabaAccountId"],
    })) {
      enabledWabaIds.add(t.wabaAccountId);
    }
  }
  if (enabledWabaIds.size === 0) return;

  // Per workspace: which templates, and the widest window their campaigns
  // covered. One Graph call per workspace instead of one per campaign — Meta
  // takes up to 10 template ids at a time and reports by day anyway, so
  // per-campaign calls would re-fetch the same days repeatedly.
  // The window END is always NOW, never the campaign's completion. Meta
  // buckets `template_analytics` by EVENT day: a read that happens Tuesday
  // lands in Tuesday's data point regardless of when the message was sent, and
  // most reads — and virtually all URL clicks — land in the days AFTER a
  // campaign completes. Fetching `start..completedAt` (the old shape) never
  // requested those buckets, so the engagement tail this sweeper exists to
  // preserve expired uncaptured at Meta's ~7-day horizon.
  const end = new Date();
  const byWorkspace = new Map<string, { names: Set<string>; start: Date }>();
  for (const b of recent) {
    if (!b.templateName) continue;
    const start = b.startedAt ?? b.createdAt;
    const entry = byWorkspace.get(b.workspaceId);
    if (!entry) {
      byWorkspace.set(b.workspaceId, { names: new Set([b.templateName]), start });
    } else {
      entry.names.add(b.templateName);
      if (start < entry.start) entry.start = start;
    }
  }

  let handled = 0;
  for (const [workspaceId, entry] of byWorkspace) {
    if (handled >= MAX_WORKSPACES_PER_TICK) break;
    handled++;
    try {
      // No per-workspace template cap: the name set is already bounded by the
      // campaigns of the last 6 days, and `refreshTemplateAnalytics` chunks
      // ids to Meta's 10-per-call limit. The old `take: 10` (with NO orderBy)
      // silently and PERMANENTLY dropped an arbitrary subset for any workspace
      // that campaigned >10 templates in a week.
      const templates = await db.messageTemplate.findMany({
        where: {
          workspaceId,
          name: { in: [...entry.names] },
          externalId: { not: null },
        },
        select: { externalId: true, wabaAccountId: true },
      });
      // Drop templates whose WABA has NOT enabled insights — Meta refuses those
      // reads, and including them turned one opted-out account into a guaranteed
      // per-tick error for the whole workspace.
      const eligible = templates.filter((t) => enabledWabaIds.has(t.wabaAccountId));
      if (eligible.length === 0) continue;

      // Group by WABA before fetching. `template_analytics` is a field on the
      // WABA node, so one request per workspace would query every template
      // against whichever WABA happened to come first — and Meta answers with
      // an EMPTY set for the ones that don't belong to it, which this sweep
      // would then store as "nothing to capture". On a single-WABA workspace
      // this is one group and behaves exactly as before.
      const byWaba = new Map<string, string[]>();
      for (const t of eligible) {
        if (!t.externalId) continue;
        // Grouped by the WABA FK. There is no "unknown WABA" bucket any more —
        // `wabaAccountId` is NOT NULL, so every template names its own catalog.
        const list = byWaba.get(t.wabaAccountId);
        if (list) list.push(t.externalId);
        else byWaba.set(t.wabaAccountId, [t.externalId]);
      }

      for (const [wabaAccountId, ids] of byWaba) {
        try {
          await refreshTemplateAnalytics(workspaceId, {
            templateExternalIds: ids,
            start: entry.start,
            end,
            wabaAccountId,
          });
        } catch (err) {
          // Isolated per WABA too: an expired token on WABA-1 must not abort
          // WABA-2's capture this tick — its data is equally perishable.
          console.warn(
            `[template-analytics-capture] failed for workspace=${workspaceId} waba=${wabaAccountId}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    } catch (err) {
      // Isolated per workspace: one tenant's expired token must not stop the
      // sweep before it reaches the others, whose data is equally perishable.
      console.warn(
        `[template-analytics-capture] failed for workspace=${workspaceId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
