/**
 * REPORTS, per account.
 *
 * "How is the business doing" is the wrong question for a workspace running a
 * Sales line and a Support line: they are two operations sharing a medium, and
 * a blended first-response time hides one drowning behind the other. So every
 * panel of the report takes an `accountId`, and this file is the conformance
 * lens the multi-account matrix was missing — `reports` shipped as a whole new
 * domain after the matrix closed and had unit specs but no multi-account e2e.
 *
 * Every case asserts BOTH halves: the account's own volume is counted, AND the
 * sibling's is excluded. The second half is the one that matters — a filter
 * that silently widens looks exactly like a working filter, and here it would
 * quietly restore the blended number the feature exists to avoid.
 */
import { expect, test } from "@playwright/test";

import { db } from "../_helpers/db";
import { META_API_BASE, resetMock } from "../_helpers/meta";
import {
  MA_CONN,
  MA_TEAM_ID,
  clearMultiAccountData,
  seedBoundConversation,
  seedMultiAccountTeam,
} from "../_helpers/multi-account";

test.describe.configure({ mode: "serial" });

let apiToken = "";

test.beforeAll(async () => {
  ({ apiToken } = await seedMultiAccountTeam());
  await clearMultiAccountData();
});

test.beforeEach(async () => {
  await resetMock();
});

async function v1Get(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${META_API_BASE}/api/external/v1${path}`, {
    headers: { authorization: `Bearer ${apiToken}` },
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** A committed inbound on a thread bound to `accountId`. Written directly so
 *  the volume under test is exact — an ingest round-trip would also fire
 *  workflows and analytics, which is noise for a counting assertion. */
async function seedInbound(o: {
  accountId: string;
  phoneNumber: string;
  name: string;
  mid: string;
}): Promise<void> {
  const { conversationId } = await seedBoundConversation({
    channel: "whatsapp",
    channelConnectionId: o.accountId,
    name: o.name,
    phoneNumber: o.phoneNumber,
  });
  await db().message.create({
    data: {
      workspaceId: MA_TEAM_ID,
      conversationId,
      externalId: o.mid,
      body: `report probe ${o.mid}`,
      direction: "in",
      channel: "whatsapp",
      channelConnectionId: o.accountId,
    },
  });
}

const RANGE = (() => {
  const to = new Date(Date.now() + 60 * 60 * 1000);
  const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return `from=${from.toISOString()}&to=${to.toISOString()}`;
})();

test("the report NARROWS to one account and excludes the sibling's volume", async () => {
  await seedInbound({
    accountId: MA_CONN.whatsappA,
    phoneNumber: "9618000001",
    name: "MA Report Sales",
    mid: "wamid.ma.report.a1",
  });
  await seedInbound({
    accountId: MA_CONN.whatsappA,
    phoneNumber: "9618000002",
    name: "MA Report Sales 2",
    mid: "wamid.ma.report.a2",
  });
  await seedInbound({
    accountId: MA_CONN.whatsappB,
    phoneNumber: "9618000003",
    name: "MA Report Support",
    mid: "wamid.ma.report.b1",
  });

  const all = await v1Get(`/reports/overview?${RANGE}&tz=UTC`);
  expect(all.status, JSON.stringify(all.json)).toBe(200);

  const onlyA = await v1Get(`/reports/overview?${RANGE}&tz=UTC&accountId=${MA_CONN.whatsappA}`);
  expect(onlyA.status, JSON.stringify(onlyA.json)).toBe(200);
  const onlyB = await v1Get(`/reports/overview?${RANGE}&tz=UTC&accountId=${MA_CONN.whatsappB}`);
  expect(onlyB.status, JSON.stringify(onlyB.json)).toBe(200);

  const inboundOf = (r: any): number =>
    (r.volume?.daily ?? []).reduce((sum: number, d: any) => sum + (d.inbound ?? 0), 0);

  // POSITIVE — each account sees its own traffic.
  expect(inboundOf(onlyA.json)).toBeGreaterThanOrEqual(2);
  expect(inboundOf(onlyB.json)).toBeGreaterThanOrEqual(1);

  // NEGATIVE — and only its own. A widened filter would make the two halves
  // equal the whole, which is precisely the blended number this feature exists
  // to avoid.
  expect(inboundOf(onlyA.json)).toBeLessThan(inboundOf(all.json));
  expect(inboundOf(onlyB.json)).toBeLessThan(inboundOf(all.json));
  expect(inboundOf(onlyA.json) + inboundOf(onlyB.json)).toBeLessThanOrEqual(inboundOf(all.json));
});

test("conversations opened are attributed per account, not blended", async () => {
  const onlyA = await v1Get(`/reports/overview?${RANGE}&tz=UTC&accountId=${MA_CONN.whatsappA}`);
  const onlyB = await v1Get(`/reports/overview?${RANGE}&tz=UTC&accountId=${MA_CONN.whatsappB}`);
  const all = await v1Get(`/reports/overview?${RANGE}&tz=UTC`);

  const openedA = onlyA.json.volume?.conversationsOpened ?? 0;
  const openedB = onlyB.json.volume?.conversationsOpened ?? 0;
  const openedAll = all.json.volume?.conversationsOpened ?? 0;

  expect(openedA).toBeGreaterThan(0);
  expect(openedB).toBeGreaterThan(0);
  expect(openedA + openedB).toBeLessThanOrEqual(openedAll);
  // Neither account alone accounts for the whole workspace.
  expect(openedA).toBeLessThan(openedAll);

  // The `accounts` panel is the per-number breakdown an operator actually reads
  // ("which number did the work"). Unfiltered it must name BOTH; scoped it must
  // name only the one asked for — otherwise the breakdown silently re-blends.
  const namedIn = (r: any): string[] =>
    (r.accounts ?? []).map((a: any) => a.accountId).filter(Boolean);
  expect(namedIn(all.json)).toEqual(
    expect.arrayContaining([MA_CONN.whatsappA, MA_CONN.whatsappB]),
  );
  expect(namedIn(onlyA.json)).not.toContain(MA_CONN.whatsappB);
  expect(namedIn(onlyB.json)).not.toContain(MA_CONN.whatsappA);
});

test("an account id from ANOTHER workspace is refused, not silently empty", async () => {
  // The tenancy half. An unknown id returning an empty report reads as "the
  // Sales line did nothing", which is worse than an error — it is a wrong
  // answer that looks like a right one.
  const foreign = await db().channelConnection.findFirst({
    where: { workspaceId: { not: MA_TEAM_ID } },
    select: { id: true },
  });
  test.skip(!foreign, "no foreign connection in this database to probe with");

  const res = await v1Get(`/reports/overview?${RANGE}&tz=UTC&accountId=${foreign!.id}`);
  expect(res.status, JSON.stringify(res.json)).toBe(400);
  expect(JSON.stringify(res.json)).toContain("account");
});

test("a bogus account id is refused the same way", async () => {
  const res = await v1Get(`/reports/overview?${RANGE}&tz=UTC&accountId=does-not-exist`);
  expect(res.status, JSON.stringify(res.json)).toBe(400);
});
