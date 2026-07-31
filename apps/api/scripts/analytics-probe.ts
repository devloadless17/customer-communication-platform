/**
 * Analytics latency probe — times the REAL report surfaces a manager hits
 * while a campaign is delivering, against whatever workspace/broadcast you
 * point it at (typically the broadcast-load harness's throwaway workspace,
 * probed DURING its statuses phase for honest contention numbers).
 *
 *   NODE_OPTIONS="--conditions=react-server" pnpm --filter @ccp/api exec tsx \
 *     scripts/analytics-probe.ts <workspaceId> <broadcastId> [iterations=20] [sleepMs=3000]
 *
 * Measures, per iteration (cache invalidated first — cold cost is the honest
 * one, the LRU would otherwise serve every later read for free):
 *   - getBroadcastReport  (the campaign report page)
 *   - campaignRollup      (when the broadcast carries a campaignName)
 *   - acquisitionSources  (the "where did each customer come from" report)
 * Prints per-iteration ms and a p50/p95/max summary per surface.
 */
import { resolve } from "node:path";

import { config as loadEnv } from "dotenv";

loadEnv({ path: resolve(__dirname, "../../../.env") });

const { setSharedDb } = require("../src/lib/db") as typeof import("../src/lib/db");
const { PrismaPg } = require("@prisma/adapter-pg") as typeof import("@prisma/adapter-pg");
const { PrismaClient } = require("@prisma/client") as typeof import("@prisma/client");

setSharedDb(
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  }) as never,
);

const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
const { getBroadcastReport, invalidateBroadcastReport } =
  require("../src/lib/broadcast-report") as typeof import("../src/lib/broadcast-report");
const { campaignRollup } =
  require("../src/lib/analytics/campaign-rollup") as typeof import("../src/lib/analytics/campaign-rollup");
const { acquisitionSources } =
  require("../src/lib/analytics/acquisition-sources") as typeof import("../src/lib/analytics/acquisition-sources");

const workspaceId = process.argv[2];
const broadcastId = process.argv[3];
const ITER = Number(process.argv[4] ?? 20);
const SLEEP = Number(process.argv[5] ?? 3000);

function pct(samples: number[]): string {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
  return `n=${s.length} p50=${at(0.5).toFixed(0)}ms p95=${at(0.95).toFixed(0)}ms max=${(s[s.length - 1] ?? 0).toFixed(0)}ms`;
}

async function main(): Promise<void> {
  if (!workspaceId || !broadcastId) {
    console.error("usage: analytics-probe.ts <workspaceId> <broadcastId> [iter] [sleepMs]");
    process.exit(2);
  }
  const b = await db.broadcast.findFirst({
    where: { id: broadcastId, workspaceId },
    select: { campaignName: true, status: true },
  });
  if (!b) throw new Error("broadcast not found in workspace");
  console.log(`probing workspace=${workspaceId} broadcast=${broadcastId} status=${b.status} campaign=${b.campaignName ?? "(none)"}`);

  const report: number[] = [];
  const rollup: number[] = [];
  const acquisition: number[] = [];
  for (let i = 0; i < ITER; i++) {
    invalidateBroadcastReport(workspaceId, broadcastId);
    let t = Date.now();
    await getBroadcastReport(workspaceId, broadcastId);
    report.push(Date.now() - t);

    if (b.campaignName) {
      t = Date.now();
      await campaignRollup(workspaceId, b.campaignName);
      rollup.push(Date.now() - t);
    }

    t = Date.now();
    await acquisitionSources(workspaceId, {});
    acquisition.push(Date.now() - t);

    console.log(
      `#${i + 1} report=${report[report.length - 1]}ms` +
        (b.campaignName ? ` rollup=${rollup[rollup.length - 1]}ms` : "") +
        ` acquisition=${acquisition[acquisition.length - 1]}ms`,
    );
    await new Promise((r) => setTimeout(r, SLEEP));
  }
  console.log(`\nreport      ${pct(report)}`);
  if (rollup.length) console.log(`rollup      ${pct(rollup)}`);
  console.log(`acquisition ${pct(acquisition)}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
