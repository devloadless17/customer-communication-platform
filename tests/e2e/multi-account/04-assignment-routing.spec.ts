/**
 * ROUTING BY ACCOUNT, end to end through real ingest.
 *
 * The unit spec (`apps/api/test/assignment-account-routing.spec.ts`) pins the
 * matcher. This proves the whole chain actually carries the account: an inbound
 * webhook on one number → the conversation's `channelConnectionId` → the
 * assignment context → the rule → an assignee. Every link is individually
 * plausible and only works together, and the middle one is invisible to a unit
 * test because it is built by a database read.
 */
import { expect, test } from "@playwright/test";

import { db } from "../_helpers/db";
import { META_API_BASE, postMetaWebhook, resetMock } from "../_helpers/meta";
import {
  MA,
  MA_CONN,
  MA_TEAM_ID,
  clearMultiAccountData,
  seedMultiAccountTeam,
  waInboundTo,
} from "../_helpers/multi-account";

test.describe.configure({ mode: "serial" });

const SALES_USER = `${MA_TEAM_ID}_sales_agent`;
const SUPPORT_USER = `${MA_TEAM_ID}_support_agent`;

test.beforeAll(async () => {
  const { apiToken } = await seedMultiAccountTeam();
  const d = db();
  // One clean slate for the whole file — see the beforeEach note for why this
  // must not run between tests.
  await clearMultiAccountData();

  // Two agents, one per line.
  for (const [id, name] of [
    [SALES_USER, "MA Sales Agent"],
    [SUPPORT_USER, "MA Support Agent"],
  ] as const) {
    await d.user.upsert({
      where: { id },
      create: {
        id,
        organizationId: `${MA_TEAM_ID}_org`,
        orgRole: "member",
        name,
        email: `${id}@loadless.test`,
        emailVerified: true,
      },
      update: {},
    });
    await d.workspaceMember.upsert({
      where: { userId_workspaceId: { userId: id, workspaceId: MA_TEAM_ID } },
      create: { userId: id, workspaceId: MA_TEAM_ID, role: "agent" },
      update: {},
    });
  }

  // Auto-assignment is OPT-IN per workspace (`autoAssignOnNewConversation`
  // defaults to false), so without this the rules never run at all and every
  // thread lands unassigned — which would look exactly like a broken clause.
  // Through the API, NOT a direct DB write. The assignment config is cached
  // in-process with a generation counter that only the write path bumps, so a
  // row updated behind its back is invisible: the subscriber kept reading the
  // `onNew=false` it had cached during the earlier specs, and every thread
  // landed unassigned. Using the real endpoint invalidates it the way
  // production does — and exercises the endpoint besides.
  const settingsRes = await fetch(
    `${META_API_BASE}/api/external/v1/assignment/settings`,
    {
      method: "PATCH",
      headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        autoAssignOnNewConversation: true,
        // No AI is configured here, but be explicit: this suite is about
        // account routing, not the AI-first posture.
        skipWhenAiHandling: false,
      }),
    },
  );
  expect(settingsRes.status, await settingsRes.text()).toBeLessThan(400);

  // An AssignmentRule routes into a POLICY; the policy owns the agent pool.
  // So "Sales line → sales agent" is a rule whose only condition is the account,
  // pointing at a policy whose squad is that one agent. Cleared and rebuilt so a
  // re-run is deterministic rather than accumulating rules.
  const makePool = async (name: string, userId: string, isDefault: boolean) => {
    const policy = await d.team.create({
      data: {
        workspaceId: MA_TEAM_ID,
        name,
        isDefault,
        strategy: "round_robin",
        // An explicit squad of one: with includeAllMembers the pool would be
        // every member and both policies would resolve to the same person, so
        // the test would pass without the account clause doing anything.
        includeAllMembers: false,
      },
      select: { id: true },
    });
    await d.teamMember.create({
      data: { workspaceId: MA_TEAM_ID, policyId: policy.id, userId, enabled: true },
    });
    return policy.id;
  };

  const salesPolicyId = await makePool("MA Sales pool", SALES_USER, true);
  const supportPolicyId = await makePool("MA Support pool", SUPPORT_USER, false);

  // Two rules that differ ONLY by account — the exact thing that was
  // unexpressible before, since both are "whatsapp".
  await d.assignmentRule.create({
    data: {
      workspaceId: MA_TEAM_ID,
      policyId: salesPolicyId,
      name: "Sales line → sales pool",
      position: 0,
      enabled: true,
      conditions: { channelAccountIds: [MA_CONN.whatsappA] },
    },
  });
  await d.assignmentRule.create({
    data: {
      workspaceId: MA_TEAM_ID,
      policyId: supportPolicyId,
      name: "Support line → support pool",
      position: 1,
      enabled: true,
      conditions: { channelAccountIds: [MA_CONN.whatsappB] },
    },
  });
});

test.beforeEach(async () => {
  await resetMock();
  // Deliberately NO clearMultiAccountData() here.
  //
  // Assignment runs DETACHED from the webhook's HTTP response (the event bus
  // dispatches it after the 200), so wiping conversations at the start of the
  // next test deletes rows the previous test's assignment is still writing to.
  // The API log shows it exactly: `skipped=not_found reason=picked` — a
  // candidate was chosen, then the conversation vanished underneath it. That is
  // a harness race, not a product failure, and it made this spec pass alone and
  // fail in the suite.
  //
  // Every test here uses its own phone number, so there is nothing to collide
  // with; the workspace-level wipe happens once in beforeAll instead.
});

/** Send an inbound to one of the two numbers and read back the assignee. */
async function inboundAndAssignee(o: {
  account: "a" | "b";
  from: string;
  mid: string;
}): Promise<string | null> {
  const side = o.account === "a" ? MA.whatsapp.a : MA.whatsapp.b;
  const res = await postMetaWebhook(
    MA_TEAM_ID,
    waInboundTo({
      phoneNumberId: side.account,
      wabaId: side.waba,
      from: o.from,
      mid: o.mid,
      text: "routing please",
    }),
  );
  expect(res.status, res.text).toBe(200);

  // Assignment runs off the domain event, detached from the HTTP response.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const conv = await db().conversation.findFirst({
      where: { workspaceId: MA_TEAM_ID, contact: { phoneNumber: o.from } },
      select: { assignedUserId: true },
    });
    if (conv?.assignedUserId) return conv.assignedUserId;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

test("an inbound on the SALES number routes to the sales agent", async () => {
  const assignee = await inboundAndAssignee({
    account: "a",
    from: "9614000001",
    mid: "wamid.ma.route.a1",
  });
  expect(assignee).toBe(SALES_USER);
  // The half that matters — the sibling rule did NOT also match.
  expect(assignee).not.toBe(SUPPORT_USER);
});

test("an inbound on the SUPPORT number routes to the support agent", async () => {
  const assignee = await inboundAndAssignee({
    account: "b",
    from: "9614000002",
    mid: "wamid.ma.route.b1",
  });
  expect(assignee).toBe(SUPPORT_USER);
  expect(assignee).not.toBe(SALES_USER);
});

test("both numbers route independently in the same workspace", async () => {
  // Interleaved, because a rule list evaluated in order could otherwise appear
  // correct simply by always matching the first rule.
  const first = await inboundAndAssignee({
    account: "b",
    from: "9614000003",
    mid: "wamid.ma.route.b2",
  });
  const second = await inboundAndAssignee({
    account: "a",
    from: "9614000004",
    mid: "wamid.ma.route.a2",
  });
  expect(first).toBe(SUPPORT_USER);
  expect(second).toBe(SALES_USER);
});
