/**
 * Stuck-broadcast alerting.
 *
 * The broadcast runner is NOT a BullMQ job, so none of its failures reach the
 * health report's `jobFailures`. The permanent-error breaker, the sustained
 * rate-limit pause and the dead-credentials park all ended in a `console.warn`
 * plus a socket frame aimed at a browser tab nobody is watching at 3am — a
 * campaign could sit paused indefinitely with zero operator signal.
 *
 * Auto-recovery now clears the transient causes on a 10-minute cooldown, so a
 * broadcast STILL paused past ~35 minutes is genuinely stuck: either a cause
 * that keeps re-tripping, or a `template` pause, which is deliberately never
 * auto-resumed because only an operator can fix it at Meta. Both need a human.
 *
 * These drive the real probe + the real (pure) degradation check, asserting the
 * boundary in both directions — a probe that fires too eagerly trains operators
 * to ignore it, which is worse than no alert at all.
 *
 * ISOLATION: own throwaway team, dropped afterwards.
 */

import { test, expect } from "@playwright/test";

import {
  computeDegradations,
  DEGRADED_BROADCAST_PAUSED_MIN,
} from "../../../apps/api/src/health/health-thresholds";
import {
  probeStuckBroadcasts,
  STUCK_BROADCAST_PROBE_MIN,
} from "../../../apps/api/src/health/stuck-broadcasts";
import { createTestWorkspace, db } from "../_helpers/db";

test.describe.configure({ mode: "serial" });

const TEAM_ID = `e2e-stuck-${Date.now()}`;
const MIN = 60_000;

/** A health report with everything healthy except the part under test. */
function healthyExcept(stuckBroadcasts: {
  count: number;
  oldestPausedMin: number | null;
  reasons: string[];
}) {
  return {
    db: true,
    redis: true,
    pgPool: { max: 10, total: 2, idle: 2, waiting: 0, saturationPercent: 0 },
    outboxLag: { pendingCount: 0, oldestPendingSec: 0, stale: false },
    jobFailures: {},
    ffmpeg: { active: 0, queued: 0 },
    stuckBroadcasts,
  };
}

async function seedPaused(pausedMinAgo: number, pausedReason: string | null): Promise<void> {
  await db().broadcast.create({
    data: {
      workspaceId: TEAM_ID,
      name: `stuck-${Math.random().toString(36).slice(2)}`,
      channel: "whatsapp",
      status: "paused",
      audienceMode: "selected",
      variables: {},
      pausedAt: new Date(Date.now() - pausedMinAgo * MIN),
      pausedReason,
    },
  });
}

async function clear(): Promise<void> {
  await db().broadcast.deleteMany({ where: { workspaceId: TEAM_ID } });
}

test.beforeAll(async () => {
  await createTestWorkspace({ id: TEAM_ID, name: "E2E Stuck Alerting Team", status: "active" });
});

test.afterAll(async () => {
  await clear();
  // Delete the ORG — it cascades to the workspace. Deleting only the workspace
  // leaves an orphan Organization behind on every run.
  await db().organization.deleteMany({ where: { workspaces: { some: { id: TEAM_ID } } } });
});

test("a freshly paused broadcast does NOT alert (auto-recovery gets first crack)", async () => {
  await clear();
  // 5 minutes old — the sweeper has not even reached its first cooldown.
  await seedPaused(5, "rate_limited");
  const report = await probeStuckBroadcasts(db(), STUCK_BROADCAST_PROBE_MIN);
  expect(report.count).toBe(0);
  expect(computeDegradations(healthyExcept(report))).toEqual([]);
});

test("THE FIX: a broadcast stuck well past the cooldowns alerts, and says WHY", async () => {
  await clear();
  await seedPaused(90, "template");
  const report = await probeStuckBroadcasts(db(), STUCK_BROADCAST_PROBE_MIN);
  expect(report.count).toBe(1);
  expect(report.oldestPausedMin).toBeGreaterThanOrEqual(89);
  expect(report.reasons).toEqual(["template"]);

  const degraded = computeDegradations(healthyExcept(report));
  expect(degraded.length).toBe(1);
  // The operator needs the cause in the alert itself — "a broadcast is stuck"
  // without "template" sends them digging through logs at 3am.
  expect(degraded[0]).toContain("template");
  expect(degraded[0]).toContain("stuck paused");
});

test("the alert boundary matches the degradation threshold exactly", async () => {
  await clear();
  // Just under → silent. Just over → alerts. These must agree, or the probe
  // surfaces rows the check ignores (or vice versa).
  await seedPaused(DEGRADED_BROADCAST_PAUSED_MIN - 5, "credentials");
  expect((await probeStuckBroadcasts(db(), STUCK_BROADCAST_PROBE_MIN)).count).toBe(0);

  await clear();
  await seedPaused(DEGRADED_BROADCAST_PAUSED_MIN + 5, "credentials");
  const over = await probeStuckBroadcasts(db(), STUCK_BROADCAST_PROBE_MIN);
  expect(over.count).toBe(1);
  expect(computeDegradations(healthyExcept(over)).length).toBe(1);
});

test("several stuck broadcasts report a count, the OLDEST age, and every distinct reason", async () => {
  await clear();
  await seedPaused(50, "template");
  await seedPaused(120, "credentials");
  await seedPaused(70, "template"); // duplicate reason must not double-report
  const report = await probeStuckBroadcasts(db(), STUCK_BROADCAST_PROBE_MIN);
  expect(report.count).toBe(3);
  // Oldest, not newest — the alert should reflect the worst case.
  expect(report.oldestPausedMin).toBeGreaterThanOrEqual(119);
  expect([...report.reasons].sort()).toEqual(["credentials", "template"]);
  expect(computeDegradations(healthyExcept(report))[0]).toContain("3 broadcast(s)");
});

test("a paused broadcast with no recorded reason still alerts (reported as unknown)", async () => {
  await clear();
  // Rows paused before `pausedReason` existed. They must not vanish from the
  // alert just because we cannot say why they stopped.
  await seedPaused(90, null);
  const report = await probeStuckBroadcasts(db(), STUCK_BROADCAST_PROBE_MIN);
  expect(report.count).toBe(1);
  expect(report.reasons).toEqual(["unknown"]);
});

test("a RUNNING or COMPLETED broadcast never alerts, however old", async () => {
  await clear();
  for (const status of ["running", "completed", "queued"] as const) {
    await db().broadcast.create({
      data: {
        workspaceId: TEAM_ID,
        name: `notpaused-${status}`,
        channel: "whatsapp",
        status,
        audienceMode: "selected",
        variables: {},
        // Deliberately ancient — only `status = paused` may ever alert.
        pausedAt: new Date(Date.now() - 999 * MIN),
      },
    });
  }
  expect((await probeStuckBroadcasts(db(), STUCK_BROADCAST_PROBE_MIN)).count).toBe(0);
});
