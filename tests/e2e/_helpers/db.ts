/**
 * Direct Postgres access for test fixtures. The tests bypass the API for
 * SETUP (seeding contacts, conversations, workflows, outbound webhooks)
 * because there's no point exercising 14 HTTP endpoints to assemble
 * fixture data — each setup call already gets its own API layer test
 * in predeploy.spec.ts. We use Prisma directly here so a fresh-DB
 * deployment can be tested with the SAME schema the app reads.
 *
 * Cleanup uses `truncate` on the test-touched tables so each suite starts
 * from a known empty state without nuking the superadmin row.
 */

import { existsSync } from "node:fs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

// `tsx`/Playwright don't auto-load .env. Match the seed-superadmin.ts
// posture so the same DATABASE_URL is used by both.
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

let _client: PrismaClient | null = null;

export function db(): PrismaClient {
  if (!_client) {
    // Pass the connection string directly to the pg adapter — Prisma 7
    // requires an explicit driver adapter and this project uses the pg
    // adapter end-to-end. Same posture as prisma/seeds/seed-superadmin.ts.
    _client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
    });
  }
  return _client;
}

/**
 * The single superadmin row created by `prisma/seeds/seed-superadmin.ts`.
 * Resolved once at suite start so we don't keep pinging the user table.
 */
export async function superadminTeam(): Promise<{ teamId: string; userId: string }> {
  const user = await db().user.findFirst({
    where: { role: "superAdmin" },
    select: { id: true, teamId: true },
  });
  if (!user) {
    throw new Error("no superAdmin row — run pnpm db:seed:superadmin first");
  }
  return { teamId: user.teamId, userId: user.id };
}

/**
 * Wipe all test-state tables but leave the seeded User + Team + ContactStage
 * rows. Run at the END of each suite (afterAll), not the start — a leftover
 * row in a child table doesn't break the next suite but ensures the suite
 * itself runs against the expected state.
 *
 * Order matters: child tables before parents.
 */
export async function wipeTestData(): Promise<void> {
  const d = db();
  await d.$transaction([
    d.outboundWebhookDelivery.deleteMany({}),
    d.outboundEvent.deleteMany({}),
    d.outboundWebhook.deleteMany({}),
    d.workflowRun.deleteMany({}),
    d.workflowContactState.deleteMany({}),
    d.workflow.deleteMany({}),
    d.internalNote.deleteMany({}),
    d.conversationEvent.deleteMany({}),
    d.message.deleteMany({}),
    d.conversation.deleteMany({}),
    d.contact.deleteMany({}),
    d.teamApiKey.deleteMany({}),
  ]);
}

/**
 * Eventually-consistent assertion helper. Polls a predicate every 100ms up
 * to `timeoutMs`. Used for "event was eventually dispatched" checks — the
 * outbox drainer ticks ~every 100ms, so 2-3s is generous.
 */
export async function pollUntil<T>(
  fn: () => Promise<T | null | undefined | false>,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result as T;
    last = result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `pollUntil timed out after ${timeoutMs}ms${
      options.label ? ` waiting for ${options.label}` : ""
    } (last=${JSON.stringify(last)})`,
  );
}
