/**
 * Assignment routing, end to end through the REAL pipeline.
 *
 * The pure engine is covered without a database in
 * `workflows-events/assignment-select.spec.ts`. THIS file is the other half:
 * every scenario that only exists once Prisma, the event bus, the webhook
 * ingest and the `/v1` API are actually running — the places where a routing
 * bug would be invisible to a unit test.
 *
 * Covered here:
 *   · the `/v1` configuration surface (policy CRUD, version CAS, rules, preview)
 *   · least-busy / weighted / fixed / manual against REAL conversation counts
 *   · capacity limits and each overflow rule
 *   · routing rules choosing a policy by channel and by tag
 *   · auto-assign on a genuine inbound WhatsApp webhook, and on a reopen
 *   · the never-steal-from-a-human guard, incl. webhook redelivery
 *   · campaign splits: exact counts, percentages, and the on_reply default
 *   · the campaign-vs-policy race that on_reply introduced
 *   · deactivation rebalance
 *
 * Serial by necessity: these share one team and mutate its routing config.
 */

import { test, expect } from "@playwright/test";

import { buildBroadcastAssignmentPlan } from "../../../apps/api/src/lib/assignment/broadcast-plan";
import { db, pollUntil } from "../_helpers/db";
import {
  seedMetaTestTeam,
  postMetaWebhook,
  META_TEST_TEAM_ID,
  META_API_BASE,
  WA_PHONE_NUMBER_ID,
  WA_WABA_ID,
} from "../_helpers/meta";

test.describe.configure({ mode: "serial" });

const PREFIX = "e2e_assign_";
/** Unique per run: contacts are unique on (workspaceId, phoneNumber) and the inbound
 *  webhook creates its own rows, so a fixed number collides with leftovers. */
const PHONE_BASE = `1777${String(Date.now()).slice(-6)}`;
let phoneSeq = 0;

let apiToken: string;
let ALI: string;
let SARA: string;
let OMAR: string;

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * `/v1` call with a 429 backoff.
 *
 * The API rate-limits these routes to 60/min per key. That is a REAL product
 * guardrail protecting a shared VPS, so the suite respects it rather than
 * disabling it — a test that only passes with the limiter off would be lying
 * about what a partner integration can do. This whole file makes ~80 calls in
 * a few seconds, which no real client would.
 */
async function api(path: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${META_API_BASE}/api/external/v1${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (res.status === 429 && attempt < 24) {
      await new Promise((r) => setTimeout(r, 3_000));
      continue;
    }
    // `seedMetaTestTeam()` ROTATES the team's API keys (it deletes every row and
    // mints one), so any other spec — or a re-entrant run — that re-seeds this
    // shared team invalidates the token we're holding mid-suite. Re-seed and
    // retry once rather than failing a routing assertion for a harness reason.
    if (res.status === 401 && attempt < 2) {
      apiToken = (await seedMetaTestTeam()).apiToken;
      defaultPolicy = null;
      continue;
    }
    return res;
  }
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await api(path, init);
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

interface PolicyRow {
  id: string;
  name: string;
  version: number;
  isDefault: boolean;
}

async function makeUser(name: string): Promise<string> {
  const u = await db().user.create({
    data: {
      organizationId: (await db().workspace.findUniqueOrThrow({ where: { id: META_TEST_TEAM_ID }, select: { organizationId: true } })).organizationId,
      name: `${PREFIX}${name}`,
      email: `${PREFIX}${name}.${Date.now()}@loadless.test`,
      availabilityStatus: "available",
      // Created directly in the DB, so it is verified by construction — the
      // column defaults to FALSE and `resolveSession` refuses an unverified
      // user, which surfaces as a 403 `email_not_verified` far from the cause.
      emailVerified: true,
    },
    select: { id: true },
  });
  await db().workspaceMember.create({ data: { userId: u.id, workspaceId: META_TEST_TEAM_ID, role: "agent" } });
  return u.id;
}

/** A contact + its conversation, in whatever state the scenario needs. */
async function makeConversation(opts: {
  tag: string;
  assignedUserId?: string | null;
  status?: "open" | "pending" | "closed";
}): Promise<{ contactId: string; conversationId: string; digits: string }> {
  const digits = `${PHONE_BASE}${phoneSeq++}`;
  const contact = await db().contact.create({
    data: {
      workspaceId: META_TEST_TEAM_ID,
      name: `${PREFIX}${opts.tag}`,
      // Digits only, no "+": that's how ingest normalizes a WhatsApp number.
      phoneNumber: digits,
      identityChannel: "whatsapp",
      source: "manual",
    },
    select: { id: true },
  });
  const conversation = await db().conversation.create({
    data: {
      workspaceId: META_TEST_TEAM_ID,
      contactId: contact.id,
      channel: "whatsapp",
      status: opts.status ?? "pending",
      assignedUserId: opts.assignedUserId ?? null,
      lastMessagePreview: "",
    },
    select: { id: true },
  });
  return { contactId: contact.id, conversationId: conversation.id, digits };
}

/** Give a user N open conversations, so least-busy has real load to read. */
async function loadUser(userId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await makeConversation({ tag: `load${i}`, assignedUserId: userId, status: "open" });
  }
}

/** A genuine inbound WhatsApp text through the signed webhook endpoint. */
async function inbound(digits: string, body: string): Promise<void> {
  const res = await postMetaWebhook(META_TEST_TEAM_ID, {
    object: "whatsapp_business_account",
    entry: [
      {
        id: WA_WABA_ID,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550000000", phone_number_id: WA_PHONE_NUMBER_ID },
              contacts: [{ profile: { name: "Tester" }, wa_id: digits }],
              messages: [
                {
                  from: digits,
                  id: `wamid.${PREFIX}${Date.now()}.${phoneSeq++}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  expect(res.status).toBe(200);
}

async function assigneeOf(conversationId: string): Promise<string | null> {
  const row = await db().conversation.findUnique({
    where: { id: conversationId },
    select: { assignedUserId: true },
  });
  return row?.assignedUserId ?? null;
}

/** The conversation ingest resolved for a phone (it may create its own). */
async function conversationForPhone(digits: string): Promise<string> {
  const contact = await db().contact.findFirstOrThrow({
    where: { workspaceId: META_TEST_TEAM_ID, phoneNumber: digits },
    select: { id: true },
  });
  const conv = await db().conversation.findFirstOrThrow({
    where: { workspaceId: META_TEST_TEAM_ID, contactId: contact.id },
    select: { id: true },
  });
  return conv.id;
}

async function setSettings(body: Record<string, unknown>): Promise<void> {
  const res = await api("/assignment/settings", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`settings → ${res.status} ${await res.text()}`);
}

/**
 * Rewrite the default policy in place — most tests just need one behaviour.
 *
 * The current version is tracked LOCALLY from each PUT's response rather than
 * re-fetched, which halves this file's request count. That matters: these
 * routes are rate limited to 60/min per key (correctly — see `api`), and a
 * chattier suite spends its time in backoff instead of testing. On a 409 we
 * re-read once and retry, which also exercises the CAS recovery path a real
 * client would take.
 */
let defaultPolicy: PolicyRow | null = null;

async function loadDefaultPolicy(): Promise<PolicyRow> {
  const { policies } = await apiJson<{ policies: PolicyRow[] }>("/assignment");
  defaultPolicy = policies.find((p) => p.isDefault)!;
  return defaultPolicy;
}

async function configureDefault(body: Record<string, unknown>): Promise<PolicyRow> {
  const def = defaultPolicy ?? (await loadDefaultPolicy());
  const res = await api(`/assignment/policies/${def.id}`, {
    method: "PUT",
    body: JSON.stringify({ name: def.name, ...body, expectedVersion: def.version }),
  });
  if (res.status === 409) {
    const fresh = await loadDefaultPolicy();
    const retry = await apiJson<{ policy: PolicyRow }>(`/assignment/policies/${fresh.id}`, {
      method: "PUT",
      body: JSON.stringify({ name: fresh.name, ...body, expectedVersion: fresh.version }),
    });
    defaultPolicy = retry.policy;
    return retry.policy;
  }
  if (!res.ok) throw new Error(`configureDefault → ${res.status} ${await res.text()}`);
  const { policy } = (await res.json()) as { policy: PolicyRow };
  defaultPolicy = policy;
  return policy;
}

// --------------------------------------------------------------------------

test.beforeAll(async () => {
  const seeded = await seedMetaTestTeam();
  apiToken = seeded.apiToken;

  // A clean slate: prior runs' agents would otherwise sit in every policy pool
  // and make "who got it" nondeterministic.
  await db().user.deleteMany({
    where: {
      workspaceMemberships: { some: { workspaceId: META_TEST_TEAM_ID } },
      name: { startsWith: PREFIX },
    },
  });
  await db().assignmentRule.deleteMany({ where: { workspaceId: META_TEST_TEAM_ID } });
  await db().team.deleteMany({ where: { workspaceId: META_TEST_TEAM_ID } });
  await db().assignmentSettings.deleteMany({ where: { workspaceId: META_TEST_TEAM_ID } });

  ALI = await makeUser("ali");
  SARA = await makeUser("sara");
  OMAR = await makeUser("omar");

  // Deactivate the seed user so it never competes for assignments.
  await db().user.update({
    where: { id: seeded.userId },
    data: { deactivatedAt: new Date() },
  });
});

test.afterAll(async () => {
  await db().conversation.deleteMany({
    where: { workspaceId: META_TEST_TEAM_ID, contact: { name: { startsWith: PREFIX } } },
  });
  await db().contact.deleteMany({
    where: { workspaceId: META_TEST_TEAM_ID, phoneNumber: { startsWith: PHONE_BASE } },
  });
  await db().contact.deleteMany({
    where: { workspaceId: META_TEST_TEAM_ID, name: { startsWith: PREFIX } },
  });
  await db().assignmentRule.deleteMany({ where: { workspaceId: META_TEST_TEAM_ID } });
  await db().team.deleteMany({ where: { workspaceId: META_TEST_TEAM_ID } });
  await db().user.deleteMany({
    where: {
      workspaceMemberships: { some: { workspaceId: META_TEST_TEAM_ID } },
      name: { startsWith: PREFIX },
    },
  });
});

// ==========================================================================
// 1. Configuration surface (/v1 parity)
// ==========================================================================

test.describe("configuration", () => {
  test("a team with no rows still gets a working default policy", async () => {
    const { policies, settings, members } = await apiJson<{
      policies: PolicyRow[];
      settings: { autoAssignOnNewConversation: boolean; reassignOnDeactivate: boolean };
      members: Array<{ id: string; openCount: number }>;
    }>("/assignment");

    expect(policies.length).toBeGreaterThanOrEqual(1);
    expect(policies.filter((p) => p.isDefault)).toHaveLength(1);
    // Everything ships OFF except deactivation rebalance.
    expect(settings.autoAssignOnNewConversation).toBe(false);
    expect(settings.reassignOnDeactivate).toBe(true);
    expect(members.map((m) => m.id)).toEqual(expect.arrayContaining([ALI, SARA, OMAR]));
  });

  test("a stale expectedVersion is rejected instead of clobbering a co-admin", async () => {
    const { policies } = await apiJson<{ policies: PolicyRow[] }>("/assignment");
    const def = policies.find((p) => p.isDefault)!;

    const first = await api(`/assignment/policies/${def.id}`, {
      method: "PUT",
      body: JSON.stringify({ name: "Renamed", expectedVersion: def.version }),
    });
    expect(first.ok).toBeTruthy();

    // Same version again — the other admin's save already bumped it.
    const stale = await api(`/assignment/policies/${def.id}`, {
      method: "PUT",
      body: JSON.stringify({ name: "Clobbered", expectedVersion: def.version }),
    });
    expect(stale.status).toBe(409);

    const after = await db().team.findUniqueOrThrow({ where: { id: def.id } });
    expect(after.name).toBe("Renamed");
    // This test deliberately bumped the version out from under the local
    // tracker — drop it so the next configureDefault re-reads.
    defaultPolicy = null;
  });

  test("the default policy cannot be archived (it is the fallback)", async () => {
    const { policies } = await apiJson<{ policies: PolicyRow[] }>("/assignment");
    const def = policies.find((p) => p.isDefault)!;
    const res = await api(`/assignment/policies/${def.id}`, { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  test("archiving a policy removes its rules and clears the AI handoff pointer", async () => {
    const { policy } = await apiJson<{ policy: PolicyRow }>("/assignment/policies", {
      method: "POST",
      body: JSON.stringify({ name: "Temp", strategy: "fixed", fixedUserId: ALI }),
    });
    await apiJson("/assignment/rules", {
      method: "POST",
      body: JSON.stringify({ name: "temp rule", policyId: policy.id, conditions: {} }),
    });
    await setSettings({ aiHandoffPolicyId: policy.id });

    const res = await api(`/assignment/policies/${policy.id}`, { method: "DELETE" });
    expect(res.ok).toBeTruthy();

    expect(
      await db().assignmentRule.count({ where: { workspaceId: META_TEST_TEAM_ID, policyId: policy.id } }),
    ).toBe(0);
    const settings = await db().assignmentSettings.findUniqueOrThrow({
      where: { workspaceId: META_TEST_TEAM_ID },
    });
    expect(settings.aiHandoffPolicyId).toBeNull();
  });

  test("a fixed/fallback target outside the team is rejected at save time", async () => {
    const res = await api("/assignment/policies", {
      method: "POST",
      body: JSON.stringify({ name: "Bad", strategy: "fixed", fixedUserId: "not-a-user" }),
    });
    expect(res.status).toBe(400);
  });
});

// ==========================================================================
// 2. Strategies against real workload
// ==========================================================================

test.describe("strategies", () => {
  test("least_busy reads ACTUAL open conversations", async () => {
    await configureDefault({
      strategy: "least_busy",
      eligibility: "any_active",
      members: [
        { userId: ALI, weight: 1, enabled: true },
        { userId: SARA, weight: 1, enabled: true },
        { userId: OMAR, weight: 1, enabled: true },
      ],
    });
    await loadUser(ALI, 3);
    await loadUser(SARA, 1);
    // OMAR has none → must win.

    const { decision } = await apiJson<{ decision: { userId: string } }>(
      "/assignment/preview",
      { method: "POST", body: JSON.stringify({ source: "inbound" }) },
    );
    expect(decision.userId).toBe(OMAR);
  });

  test("preview is read-only — polling it never skews the rotation", async () => {
    const before = await db().team.findFirstOrThrow({
      where: { workspaceId: META_TEST_TEAM_ID, isDefault: true },
      select: { cursorUserId: true },
    });
    for (let i = 0; i < 5; i++) {
      await apiJson("/assignment/preview", {
        method: "POST",
        body: JSON.stringify({ source: "inbound" }),
      });
    }
    const after = await db().team.findFirstOrThrow({
      where: { workspaceId: META_TEST_TEAM_ID, isDefault: true },
      select: { cursorUserId: true },
    });
    expect(after.cursorUserId).toBe(before.cursorUserId);
  });

  test("weighted 50/20 splits EXACTLY over real assignments", async () => {
    await configureDefault({
      strategy: "weighted",
      eligibility: "any_active",
      includeAllMembers: false,
      members: [
        { userId: ALI, weight: 50, enabled: true },
        { userId: SARA, weight: 20, enabled: true },
      ],
    });
    // Reset the counters so the ratio starts clean.
    await db().teamMember.updateMany({
      where: { workspaceId: META_TEST_TEAM_ID },
      data: { served: 0 },
    });

    // 14 assignments at 50/20 (= 5:2) must land EXACTLY 10/4. Deliberately not
    // 70 in a tight loop: the /v1 assign route is rate limited to 60/min, and
    // fighting a real product guardrail in a test proves nothing. The ratio is
    // what's under test, and 14 pins it just as hard.
    const tally: Record<string, number> = { [ALI]: 0, [SARA]: 0 };
    for (let i = 0; i < 14; i++) {
      const conv = await makeConversation({ tag: `w${i}` });
      const res = await api(`/conversations/${conv.conversationId}/assign`, {
        method: "POST",
        body: JSON.stringify({ autoAssign: true }),
      });
      if (!res.ok) throw new Error(`assign ${i} → ${res.status} ${await res.text()}`);
      const who = await assigneeOf(conv.conversationId);
      if (who) tally[who] = (tally[who] ?? 0) + 1;
    }
    expect(tally[ALI]).toBe(10);
    expect(tally[SARA]).toBe(4);
  });

  test("manual assigns nobody, and says so", async () => {
    await configureDefault({ strategy: "manual" });
    const conv = await makeConversation({ tag: "manualpolicy" });
    const res = await api(`/conversations/${conv.conversationId}/assign`, {
      method: "POST",
      body: JSON.stringify({ autoAssign: true }),
    });
    // Not an error — "nobody" is the configured outcome, and a 4xx would make
    // partners retry a call that behaved correctly.
    expect(res.ok).toBeTruthy();
    expect(await assigneeOf(conv.conversationId)).toBeNull();
  });
});

// ==========================================================================
// 3. Capacity + overflow
// ==========================================================================

test.describe("capacity", () => {
  test("everyone at their cap → the triage queue", async () => {
    await configureDefault({
      strategy: "least_busy",
      eligibility: "any_active",
      includeAllMembers: false,
      defaultMaxOpen: 1,
      overflow: "leave_unassigned",
      members: [{ userId: OMAR, weight: 1, maxOpen: 1, enabled: true }],
    });
    await loadUser(OMAR, 2); // already over

    const conv = await makeConversation({ tag: "capfull" });
    await api(`/conversations/${conv.conversationId}/assign`, {
      method: "POST",
      body: JSON.stringify({ autoAssign: true }),
    });
    expect(await assigneeOf(conv.conversationId)).toBeNull();

    const { decision } = await apiJson<{ decision: { reason: string } }>(
      "/assignment/preview",
      { method: "POST", body: JSON.stringify({ source: "inbound" }) },
    );
    expect(decision.reason).toBe("at_capacity");
  });

  test("overflow = fallback_user hands it to the supervisor", async () => {
    await configureDefault({
      strategy: "least_busy",
      eligibility: "any_active",
      includeAllMembers: false,
      defaultMaxOpen: 1,
      overflow: "fallback_user",
      fallbackUserId: SARA,
      members: [{ userId: OMAR, weight: 1, maxOpen: 1, enabled: true }],
    });
    const conv = await makeConversation({ tag: "capfallback" });
    await api(`/conversations/${conv.conversationId}/assign`, {
      method: "POST",
      body: JSON.stringify({ autoAssign: true }),
    });
    expect(await assigneeOf(conv.conversationId)).toBe(SARA);
  });

  test("overflow = ignore_capacity assigns the least loaded anyway", async () => {
    await configureDefault({
      strategy: "least_busy",
      eligibility: "any_active",
      includeAllMembers: false,
      defaultMaxOpen: 1,
      overflow: "ignore_capacity",
      members: [{ userId: OMAR, weight: 1, maxOpen: 1, enabled: true }],
    });
    const conv = await makeConversation({ tag: "capignore" });
    await api(`/conversations/${conv.conversationId}/assign`, {
      method: "POST",
      body: JSON.stringify({ autoAssign: true }),
    });
    expect(await assigneeOf(conv.conversationId)).toBe(OMAR);
  });
});

// ==========================================================================
// 4. Routing rules
// ==========================================================================

test.describe("routing rules", () => {
  test("a rule routes to its own policy; everything else falls to the default", async () => {
    await configureDefault({
      strategy: "fixed",
      fixedUserId: OMAR,
      includeAllMembers: true,
      defaultMaxOpen: null,
      overflow: "leave_unassigned",
      fallbackUserId: null,
    });
    const { policy: vip } = await apiJson<{ policy: PolicyRow }>("/assignment/policies", {
      method: "POST",
      body: JSON.stringify({ name: "VIP", strategy: "fixed", fixedUserId: ALI }),
    });

    // Tags are unique on (workspaceId, name) and this team is reused across runs —
    // upsert so a leftover from a previous run doesn't fail the setup.
    const tag = await db().tag.upsert({
      where: { workspaceId_name: { workspaceId: META_TEST_TEAM_ID, name: `${PREFIX}vip` } },
      create: { workspaceId: META_TEST_TEAM_ID, name: `${PREFIX}vip`, color: "sky" },
      update: {},
      select: { id: true },
    });
    await apiJson("/assignment/rules", {
      method: "POST",
      body: JSON.stringify({
        name: "VIP tag",
        policyId: vip.id,
        conditions: { tagIds: [tag.id] },
      }),
    });

    // Tagged → VIP policy → Ali.
    const tagged = await makeConversation({ tag: "vip" });
    await db().contact.update({
      where: { id: tagged.contactId },
      data: { tags: { connect: { id: tag.id } } },
    });
    await api(`/conversations/${tagged.conversationId}/assign`, {
      method: "POST",
      body: JSON.stringify({ autoAssign: true }),
    });
    expect(await assigneeOf(tagged.conversationId)).toBe(ALI);

    // Untagged → no rule matches → default policy → Omar.
    const plain = await makeConversation({ tag: "plain" });
    await api(`/conversations/${plain.conversationId}/assign`, {
      method: "POST",
      body: JSON.stringify({ autoAssign: true }),
    });
    expect(await assigneeOf(plain.conversationId)).toBe(OMAR);

    await db().assignmentRule.deleteMany({ where: { workspaceId: META_TEST_TEAM_ID } });
  });

  test("an explicit policyId overrides the rules entirely", async () => {
    const { policy: pinned } = await apiJson<{ policy: PolicyRow }>("/assignment/policies", {
      method: "POST",
      body: JSON.stringify({ name: "Pinned", strategy: "fixed", fixedUserId: SARA }),
    });
    const conv = await makeConversation({ tag: "pinned" });
    await api(`/conversations/${conv.conversationId}/assign`, {
      method: "POST",
      body: JSON.stringify({ autoAssign: true, policyId: pinned.id }),
    });
    expect(await assigneeOf(conv.conversationId)).toBe(SARA);
  });
});

// ==========================================================================
// 5. Automatic routing on a REAL inbound webhook
// ==========================================================================

test.describe("auto-assign on inbound", () => {
  test.beforeAll(async () => {
    await configureDefault({
      strategy: "fixed",
      fixedUserId: OMAR,
      includeAllMembers: true,
      defaultMaxOpen: null,
      overflow: "leave_unassigned",
    });
  });

  test("OFF by default: an inbound assigns nobody", async () => {
    await setSettings({
      autoAssignOnNewConversation: false,
      autoAssignOnReopen: false,
    });
    const digits = `${PHONE_BASE}${phoneSeq++}`;
    await inbound(digits, "hello");
    const conversationId = await pollUntil(
      async () => conversationForPhone(digits).catch(() => null),
      { timeoutMs: 25_000, label: "conversation created" },
    );
    // Give the subscriber tier a chance to have run, then assert it didn't.
    await new Promise((r) => setTimeout(r, 500));
    expect(await assigneeOf(conversationId!)).toBeNull();
  });

  test("ON: a brand-new conversation is routed from its first message", async () => {
    await setSettings({ autoAssignOnNewConversation: true, skipWhenAiHandling: true });
    const digits = `${PHONE_BASE}${phoneSeq++}`;
    await inbound(digits, "hello there");

    // The auto-assign subscriber runs DETACHED from the webhook response
    // (background tier), so the 200 is not a promise that routing has landed.
    const assigned = await pollUntil(
      async () => {
        const id = await conversationForPhone(digits).catch(() => null);
        return id ? await assigneeOf(id) : null;
      },
      { timeoutMs: 25_000, label: "auto-assigned" },
    );
    expect(assigned).toBe(OMAR);
  });

  test("automation NEVER takes a conversation from a human", async () => {
    await setSettings({ autoAssignOnNewConversation: true, autoAssignOnReopen: true });
    const conv = await makeConversation({ tag: "claimed", assignedUserId: SARA, status: "open" });

    await inbound(conv.digits, "another message");
    await new Promise((r) => setTimeout(r, 700));

    // Sara keeps it, even though the policy says Omar.
    expect(await assigneeOf(conv.conversationId)).toBe(SARA);
  });

  test("a redelivered webhook cannot reassign (idempotent by construction)", async () => {
    await setSettings({ autoAssignOnNewConversation: true, autoAssignOnReopen: true });
    const digits = `${PHONE_BASE}${phoneSeq++}`;
    await inbound(digits, "first");
    const conversationId = await pollUntil(
      async () => {
        const id = await conversationForPhone(digits).catch(() => null);
        return id && (await assigneeOf(id)) ? id : null;
      },
      { timeoutMs: 25_000, label: "first assign" },
    ).catch(async (err: unknown) => {
      const contact = await db().contact.findFirst({
        where: { workspaceId: META_TEST_TEAM_ID, phoneNumber: digits },
        select: { id: true },
      });
      const conv = contact
        ? await db().conversation.findFirst({
            where: { workspaceId: META_TEST_TEAM_ID, contactId: contact.id },
            select: { id: true, assignedUserId: true, status: true, createdAt: true },
          })
        : null;
      const msgs = conv
        ? await db().message.findMany({
            where: { conversationId: conv.id },
            select: { direction: true, body: true },
          })
        : [];
      const preview = await api("/assignment/preview", {
        method: "POST",
        body: JSON.stringify({ source: "inbound" }),
      }).then((r) => r.text());
      const outbox = await db().outboundEvent.count({
        where: { workspaceId: META_TEST_TEAM_ID, dispatchedAt: null },
      });
      throw new Error(
        `${String(err)} | preview=${preview} | pendingOutbox=${outbox} | conv=${JSON.stringify(conv)} | msgs=${JSON.stringify(msgs)}`,
      );
    });

    // A human takes over, then Meta redelivers.
    await db().conversation.update({
      where: { id: conversationId! },
      data: { assignedUserId: ALI },
    });
    await inbound(digits, "second");
    await new Promise((r) => setTimeout(r, 700));
    expect(await assigneeOf(conversationId!)).toBe(ALI);
  });

  test("autoAssignOnReopen routes an UNASSIGNED existing thread", async () => {
    await setSettings({ autoAssignOnNewConversation: false, autoAssignOnReopen: true });
    const conv = await makeConversation({ tag: "reopen", assignedUserId: null, status: "closed" });

    await inbound(conv.digits, "are you there?");
    const assigned = await pollUntil(
      async () => assigneeOf(conv.conversationId),
      { timeoutMs: 25_000, label: "assigned" },
    );
    expect(assigned).toBe(OMAR);
  });

  test.afterAll(async () => {
    await setSettings({ autoAssignOnNewConversation: false, autoAssignOnReopen: false });
  });
});

// ==========================================================================
// 6. Campaign assignment
// ==========================================================================

test.describe("campaign assignment", () => {
  test("exact counts are exact, and interleaved across the audience", async () => {
    const plan = await buildBroadcastAssignmentPlan({
      db: db(),
      workspaceId: META_TEST_TEAM_ID,
      total: 100,
      config: {
        mode: "split_counts",
        assignmentUserId: null,
        assignmentPolicyId: null,
        assignmentSplit: [
          { userId: ALI, value: 50 },
          { userId: SARA, value: 10 },
        ],
        assignmentLeftover: "leave_unassigned",
      },
    });
    const counts = plan.perRecipient.reduce<Record<string, number>>((acc, id) => {
      const key = id ?? "unassigned";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts[ALI]).toBe(50);
    expect(counts[SARA]).toBe(10);
    expect(counts.unassigned).toBe(40);

    // Interleaved, not blocked: the first 60 aren't all Ali's. This is what
    // keeps a campaign paused halfway proportional.
    expect(plan.perRecipient.slice(0, 12)).toContain(SARA);
  });

  test("percentages apportion to exactly the audience size", async () => {
    const plan = await buildBroadcastAssignmentPlan({
      db: db(),
      workspaceId: META_TEST_TEAM_ID,
      total: 10,
      config: {
        mode: "split_percent",
        assignmentUserId: null,
        assignmentPolicyId: null,
        assignmentSplit: [
          { userId: ALI, value: 1 },
          { userId: SARA, value: 1 },
          { userId: OMAR, value: 1 },
        ],
        assignmentLeftover: "leave_unassigned",
      },
    });
    expect(plan.perRecipient.filter((x) => x != null)).toHaveLength(10);
    expect(plan.totals.reduce((a, b) => a + b.count, 0)).toBe(10);
  });

  test("a member who LEFT drops to unassigned instead of a ghost id", async () => {
    const gone = await makeUser("gone");
    await db().user.update({ where: { id: gone }, data: { deactivatedAt: new Date() } });

    const plan = await buildBroadcastAssignmentPlan({
      db: db(),
      workspaceId: META_TEST_TEAM_ID,
      total: 5,
      config: {
        mode: "fixed",
        assignmentUserId: gone,
        assignmentPolicyId: null,
        assignmentSplit: null,
        assignmentLeftover: "leave_unassigned",
      },
    });
    expect(plan.perRecipient.every((x) => x === null)).toBe(true);
  });

  test("on_reply (the default) assigns ONLY when the customer answers", async () => {
    const conv = await makeConversation({ tag: "camp_reply" });
    const broadcast = await db().broadcast.create({
      data: {
        workspaceId: META_TEST_TEAM_ID,
        status: "completed",
        kind: "template",
        targetMode: "contact",
        channel: "whatsapp",
        templateName: `${PREFIX}camp`,
        templateLanguage: "en",
        templateCategory: "MARKETING",
        variables: { body: [] },
        audienceMode: "all",
        totalCount: 1,
        assignmentMode: "fixed",
        assignmentUserId: ALI,
        assignmentTrigger: "on_reply",
      },
      select: { id: true },
    });
    await db().broadcastRecipient.create({
      data: {
        broadcastId: broadcast.id,
        contactId: conv.contactId,
        conversationId: conv.conversationId,
        assignedUserId: ALI,
        status: "sent",
        deliveryState: "delivered",
        externalId: `wamid.${PREFIX}camp.${Date.now()}`,
        sentAt: new Date(Date.now() - 60_000),
      },
    });

    // Sent, not replied → nobody owns it. This is the whole point: 10,000
    // recipients must not become 10,000 assigned conversations.
    expect(await assigneeOf(conv.conversationId)).toBeNull();

    await inbound(conv.digits, "yes I am interested");

    const assigned = await pollUntil(
      async () => assigneeOf(conv.conversationId),
      { timeoutMs: 25_000, label: "assigned" },
    );
    expect(assigned).toBe(ALI);
  });

  test("the campaign draw BEATS the routing policy on the reply (the race)", async () => {
    // Auto-assign-on-reopen is ON and the default policy says Omar. The
    // campaign drew Sara. Both react to the same inbound with no ordering
    // guarantee — the campaign must win either way.
    await setSettings({ autoAssignOnReopen: true, autoAssignOnNewConversation: true });
    await configureDefault({ strategy: "fixed", fixedUserId: OMAR });

    const conv = await makeConversation({ tag: "camp_race" });
    const broadcast = await db().broadcast.create({
      data: {
        workspaceId: META_TEST_TEAM_ID,
        status: "completed",
        kind: "template",
        targetMode: "contact",
        channel: "whatsapp",
        templateName: `${PREFIX}race`,
        templateLanguage: "en",
        templateCategory: "MARKETING",
        variables: { body: [] },
        audienceMode: "all",
        totalCount: 1,
        assignmentMode: "fixed",
        assignmentUserId: SARA,
        assignmentTrigger: "on_reply",
      },
      select: { id: true },
    });
    await db().broadcastRecipient.create({
      data: {
        broadcastId: broadcast.id,
        contactId: conv.contactId,
        conversationId: conv.conversationId,
        assignedUserId: SARA,
        status: "sent",
        deliveryState: "delivered",
        externalId: `wamid.${PREFIX}race.${Date.now()}`,
        sentAt: new Date(Date.now() - 60_000),
      },
    });

    await inbound(conv.digits, "tell me more");

    const assigned = await pollUntil(
      async () => assigneeOf(conv.conversationId),
      { timeoutMs: 25_000, label: "assigned" },
    );
    expect(assigned).toBe(SARA);

    await setSettings({ autoAssignOnReopen: false, autoAssignOnNewConversation: false });
  });
});

// ==========================================================================
// 7. Deactivated members
// ==========================================================================

test.describe("deactivated members", () => {
  test("a deactivated member is never picked", async () => {
    const leaver = await makeUser("leaver");
    await configureDefault({
      strategy: "least_busy",
      eligibility: "any_active",
      includeAllMembers: false,
      defaultMaxOpen: null,
      overflow: "leave_unassigned",
      fallbackUserId: null,
      members: [
        { userId: leaver, weight: 1, enabled: true },
        { userId: OMAR, weight: 1, enabled: true },
      ],
    });
    await db().user.update({
      where: { id: leaver },
      data: { deactivatedAt: new Date() },
    });

    const conv = await makeConversation({ tag: "afterleave" });
    await api(`/conversations/${conv.conversationId}/assign`, {
      method: "POST",
      body: JSON.stringify({ autoAssign: true }),
    });
    expect(await assigneeOf(conv.conversationId)).toBe(OMAR);
  });

  test("a FIXED policy pointing at a departed member falls through to overflow", async () => {
    const leaver = await makeUser("leaver2");
    await configureDefault({
      strategy: "fixed",
      fixedUserId: leaver,
      overflow: "fallback_user",
      fallbackUserId: SARA,
    });
    await db().user.update({
      where: { id: leaver },
      data: { deactivatedAt: new Date() },
    });

    const conv = await makeConversation({ tag: "fixedgone" });
    await api(`/conversations/${conv.conversationId}/assign`, {
      method: "POST",
      body: JSON.stringify({ autoAssign: true }),
    });
    // Never a ghost id, never silently unowned when a fallback exists.
    expect(await assigneeOf(conv.conversationId)).toBe(SARA);
  });
});

// ==========================================================================
// 8. Eligibility against real availability
// ==========================================================================

test.describe("eligibility", () => {
  test("available_only skips a teammate who marked themselves away", async () => {
    await configureDefault({
      strategy: "least_busy",
      eligibility: "available_only",
      includeAllMembers: false,
      defaultMaxOpen: null,
      overflow: "leave_unassigned",
      fallbackUserId: null,
      members: [
        { userId: ALI, weight: 1, enabled: true },
        { userId: SARA, weight: 1, enabled: true },
      ],
    });

    // Drive the REAL availability route, not a DB poke — this is the same
    // column working hours writes, so it proves shift-awareness for free.
    const away = await api(`/users/${ALI}/availability`, {
      method: "PATCH",
      body: JSON.stringify({ status: "away" }),
    });
    expect(away.ok).toBeTruthy();

    const conv = await makeConversation({ tag: "away" });
    await api(`/conversations/${conv.conversationId}/assign`, {
      method: "POST",
      body: JSON.stringify({ autoAssign: true }),
    });
    expect(await assigneeOf(conv.conversationId)).toBe(SARA);

    await api(`/users/${ALI}/availability`, {
      method: "PATCH",
      body: JSON.stringify({ status: "available" }),
    });
  });

  test("online_only leaves it in the triage queue when nobody is connected", async () => {
    // The meta harness has no socket clients, so nobody is "online" — but the
    // API process DOES have a presence service, so this is the real strict path
    // rather than the presence-unknown fail-open.
    await configureDefault({
      strategy: "least_busy",
      eligibility: "online_only",
      includeAllMembers: false,
      overflow: "leave_unassigned",
      fallbackUserId: null,
      members: [{ userId: OMAR, weight: 1, enabled: true }],
    });
    const conv = await makeConversation({ tag: "nooneonline" });
    await api(`/conversations/${conv.conversationId}/assign`, {
      method: "POST",
      body: JSON.stringify({ autoAssign: true }),
    });
    expect(await assigneeOf(conv.conversationId)).toBeNull();
  });

  test("online_first still lands somewhere when nobody is connected", async () => {
    await configureDefault({
      strategy: "least_busy",
      eligibility: "online_first",
      includeAllMembers: false,
      overflow: "leave_unassigned",
      fallbackUserId: null,
      members: [{ userId: OMAR, weight: 1, enabled: true }],
    });
    const conv = await makeConversation({ tag: "onlinefirst" });
    await api(`/conversations/${conv.conversationId}/assign`, {
      method: "POST",
      body: JSON.stringify({ autoAssign: true }),
    });
    expect(await assigneeOf(conv.conversationId)).toBe(OMAR);
  });
});
