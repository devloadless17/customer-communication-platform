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
import bcrypt from "bcrypt";

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

// Regular-admin test user. Lives in the SAME team as the superadmin (the
// seeded, active Loadless team) so fixtures keyed by `superadminTeam().teamId`
// are visible to it. Exists because the superAdmin can no longer browse the
// customer app — they're redirected to the platform shell (org-approval gate,
// 2026-06-10). Customer-app specs drive the app as THIS admin; the superadmin
// storageState is reserved for the platform specs.
export const APP_ADMIN_EMAIL = "e2e-app-admin@loadless.test";
export const APP_ADMIN_PASSWORD = "loadless";

/**
 * Upsert the e2e app-admin into the superadmin's (active) team + ensure it can
 * post in the default channel. Idempotent — safe to call every setup run.
 * Returns the creds the auth setup logs in with.
 */
export async function ensureAppAdmin(): Promise<{
  teamId: string;
  userId: string;
  email: string;
  password: string;
}> {
  const { teamId } = await superadminTeam();
  const passwordHash = await bcrypt.hash(APP_ADMIN_PASSWORD, 10);
  const user = await db().user.upsert({
    where: { email: APP_ADMIN_EMAIL },
    create: { teamId, role: "admin", name: "E2E Admin", email: APP_ADMIN_EMAIL },
    update: { teamId, role: "admin", deactivatedAt: null },
  });
  await db().account.upsert({
    where: {
      providerId_accountId: { providerId: "credential", accountId: APP_ADMIN_EMAIL },
    },
    create: {
      userId: user.id,
      providerId: "credential",
      accountId: APP_ADMIN_EMAIL,
      password: passwordHash,
    },
    update: { password: passwordHash, userId: user.id },
  });
  // Default-channel membership so /team doesn't dead-end on the "no channels"
  // path (mirrors registration + the superadmin seed).
  const channel = await db().teamChannel.findFirst({
    where: { teamId, isDefault: true },
    select: { id: true },
  });
  if (channel) {
    await db().teamChannelMember.upsert({
      where: { channelId_userId: { channelId: channel.id, userId: user.id } },
      create: { channelId: channel.id, userId: user.id, addedById: user.id },
      update: {},
    });
  }
  return { teamId, userId: user.id, email: APP_ADMIN_EMAIL, password: APP_ADMIN_PASSWORD };
}

/**
 * The e2e app-admin's identity (the user the customer-app specs browse +
 * make API calls AS). Use this — not `superadminTeam()` — wherever a spec
 * asserts on the ACTOR (message author, channel member, call answerer,
 * assignee): the request context authenticates as this admin, so the actor id
 * is this user's, not the super-admin's. The team is the same either way.
 */
export async function appAdmin(): Promise<{ teamId: string; userId: string }> {
  const user = await db().user.findFirst({
    where: { email: APP_ADMIN_EMAIL },
    select: { id: true, teamId: true },
  });
  if (!user) {
    throw new Error(
      "no e2e app-admin row — the app-admin auth setup must run first " +
        "(it calls ensureAppAdmin()).",
    );
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
    d.call.deleteMany({}),
    d.callPermissionRequest.deleteMany({}),
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
