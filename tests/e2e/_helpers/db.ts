/**
 * Direct Postgres access for test fixtures. The tests bypass the API for
 * SETUP (seeding contacts, conversations, workflows, outbound webhooks)
 * because there's no point exercising 14 HTTP endpoints to assemble
 * fixture data — each setup call already gets its own API layer test
 * in predeploy.spec.ts. We use Prisma directly here so a fresh-DB
 * deployment can be tested with the SAME schema the app reads.
 *
 * ISOLATION (2026-07-26). This suite runs against the ONE shared dev
 * database, which also holds the maintainer's real workspaces and channel
 * connections. Everything here is therefore scoped to a dedicated throwaway
 * org/workspace (`e2e-app-org` / `e2e-app-ws`), mirroring the meta suite's
 * proven pattern (`_helpers/meta.ts`). The rules, enforced by tripwires:
 *
 *   - Every fixture row lives under an `e2e-`-prefixed workspace/org id.
 *   - `wipeTestData()` refuses to delete outside `e2e-` workspaces.
 *   - `scripts/check-test-isolation.mjs` fails CI on any unfiltered
 *     deleteMany/updateMany in tests/.
 *   - The isolation canary (isolation-canary.setup.ts + globalTeardown)
 *     plants realistic NON-e2e rows and fails the run if a suite touches
 *     them.
 *
 * The superadmin's real workspace is out of bounds for fixtures — platform
 * specs that genuinely need the superadmin identity use `_helpers/platform.ts`.
 */

import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
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

// ─── The dedicated e2e org/workspace (the isolation boundary) ──────────────

// Stable ids so a crashed run's leftovers are overwritten, not duplicated —
// same posture as META_TEST_TEAM_ID in _helpers/meta.ts.
export const E2E_APP_ORG_ID = "e2e-app-org";
export const E2E_APP_WS_ID = "e2e-app-ws";

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

// Regular-admin test user, the identity every customer-app spec drives the
// app as. Lives in the DEDICATED e2e workspace (`e2e-app-ws`) — NOT the
// maintainer's seeded workspace. Exists because the superAdmin can no longer
// browse the customer app — they're redirected to the platform shell
// (org-approval gate, 2026-06-10).
export const APP_ADMIN_EMAIL = "e2e-app-admin@loadless.test";
export const APP_ADMIN_PASSWORD = "loadless";
const APP_ADMIN_NAME = "E2E Admin";

/**
 * Idempotently (re)provision the dedicated e2e org + workspace + admin.
 *
 * The workspace's day-one contents mirror `provisionWorkspace`
 * (apps/api/src/lib/workspaces/provision.ts) — stages, starter message flags,
 * a public #general — so the fixture workspace looks exactly like the one a
 * real signup produces. Kept idempotent (upsert/skipDuplicates) because this
 * runs at the start of every suite.
 */
export async function ensureAppAdmin(): Promise<{
  workspaceId: string;
  userId: string;
  email: string;
  password: string;
}> {
  const d = db();

  await d.organization.upsert({
    where: { id: E2E_APP_ORG_ID },
    create: { id: E2E_APP_ORG_ID, name: "E2E App Org", status: "active" },
    update: { status: "active" },
  });
  await d.workspace.upsert({
    where: { id: E2E_APP_WS_ID },
    create: { id: E2E_APP_WS_ID, name: "E2E App Workspace", organizationId: E2E_APP_ORG_ID },
    update: { organizationId: E2E_APP_ORG_ID },
  });

  const passwordHash = await bcrypt.hash(APP_ADMIN_PASSWORD, 10);
  const user = await d.user.upsert({
    where: { email: APP_ADMIN_EMAIL },
    create: {
      organizationId: E2E_APP_ORG_ID,
      name: APP_ADMIN_NAME,
      email: APP_ADMIN_EMAIL,
      // Fixtures are created directly in the database, which is the same
      // proof-of-control the invite flow relies on. `emailVerified` defaults to
      // FALSE and `resolveSession` refuses an unverified user, so without this
      // every API call from this fixture 403s `email_not_verified`.
      emailVerified: true,
    },
    // Clear any avatarUrl a prior avatar-upload spec left on this fixture. Dev/CI
    // R2 blobs don't persist across runs, so a lingering
    // `/api/users/<id>/avatar?v=…` URL 404s on every surface that renders the
    // member — which made `/team` (and any member-list page) fail the predeploy
    // "no console errors" gate with a handful of identical avatar 404s. The
    // fixture should carry no avatar; real UI falls back to initials.
    update: {
      organizationId: E2E_APP_ORG_ID,
      deactivatedAt: null,
      avatarUrl: null,
      // Re-assert on update: an existing fixture row predating the
      // email-verification gate would otherwise stay unverified forever.
      emailVerified: true,
    },
  });

  // The fixture user's ONLY membership is the e2e workspace. A leftover
  // membership from the pre-isolation era (when this fixture joined the
  // maintainer's workspace) would win the "first membership" active-workspace
  // fallback and scope the whole suite to the wrong tenant — remove it.
  await d.workspaceMember.deleteMany({
    where: { userId: user.id, NOT: { workspaceId: E2E_APP_WS_ID } },
  });
  await d.workspaceMember.upsert({
    where: { userId_workspaceId: { userId: user.id, workspaceId: E2E_APP_WS_ID } },
    create: { userId: user.id, workspaceId: E2E_APP_WS_ID, role: "admin" },
    update: { role: "admin" },
  });
  // A stale device-choice pointing at another workspace would override the
  // single membership on login (cookie → stored → first membership).
  await d.session.updateMany({
    where: { userId: user.id, NOT: { activeWorkspaceId: E2E_APP_WS_ID } },
    data: { activeWorkspaceId: null },
  });

  await d.account.upsert({
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

  // Day-one workspace contents, mirroring provisionWorkspace: three stages,
  // the starter flag catalog, a public #general with this admin in it.
  await d.contactStage.createMany({
    data: [
      { workspaceId: E2E_APP_WS_ID, name: "Stage 1", color: "lime", position: 0, isDefault: true },
      { workspaceId: E2E_APP_WS_ID, name: "Stage 2", color: "amber", position: 1, isDefault: false },
      { workspaceId: E2E_APP_WS_ID, name: "Stage 3", color: "emerald", position: 2, isDefault: false },
    ],
    skipDuplicates: true,
  });
  await d.messageFlagDefinition.createMany({
    data: [
      { workspaceId: E2E_APP_WS_ID, name: "Complaint", color: "rose", description: "The customer is unhappy — needs a follow-up.", sortOrder: 0 },
      { workspaceId: E2E_APP_WS_ID, name: "Refund request", color: "amber", description: "The customer asked for money back.", sortOrder: 1 },
      { workspaceId: E2E_APP_WS_ID, name: "Follow up", color: "sky", description: "Come back to this one later.", sortOrder: 2 },
      { workspaceId: E2E_APP_WS_ID, name: "Urgent", color: "orange", description: "Needs attention before anything else in the queue.", sortOrder: 3 },
    ],
    skipDuplicates: true,
  });
  await ensureDefaultChannel(E2E_APP_WS_ID, user.id);

  return { workspaceId: E2E_APP_WS_ID, userId: user.id, email: APP_ADMIN_EMAIL, password: APP_ADMIN_PASSWORD };
}

/**
 * The e2e app-admin's identity (the user the customer-app specs browse +
 * make API calls AS). Every fixture should be keyed by THIS workspace id.
 * The membership filter is explicit so a stray legacy membership row can
 * never re-point the whole suite at another tenant.
 */
export async function appAdmin(): Promise<{ workspaceId: string; userId: string }> {
  const user = await db().user.findFirst({
    where: { email: APP_ADMIN_EMAIL },
    select: {
      id: true,
      workspaceMemberships: {
        where: { workspaceId: E2E_APP_WS_ID },
        select: { workspaceId: true },
        take: 1,
      },
    },
  });
  if (!user) {
    throw new Error(
      "no e2e app-admin row — the app-admin auth setup must run first " +
        "(it calls ensureAppAdmin()).",
    );
  }
  const wsId = user.workspaceMemberships[0]?.workspaceId;
  if (!wsId) throw new Error("e2e app-admin has no membership in e2e-app-ws — rerun the setup");
  return { workspaceId: wsId, userId: user.id };
}

/**
 * Wipe test-state tables INSIDE the given e2e workspaces (default: the
 * dedicated app workspace). Run at the END of each suite (afterAll), not the
 * start — a leftover row in a child table doesn't break the next suite but
 * ensures the suite itself runs against the expected state.
 *
 * TRIPWIRE: every id must be `e2e-`-prefixed. This function used to be 14
 * UNFILTERED deleteMany({}) calls against the shared dev database — it
 * destroyed the maintainer's real contacts, conversations, and API keys.
 * Never widen it again; a spec that seeds another workspace passes that
 * workspace's (e2e-prefixed) id explicitly.
 *
 * Order matters: child tables before parents.
 */
export async function wipeTestData(workspaceIds: string[] = [E2E_APP_WS_ID]): Promise<void> {
  for (const id of workspaceIds) {
    if (!/^e2e-/.test(id)) {
      throw new Error(
        `wipeTestData refused: "${id}" is not an e2e- workspace id. ` +
          "Test cleanup must never touch a real tenant.",
      );
    }
  }
  const d = db();
  const scope = { workspaceId: { in: workspaceIds } };
  await d.$transaction([
    // OutboundWebhookDelivery carries no workspaceId (tenancy via parent) —
    // scope through the owning webhook.
    d.outboundWebhookDelivery.deleteMany({ where: { webhook: scope } }),
    d.outboundEvent.deleteMany({ where: scope }),
    d.outboundWebhook.deleteMany({ where: scope }),
    d.workflowRun.deleteMany({ where: scope }),
    d.workflowContactState.deleteMany({ where: scope }),
    d.workflow.deleteMany({ where: scope }),
    d.internalNote.deleteMany({ where: scope }),
    d.conversationEvent.deleteMany({ where: scope }),
    d.call.deleteMany({ where: scope }),
    d.callPermissionRequest.deleteMany({ where: scope }),
    d.message.deleteMany({ where: scope }),
    d.conversation.deleteMany({ where: scope }),
    d.contact.deleteMany({ where: scope }),
    d.workspaceApiKey.deleteMany({ where: scope }),
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
 *
 * Ids are forced into the `e2e-` namespace so `wipeTestData` (and any future
 * sweeper) can tell fixtures from real tenants at a glance. An explicit
 * `opts.id` must already carry the prefix.
 */
export async function createTestWorkspace(opts: {
  id?: string;
  name: string;
  status?: "pending" | "active" | "suspended";
}): Promise<{ organizationId: string; workspaceId: string }> {
  if (opts.id && !/^e2e-/.test(opts.id)) {
    throw new Error(
      `createTestWorkspace: id "${opts.id}" must start with "e2e-" (isolation namespace)`,
    );
  }
  const id = opts.id ?? `e2e-${randomBytes(6).toString("hex")}`;
  const org = await db().organization.create({
    data: {
      id: `${id}-org`,
      name: `${opts.name} Org`,
      status: opts.status ?? "active",
    },
  });
  const ws = await db().workspace.create({
    data: { id, name: opts.name, organizationId: org.id },
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
      // `User.emailVerified` defaults to FALSE, and `resolveSession` refuses to
      // act for an unverified user — so a fixture minted without this is
      // rejected by every API call with 403 `email_not_verified`, and the spec
      // fails somewhere far from the cause. These users are created directly in
      // the database, which is the same proof-of-control the invite flow relies
      // on when it sets this itself.
      emailVerified: true,
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
