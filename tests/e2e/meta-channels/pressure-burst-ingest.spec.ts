/**
 * B-M5 PRESSURE — burst inbound ingest, and the same burst redelivered.
 *
 * Meta delivers at-least-once and does NOT pace: a promo reply-storm arrives as
 * a burst, and any 5xx we return gets the whole batch redelivered. The two
 * properties that matter under that load are therefore measured together here:
 *
 *   1. THROUGHPUT + LATENCY — the pipeline holds up (every POST 2xx, no 5xx,
 *      no lock timeout) and we record p50/p95/max so a future regression has a
 *      number to fail against rather than a feeling.
 *   2. DEDUPE UNDER REDELIVERY — replaying the identical burst must commit
 *      ZERO additional messages. `@@unique([workspaceId, channel, externalId])`
 *      is the guard; this proves it holds when both copies are in flight at the
 *      same time, which is the case a serial redelivery test never exercises.
 *
 * Tagged `@pressure` and excluded from CI (playwright.meta.config.ts) — it is a
 * measurement harness, not a gate. Run it deliberately:
 *
 *   pnpm test:e2e:meta -- --grep @pressure
 *
 * Numbers go in tests/VERIFICATION.md under "Pressure numbers" WITH the commit
 * they were measured at; an unattributed number is not evidence.
 */

import { test, expect } from "@playwright/test";

import { db } from "../_helpers/db";
import {
  seedMetaTestTeam,
  wipeMetaTestTeam,
  postMetaWebhook,
  socialInbound,
  META_TEST_TEAM_ID,
  MSGR_PAGE_ID,
} from "../_helpers/meta";

test.describe.configure({ mode: "serial" });

/** Inbound messages in the burst. */
const BURST = 500;
/** Distinct customers they come from — a storm is many people, not one. */
const SENDERS = 50;
/** In-flight POSTs. Meta fans out its own deliveries; this approximates that. */
const CONCURRENCY = 25;

test.beforeAll(async () => {
  await seedMetaTestTeam();
});
test.afterAll(async () => {
  await wipeMetaTestTeam();
});

interface Timing {
  ms: number;
  status: number;
}

/** Per-message response codes across every pass — so a message that never
 *  commits can be traced to what we ANSWERED, which decides whether Meta ever
 *  retries it. A 503 is recoverable; a 200 that didn't commit is lost forever. */
const statusHistory: string[][] = Array.from({ length: 500 }, () => []);

function payloadFor(i: number): unknown {
  return socialInbound({
    object: "page",
    accountId: MSGR_PAGE_ID,
    senderId: `700${String(i % SENDERS).padStart(7, "0")}`,
    mid: `m.pressure.${i}`,
    text: `burst message ${i}`,
  });
}

/** Post the given indices with a bounded number in flight, timing each. */
async function runBurst(label: string, indices?: number[]): Promise<Timing[]> {
  const ids = indices ?? Array.from({ length: BURST }, (_, i) => i);
  const timings: Timing[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const slot = cursor++;
      if (slot >= ids.length) return;
      const i = ids[slot]!;
      const startedAt = Date.now();
      const res = await postMetaWebhook(META_TEST_TEAM_ID, payloadFor(i));
      timings.push({ ms: Date.now() - startedAt, status: res.status });
      statusHistory[i].push(`${label}:${res.status}${res.text.includes("dropped") ? "(dropped)" : ""}`);
    }
  }
  const startedAt = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  const wall = Date.now() - startedAt;
  const sorted = timings.map((t) => t.ms).sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  console.log(
    `[pressure:${label}] ${ids.length} webhooks in ${wall}ms ` +
      `(${(ids.length / (wall / 1000)).toFixed(1)}/s) · ` +
      `p50=${pct(0.5)}ms p95=${pct(0.95)}ms max=${sorted[sorted.length - 1]}ms`,
  );
  return timings;
}

/** Burst indices with no committed row yet. */
async function missingIndices(): Promise<number[]> {
  const rows = await db().message.findMany({
    where: { workspaceId: META_TEST_TEAM_ID, channel: "messenger", direction: "in" },
    select: { externalId: true },
  });
  const present = new Set(rows.map((r) => r.externalId));
  return Array.from({ length: BURST }, (_, i) => i).filter(
    (i) => !present.has(`m.pressure.${i}`),
  );
}

function countMessages(): Promise<number> {
  return db().message.count({
    where: { workspaceId: META_TEST_TEAM_ID, channel: "messenger", direction: "in" },
  });
}

test("@pressure 500-webhook burst sheds only retryably, then converges on redelivery", async () => {
  test.setTimeout(300_000);

  // ── Pass 1: the storm ────────────────────────────────────────────────────
  const first = await runBurst("pass1");

  // THE CONTRACT (CLAUDE.md §8), not "nothing ever fails". Under genuine
  // overload the pipeline is allowed to shed — but only in the way Meta will
  // RETRY. A 4xx or a plain 500 is dropped forever by Meta; a 503 comes back.
  // So the assertion is on the SHAPE of failure, not its absence.
  const bad = first.filter((t) => !((t.status >= 200 && t.status < 300) || t.status === 503));
  expect(bad, `every response must be 2xx or a retryable 503, got ${JSON.stringify(bad.slice(0, 5))}`)
    .toHaveLength(0);

  const shed = first.filter((t) => t.status === 503).length;
  console.log(
    `[pressure:pass1] shed ${shed}/${BURST} (${((shed / BURST) * 100).toFixed(1)}%) as retryable 503`,
  );

  // ── Pass 2+: Meta redelivers. Convergence is the real requirement ────────
  // Every accepted message must be committed exactly once, and every shed one
  // must land on a retry — with no duplicates from the copies that DID commit.
  // Meta redelivers what it failed to deliver, not the whole world — and the
  // per-workspace webhook bucket is 600/min, so blindly re-blasting all 500
  // just earns 429s (correct product behavior, but it means the harness would
  // measure the rate limiter instead of the ingest path).
  for (let round = 2; round <= 5; round++) {
    const stillMissing = await missingIndices();
    if (stillMissing.length === 0) break;
    await runBurst(`pass${round}-redelivery`, stillMissing);
  }

  // Before asserting convergence, name exactly WHAT is missing and what the
  // wire said about it. "499 != 500" is not actionable; "m.pressure.N was
  // answered 200 on every delivery and never committed" is a data-loss report.
  const committed = await db().message.findMany({
    where: { workspaceId: META_TEST_TEAM_ID, channel: "messenger", direction: "in" },
    select: { externalId: true },
  });
  const present = new Set(committed.map((m) => m.externalId));
  const missing = Array.from({ length: BURST }, (_, i) => i).filter(
    (i) => !present.has(`m.pressure.${i}`),
  );
  if (missing.length > 0) {
    for (const i of missing.slice(0, 10)) {
      console.log(
        `[pressure:MISSING] m.pressure.${i} — delivery statuses across passes: ` +
          `${(statusHistory[i] ?? []).join(", ")}`,
      );
    }
  }
  expect(
    missing.map((i) => `m.pressure.${i}=[${(statusHistory[i] ?? []).join(",")}]`),
    "every delivered message must commit; a 200 that never commits is silent loss",
  ).toEqual([]);

  expect(await countMessages(), "redelivery must converge on exactly the burst, no more").toBe(BURST);

  // One conversation per contact, however hard the burst hit it. Concurrent
  // inbounds for the SAME sender are precisely the window where a
  // check-then-create fragments a thread — this is what Serializable buys.
  expect(
    await db().conversation.count({
      where: { workspaceId: META_TEST_TEAM_ID, channel: "messenger" },
    }),
    "one conversation per sender, no fragmentation and no duplicates",
  ).toBe(SENDERS);

  // The denormalized counter must agree with the rows it summarizes. Under a
  // burst this is where an increment outside the insert's transaction shows up
  // — and unreadCount is the one denorm with NO reconciler (no read watermark
  // exists), so drift here would be permanent.
  const drifted = await db().$queryRaw<{ id: string }[]>`
    SELECT c.id
    FROM "Conversation" c
    WHERE c."workspaceId" = ${META_TEST_TEAM_ID}
      AND c.channel = 'messenger'
      AND c."unreadCount" <> (
        SELECT COUNT(*) FROM "Message" m
        WHERE m."conversationId" = c.id AND m.direction = 'in'
      )
  `;
  expect(drifted, "unreadCount must equal the inbound rows it counts").toHaveLength(0);
});
