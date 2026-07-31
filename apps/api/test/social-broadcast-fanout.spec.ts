/**
 * SOCIAL BROADCAST FAN-OUT — one campaign, every social customer, each delivered
 * through the account that issued their id.
 *
 * Meta: "A person is assigned a unique page-scoped ID (PSID) for each Facebook
 * Page they start a conversation with." An Instagram IGSID is scoped to the IG
 * account the same way. So the sending account is a per-RECIPIENT fact on both
 * social channels — and a campaign-level choice on WhatsApp, where a phone number
 * is not account-scoped.
 *
 *   pnpm --filter @ccp/api exec vitest run test/social-broadcast-fanout.spec.ts
 */
import { describe, expect, it, vi } from "vitest";

import { isAccountScopedIdentity } from "@ccp/shared/providers/capabilities";
import { isSocialFanOut } from "@/lib/broadcasts/social-account-router";

describe("which channels fan out", () => {
  it("is exactly the account-scoped-identity channels", () => {
    // The table this is all built on:
    //   messenger  PSID   → one Page          → fan out
    //   instagram  IGSID  → one IG account    → fan out
    //   whatsapp   phone  → not account-scoped → do NOT fan out
    expect(isAccountScopedIdentity("messenger")).toBe(true);
    expect(isAccountScopedIdentity("instagram")).toBe(true);
    expect(isAccountScopedIdentity("whatsapp")).toBe(false);
  });

  it("fans out a social campaign only when no account was pinned", () => {
    // Pinning an account is still a legitimate campaign ("message the Sales
    // Page's customers") and must keep today's single-account behaviour.
    expect(isSocialFanOut("messenger", null)).toBe(true);
    expect(isSocialFanOut("instagram", null)).toBe(true);
    expect(isSocialFanOut("messenger", "conn_1")).toBe(false);
  });

  it("NEVER fans out WhatsApp, even with no account pinned", () => {
    // Not an oversight. A WhatsApp broadcast addresses a phone number that ANY
    // of the business's numbers can message, so which number sends is a business
    // choice the composer already exposes. Fanning it out silently would change
    // who the customer sees the message from for no forced reason.
    expect(isSocialFanOut("whatsapp", null)).toBe(false);
  });
});

describe("account router", () => {
  const makeRouter = async (getSendConfig: (ws: string, id: string | null) => Promise<unknown>) => {
    vi.resetModules();
    vi.doMock("@/lib/providers", () => ({
      getProviderBinding: () => ({ provider: { name: "messenger" }, getSendConfig }),
    }));
    const mod = await import("@/lib/broadcasts/social-account-router");
    return mod.createAccountRouter("ws_1", "messenger");
  };

  it("keys the rate bucket on the PAGE, so two Pages don't throttle each other", async () => {
    const router = await makeRouter(async (_ws, id) => ({ pageId: `page_${id}` }));
    const a = await router.resolve("conn_a");
    const b = await router.resolve("conn_b");
    // Meta's ceilings are per Page. A shared bucket would make two Pages
    // throttle each other; no bucket would let their sum exceed each one's limit.
    expect(a?.rateKey).toBe("page_conn_a");
    expect(b?.rateKey).toBe("page_conn_b");
    vi.doUnmock("@/lib/providers");
    vi.resetModules();
  });

  it("resolves each account ONCE across a long run", async () => {
    const getSendConfig = vi.fn(async () => ({ pageId: "page_1" }));
    const router = await makeRouter(getSendConfig);
    for (let i = 0; i < 50; i++) await router.resolve("conn_a");
    // A 100k-recipient run must not re-resolve credentials per recipient.
    expect(getSendConfig).toHaveBeenCalledTimes(1);
    vi.doUnmock("@/lib/providers");
    vi.resetModules();
  });

  it("caches a DISCONNECTED account as known-bad instead of retrying it forever", async () => {
    vi.resetModules();
    const { ProviderNotConfiguredError } = await import("@/lib/providers/config");
    const getSendConfig = vi.fn(async () => {
      throw new ProviderNotConfiguredError("ws_1", ["not-connected"], "messenger");
    });
    vi.doMock("@/lib/providers", () => ({
      getProviderBinding: () => ({ provider: { name: "messenger" }, getSendConfig }),
    }));
    const { createAccountRouter } = await import("@/lib/broadcasts/social-account-router");
    const router = createAccountRouter("ws_1", "messenger");

    expect(await router.resolve("conn_dead")).toBeNull();
    expect(await router.resolve("conn_dead")).toBeNull();
    // Null is a RESOLVED answer, not a miss — otherwise one dead Page costs a
    // Graph round trip per recipient for the length of the run.
    expect(getSendConfig).toHaveBeenCalledTimes(1);
    // …and it is reported as unusable rather than counted as touched.
    expect(router.resolvedAccountIds()).not.toContain("conn_dead");

    vi.doUnmock("@/lib/providers");
    vi.resetModules();
  });

  it("propagates a NON-credential error rather than swallowing it as 'disconnected'", async () => {
    // A network blip or a bug must not be reported to the operator as "this Page
    // is disconnected" — that sends them to reconnect something that is fine.
    const router = await makeRouter(async () => {
      throw new Error("boom");
    });
    await expect(router.resolve("conn_a")).rejects.toThrow("boom");
    vi.doUnmock("@/lib/providers");
    vi.resetModules();
  });
});

describe("a fan-out run must not be parked by the ambiguous default account", () => {
  it("is the whole reason fan-out skips the run-level config resolve", () => {
    // A fan-out campaign pins NO account. `getSendConfig(null)` on a workspace
    // with two Pages is deliberately AMBIGUOUS (ACCOUNT_UNRESOLVED) — the guard
    // that stops a reply going out from a Page the customer never messaged.
    //
    // The runner's start-up block reads that as "not connected" and parks the
    // whole campaign as `paused`. So a fan-out run must never take that path:
    // it sets `config: null` and lets each recipient resolve its own account.
    // This assertion exists so nobody "simplifies" the two branches back into
    // one and silently reintroduces a campaign that parks itself on launch.
    expect(isSocialFanOut("messenger", null)).toBe(true);
    expect(isSocialFanOut("messenger", "conn_1")).toBe(false);
  });
});

describe("per-account campaign analytics", () => {
  const row = (id: string | null, targeted: number, delivered = 0, read = 0, failed = 0) => ({
    channelConnectionId: id,
    targeted: BigInt(targeted),
    delivered: BigInt(delivered),
    read: BigInt(read),
    failed: BigInt(failed),
  });

  it("returns NOTHING for a single-account campaign", async () => {
    const { summarizeByAccount } = await import("@/lib/broadcast-report");
    // A one-row "breakdown" restates the funnel. In a report whose job is to
    // explain a number, that is noise — and empty, not null: nothing was
    // unknown, there is simply one account.
    expect(summarizeByAccount([row("conn_a", 500, 480, 300)])).toEqual([]);
    expect(summarizeByAccount([])).toEqual([]);
  });

  it("orders multi-account rows biggest slice first", async () => {
    const { summarizeByAccount } = await import("@/lib/broadcast-report");
    const out = summarizeByAccount([
      row("conn_small", 10, 2, 1, 8),
      row("conn_big", 900, 880, 500),
      row("conn_mid", 100, 95, 40),
    ]);
    // The account that carried the campaign is what an operator looks at, and a
    // struggling small Page is easier to spot against it than buried in
    // insertion order — here `conn_small` failed 8 of 10 while the total still
    // reads healthy.
    expect(out.map((r) => r.channelConnectionId)).toEqual(["conn_big", "conn_mid", "conn_small"]);
    expect(out[2]).toMatchObject({ targeted: 10, failed: 8 });
  });

  it("converts Postgres bigints to numbers", async () => {
    const { summarizeByAccount } = await import("@/lib/broadcast-report");
    const out = summarizeByAccount([row("a", 2, 1, 1), row("b", 1)]);
    // `count(*)` comes back as BigInt; leaving it would JSON-serialize as a
    // string (or throw) and silently break every consumer of the report.
    for (const r of out) {
      expect(typeof r.targeted).toBe("number");
      expect(typeof r.delivered).toBe("number");
    }
  });

  it("keeps a null account (a legacy pre-fan-out row) rather than dropping it", async () => {
    const { summarizeByAccount } = await import("@/lib/broadcast-report");
    const out = summarizeByAccount([row(null, 50), row("conn_a", 10)]);
    // Rows materialized before the column existed carry null. Dropping them
    // would make the breakdown not sum to the funnel, which is worse than an
    // unlabelled slice.
    expect(out.map((r) => r.channelConnectionId)).toEqual([null, "conn_a"]);
  });
});
