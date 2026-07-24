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
 * Guarantee a default `#general` in `workspaceId` with `userId` in it.
 *
 * Created when missing rather than assumed: this suite is destructive and
 * several specs sweep team-chat rows, so #general does get deleted. A `/team`
 * with no channel never redirects, which surfaces as a navigation timeout in
 * unrelated specs and reads like a product regression. A setup helper should
 * leave the world in the state it promises.
 */
export async function ensureDefaultChannel(
  workspaceId: string,
  userId: string,
): Promise<string> {
  const channel =
    (await db().teamChannel.findFirst({
      where: { workspaceId, isDefault: true },
      select: { id: true },
    })) ??
    (await db().teamChannel.create({
      // `visibility: public` is explicit for the same reason provisionWorkspace
      // spells it out: the column defaults to private, and `update` refuses to
      // change a default channel's visibility, so a private #general is
      // unfixable through the UI.
      data: {
        workspaceId,
        name: "general",
        isDefault: true,
        visibility: "public",
        createdById: userId,
      },
      select: { id: true },
    }));
  await db().teamChannelMember.upsert({
    where: { channelId_userId: { channelId: channel.id, userId } },
    create: { channelId: channel.id, userId, addedById: userId },
    update: {},
  });
  return channel.id;
}

/**
 * The single superadmin row created by `prisma/seeds/seed-superadmin.ts`.
 * Resolved once at suite start so we don't keep pinging the user table.
 */
export async function superadminTeam(): Promise<{ workspaceId: string; userId: string }> {
  const user = await db().user.findFirst({
    where: { isSuperAdmin: true },
    select: {
      id: true,
      // Users are org-scoped; their workspace comes from the membership.
      workspaceMemberships: { select: { workspaceId: true }, orderBy: { createdAt: "asc" }, take: 1 },
    },
  });
  if (!user) {
    throw new Error("no superAdmin row — run pnpm db:seed:superadmin first");
  }
  const wsId = user.workspaceMemberships[0]?.workspaceId;
  if (!wsId) throw new Error("seeded user has no workspace membership");
  await ensureDefaultChannel(wsId, user.id);
  return { workspaceId: wsId, userId: user.id };
}

// Regular-admin test user. Lives in the SAME team as the superadmin (the
// seeded, active Loadless team) so fixtures keyed by `superadminTeam().workspaceId`
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
  workspaceId: string;
  userId: string;
  email: string;
  password: string;
}> {
  const { workspaceId } = await superadminTeam();
  // Users belong to the ORG; "admin" is a per-workspace grant on WorkspaceMember.
  const ws = await db().workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { organizationId: true },
  });
  const passwordHash = await bcrypt.hash(APP_ADMIN_PASSWORD, 10);
  const user = await db().user.upsert({
    where: { email: APP_ADMIN_EMAIL },
    create: { organizationId: ws.organizationId, name: "E2E Admin", email: APP_ADMIN_EMAIL },
    // Clear any avatarUrl a prior avatar-upload spec left on this fixture. Dev/CI
    // R2 blobs don't persist across runs, so a lingering
    // `/api/users/<id>/avatar?v=…` URL 404s on every surface that renders the
    // member — which made `/team` (and any member-list page) fail the predeploy
    // "no console errors" gate with a handful of identical avatar 404s. The
    // fixture should carry no avatar; real UI falls back to initials.
    update: { organizationId: ws.organizationId, deactivatedAt: null, avatarUrl: null },
  });
  await db().workspaceMember.upsert({
    where: { userId_workspaceId: { userId: user.id, workspaceId } },
    create: { userId: user.id, workspaceId, role: "admin" },
    update: { role: "admin" },
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
  // A default channel AND membership in it, so /team doesn't dead-end on the
  // "no channels" path (mirrors `provisionWorkspace` + the superadmin seed).
  await ensureDefaultChannel(workspaceId, user.id);

  return { workspaceId, userId: user.id, email: APP_ADMIN_EMAIL, password: APP_ADMIN_PASSWORD };
}

/**
 * The e2e app-admin's identity (the user the customer-app specs browse +
 * make API calls AS). Use this — not `superadminTeam()` — wherever a spec
 * asserts on the ACTOR (message author, channel member, call answerer,
 * assignee): the request context authenticates as this admin, so the actor id
 * is this user's, not the super-admin's. The team is the same either way.
 */
export async function appAdmin(): Promise<{ workspaceId: string; userId: string }> {
  const user = await db().user.findFirst({
    where: { email: APP_ADMIN_EMAIL },
    select: {
      id: true,
      // Users are org-scoped; their workspace comes from the membership.
      workspaceMemberships: { select: { workspaceId: true }, orderBy: { createdAt: "asc" }, take: 1 },
    },
  });
  if (!user) {
    throw new Error(
      "no e2e app-admin row — the app-admin auth setup must run first " +
        "(it calls ensureAppAdmin()).",
    );
  }
  const wsId = user.workspaceMemberships[0]?.workspaceId;
  if (!wsId) throw new Error("seeded user has no workspace membership");
  return { workspaceId: wsId, userId: user.id };
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
    d.workspaceApiKey.deleteMany({}),
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

/**
 * Create a test Workspace together with its owning Organization.
 *
 * Post-restructure a Workspace can't stand alone: the approval `status` (and
 * plan / seat cap) live on the Organization, and every spec that used to do
 * `workspace.create({ data: { name, status } })` needs both rows. Defaults to
 * an `active` org so specs aren't bounced by the org-approval gate.
 */
export async function createTestWorkspace(opts: {
  id?: string;
  name: string;
  status?: "pending" | "active" | "suspended";
}): Promise<{ organizationId: string; workspaceId: string }> {
  const org = await db().organization.create({
    data: { name: `${opts.name} Org`, status: opts.status ?? "active" },
  });
  const ws = await db().workspace.create({
    data: { ...(opts.id ? { id: opts.id } : {}), name: opts.name, organizationId: org.id },
  });
  return { organizationId: org.id, workspaceId: ws.id };
}

/**
 * Create a user in the same Organization as `workspaceId` and grant them
 * `role` in that workspace. Replaces the old
 * `user.create({ data: { workspaceId, role } })` shape.
 */
export async function createTestUser(opts: {
  workspaceId: string;
  name: string;
  email: string;
  role?: "admin" | "manager" | "agent";
  // Availability columns some specs seed directly on the user row.
  availabilityStatus?: string;
  availabilityManualStatus?: string;
  availabilityMessage?: string;
}): Promise<{ id: string; name: string }> {
  const ws = await db().workspace.findUniqueOrThrow({
    where: { id: opts.workspaceId },
    select: { organizationId: true },
  });
  const user = await db().user.create({
    data: {
      organizationId: ws.organizationId,
      name: opts.name,
      email: opts.email,
      ...(opts.availabilityStatus ? { availabilityStatus: opts.availabilityStatus } : {}),
      ...(opts.availabilityManualStatus
        ? { availabilityManualStatus: opts.availabilityManualStatus }
        : {}),
      ...(opts.availabilityMessage ? { availabilityMessage: opts.availabilityMessage } : {}),
    },
    select: { id: true, name: true },
  });
  await db().workspaceMember.create({
    data: { userId: user.id, workspaceId: opts.workspaceId, role: opts.role ?? "agent" },
  });
  return user;
}
