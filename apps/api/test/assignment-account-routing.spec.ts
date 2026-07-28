/**
 * Assignment rules can route by ACCOUNT, not just by channel.
 *
 * "Chats arriving on the Sales number go to the Sales team" is the single most
 * requested multi-account routing rule, and it was unexpressible:
 * `AssignmentRuleConditions` knew about `channels` — the medium — but nothing
 * about WHICH of the workspace's numbers/Pages on that medium a thread arrived
 * on. A workspace running Sales and Support on two WhatsApp numbers could only
 * say "WhatsApp", which matches both.
 *
 * The clause FAILS CLOSED, exactly like `channels`: a rule keyed to one account
 * must never fire on a thread whose account the caller couldn't see. That is
 * the direction that matters — a rule that silently widens to every number is
 * how a Support chat ends up in the Sales queue.
 *
 *   pnpm --filter @ccp/api exec vitest run test/assignment-account-routing.spec.ts
 */
import { describe, expect, it } from "vitest";

import { matchesConditions, parseConditions } from "@/lib/assignment/rules";
import type { AssignmentContext } from "@ccp/shared/assignment/types";

const SALES = "conn_sales";
const SUPPORT = "conn_support";

/** A minimal inbound context, overridable per case. */
function ctx(over: Partial<AssignmentContext> = {}): AssignmentContext {
  return {
    source: "inbound",
    channel: "whatsapp",
    channelAccountId: SALES,
    tagIds: [],
    stageId: null,
    ...over,
  };
}

describe("parseConditions", () => {
  it("accepts channelAccountIds from the stored JSON", () => {
    const parsed = parseConditions({ channelAccountIds: [SALES, SUPPORT] });
    expect(parsed.channelAccountIds).toEqual([SALES, SUPPORT]);
  });

  it("drops an empty or malformed list rather than storing a dead clause", () => {
    // An empty array would read as "no account matches" and silently disable
    // the rule; absent means "any account", which is what the UI means by it.
    expect(parseConditions({ channelAccountIds: [] }).channelAccountIds).toBeUndefined();
    expect(
      parseConditions({ channelAccountIds: [1, null, ""] as unknown as string[] })
        .channelAccountIds,
    ).toBeUndefined();
  });
});

describe("matchesConditions — account clause", () => {
  it("MATCHES a thread on the named account", () => {
    expect(matchesConditions({ channelAccountIds: [SALES] }, ctx())).toBe(true);
  });

  it("does NOT match a thread on the sibling account", () => {
    // The whole point: this is what made "Sales-number chats to the Sales
    // queue" impossible to express.
    expect(
      matchesConditions({ channelAccountIds: [SALES] }, ctx({ channelAccountId: SUPPORT })),
    ).toBe(false);
  });

  it("matches any of several named accounts", () => {
    expect(
      matchesConditions({ channelAccountIds: [SALES, SUPPORT] }, ctx({ channelAccountId: SUPPORT })),
    ).toBe(true);
  });

  it("FAILS CLOSED when the context has no account", () => {
    // A thread whose account was disconnected (`onDelete: SetNull`) must not
    // suddenly satisfy every account-scoped rule.
    expect(
      matchesConditions({ channelAccountIds: [SALES] }, ctx({ channelAccountId: null })),
    ).toBe(false);
    expect(
      matchesConditions({ channelAccountIds: [SALES] }, ctx({ channelAccountId: undefined })),
    ).toBe(false);
  });

  it("no clause = any account (the catch-all rule keeps working)", () => {
    expect(matchesConditions({}, ctx({ channelAccountId: SUPPORT }))).toBe(true);
    expect(matchesConditions({}, ctx({ channelAccountId: null }))).toBe(true);
  });

  it("ANDs with the channel clause instead of replacing it", () => {
    const conditions = { channels: ["whatsapp" as const], channelAccountIds: [SALES] };
    expect(matchesConditions(conditions, ctx())).toBe(true);
    // Right account, wrong channel — both must hold.
    expect(matchesConditions(conditions, ctx({ channel: "messenger" }))).toBe(false);
    // Right channel, wrong account.
    expect(matchesConditions(conditions, ctx({ channelAccountId: SUPPORT }))).toBe(false);
  });

  it("ANDs with a tag clause too", () => {
    const conditions = { channelAccountIds: [SALES], tagIds: ["tag_vip"] };
    expect(matchesConditions(conditions, ctx({ tagIds: ["tag_vip"] }))).toBe(true);
    expect(matchesConditions(conditions, ctx({ tagIds: ["tag_other"] }))).toBe(false);
  });
});
