/**
 * Retroactively correct the delivery truth of HISTORICAL broadcast campaigns.
 *
 * WHY THIS IS POSSIBLE AT ALL: `ingestStatusUpdate` has been faithfully writing
 * Meta's delivery ladder (sent → delivered → read → failed) and failure
 * diagnostics onto the `Message` row this entire time. It simply never
 * propagated any of it to `BroadcastRecipient`. So the data to fix every past
 * campaign already exists in the database — this script just moves it across.
 * That is unusual for a reporting backfill and it's the main reason the
 * campaign report can show truthful history on day one rather than only
 * measuring campaigns sent after the deploy.
 *
 * WHAT IT FIXES: recipients Meta accepted and then failed to deliver were left
 * at `status='sent'` and counted as successes. After this run they read
 * `deliveryState='undelivered'` with a normalized `errorCode`, so "who never
 * received it" finally answers correctly for old campaigns too.
 *
 * SAFETY / DESIGN:
 *  - Idempotent + resumable. Re-running is a no-op for rows already correct;
 *    it can be interrupted and restarted at any point.
 *  - Never downgrades. Applies the same monotonic rule as the live path, so a
 *    row already advanced by a live webhook is left alone.
 *  - Per-broadcast, newest-first, with a pause between campaigns. A single
 *    join across all history would evict the buffer cache on the shared VPS
 *    and degrade the live inbox — the exact failure mode the retention
 *    sweepers are batched to avoid.
 *  - NOT a Prisma migration. Migrations must be fast; this can take a while on
 *    a large history and must be re-runnable independently of a deploy.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-broadcast-delivery.ts --dry-run
 *   pnpm tsx scripts/backfill-broadcast-delivery.ts
 *   pnpm tsx scripts/backfill-broadcast-delivery.ts --limit 50 --sleep 500
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { config as loadEnv } from "dotenv";

// `tsx` doesn't auto-load .env (mirrors prisma/seeds/seed-superadmin.ts).
const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) loadEnv({ path: envPath });

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const flag = (name: string, fallback: number): number => {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const v = Number.parseInt(args[i + 1] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
/** How many campaigns to process (newest first). */
const LIMIT = flag("--limit", 500);
/** Pause between campaigns so a long run can't monopolise the DB. */
const SLEEP_MS = flag("--sleep", 250);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Same ladder as `deliveryWinsOver` in lib/providers/ingest.ts. Duplicated
 * deliberately rather than imported: this script runs standalone under tsx and
 * must not drag in the API's module graph (`@/lib/db`, Redis, the event bus).
 * Keep the two in sync — they encode one rule.
 */
const RANK: Record<string, number> = {
  pending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  failed_at_send: -1,
  undelivered: -1,
};
function winsOver(next: string, current: string): boolean {
  if ((RANK[current] ?? 0) < 0) return false;
  if ((RANK[next] ?? 0) < 0) return current !== "read" && current !== "delivered";
  return (RANK[next] ?? 0) > (RANK[current] ?? 0);
}

/** Mirrors classifyMetaStatusError in lib/providers/meta-send-error.ts. */
function classify(code: number | null): string {
  switch (code) {
    case 131047:
    case 2534022:
      return "outside_24h_window";
    case 131026:
    case 131051:
    case 2534013:
    case 2534014:
    case 2534029:
    case 2534041:
      return "invalid_recipient";
    case 131049:
      return "per_user_marketing_cap";
    case 4:
    case 80006:
    case 80007:
    case 130429:
    case 131048:
    case 131056:
    case 613:
      return "rate_limited";
    case 190:
      return "auth_expired";
    case 132001:
    case 132007:
    case 132015:
    case 132016:
      return "template_unavailable";
    case 551:
      return "recipient_unavailable";
    case 10900:
    case 9000001:
      return "message_unavailable";
    case 131009:
      return "unsupported_message";
    default:
      return "provider_rejected";
  }
}

async function main(): Promise<void> {
  console.log(
    `[backfill] starting${DRY_RUN ? " (DRY RUN — no writes)" : ""}; limit=${LIMIT} sleep=${SLEEP_MS}ms`,
  );

  // Step 1 — populate Message.broadcastId from the surviving rawPayload. The
  // retention sweeper collapses that blob to {"sentVia":"broadcast"}, so only
  // messages still inside the retention window can be recovered. Those outside
  // it are unrecoverable by design; their recipients keep whatever state they
  // have. Bounded batches so we never hold a long lock.
  let linked = 0;
  if (!DRY_RUN) {
    for (;;) {
      const n = await db.$executeRaw`
        UPDATE "Message" SET "broadcastId" = "rawPayload"->>'broadcastId'
        WHERE id IN (
          SELECT id FROM "Message"
          WHERE "broadcastId" IS NULL
            AND "rawPayload"->>'sentVia' = 'broadcast'
            AND "rawPayload" ? 'broadcastId'
          LIMIT 5000
        )`;
      linked += Number(n);
      if (Number(n) < 5000) break;
      await sleep(SLEEP_MS);
    }
  } else {
    const [{ count }] = await db.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM "Message"
      WHERE "broadcastId" IS NULL AND "rawPayload"->>'sentVia' = 'broadcast'
        AND "rawPayload" ? 'broadcastId'`;
    linked = Number(count);
  }
  console.log(`[backfill] step 1: ${linked} message(s) ${DRY_RUN ? "would be" : ""} linked to a broadcast`);

  // Step 2 — per campaign, newest first, derive the recipient's delivery state
  // from the Message we already have. Joined on `externalId` (the wamid): exact,
  // and it avoids depending on `conversationId`, which is a soft pointer that
  // may dangle after a thread was hard-deleted.
  const broadcasts = await db.broadcast.findMany({
    where: { status: { in: ["completed", "failed", "canceled", "paused"] } },
    orderBy: { createdAt: "desc" },
    take: LIMIT,
    select: { id: true, name: true, templateName: true, createdAt: true },
  });
  console.log(`[backfill] step 2: scanning ${broadcasts.length} campaign(s)`);

  let totalUpdated = 0;
  for (const b of broadcasts) {
    const rows = await db.$queryRaw<
      {
        id: string;
        deliveryState: string;
        status: string;
        msgStatus: string;
        errCode: number | null;
        errDetail: string | null;
      }[]
    >`
      SELECT r.id, r."deliveryState"::text AS "deliveryState", r.status::text AS status,
             m.status::text AS "msgStatus", m."statusErrorCode" AS "errCode",
             m."statusErrorDetail" AS "errDetail"
      FROM "BroadcastRecipient" r
      JOIN "Message" m ON m."externalId" = r."externalId"
      WHERE r."broadcastId" = ${b.id}
        AND r."externalId" IS NOT NULL
        AND r.status = 'sent'`;

    let updated = 0;
    for (const row of rows) {
      // Meta's `failed` on an accepted message = undeliverable (distinct from
      // the runner's failed_at_send, which never got a wamid at all).
      const next = row.msgStatus === "failed" ? "undelivered" : row.msgStatus;
      if (next === "sent") continue; // nothing new to say
      if (!winsOver(next, row.deliveryState)) continue; // already equal/higher — never downgrade

      if (!DRY_RUN) {
        await db.broadcastRecipient.updateMany({
          // Pin the state we read: a live webhook may have advanced it while
          // this script was running.
          where: { id: row.id, deliveryState: row.deliveryState as never },
          data: {
            deliveryState: next as never,
            ...(next === "undelivered"
              ? {
                  metaErrorCode: row.errCode,
                  errorCode: classify(row.errCode),
                  ...(row.errDetail ? { errorMessage: row.errDetail.slice(0, 500) } : {}),
                }
              : {}),
          },
        });
      }
      updated++;
    }

    if (updated > 0) {
      totalUpdated += updated;
      console.log(
        `[backfill]   ${b.templateName ?? b.name ?? b.id} (${b.createdAt.toISOString().slice(0, 10)}): ${updated}/${rows.length} recipient(s) corrected`,
      );
    }
    await sleep(SLEEP_MS);
  }

  console.log(
    `[backfill] done — ${totalUpdated} recipient(s) ${DRY_RUN ? "would be" : ""} corrected across ${broadcasts.length} campaign(s)`,
  );
  if (DRY_RUN) console.log("[backfill] DRY RUN: no changes were written. Re-run without --dry-run to apply.");
}

main()
  .catch((err) => {
    console.error("[backfill] FAILED", err);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
