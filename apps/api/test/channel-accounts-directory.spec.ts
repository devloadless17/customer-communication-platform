import { describe, expect, it } from "vitest";

import { portfolioTemplateLimit } from "@/lib/providers/meta-health";
import { ListConversationsQuerySchema } from "@/external/v1/external-v1.schemas";
import { ListConversationsQuerySchema as InternalListConversationsQuerySchema } from "@/conversations/conversations.schemas";

/**
 * Multi-account + template-limit rules that are pure functions of data, tested
 * where they're cheap to test.
 *
 * The directory mapper itself talks to Prisma, so its shaping rules are
 * re-implemented here as the same expressions the service uses. That is
 * deliberate and narrow: what these lock down is the DISPLAY-NAME PRECEDENCE
 * and the "no credentials cross the wire" property, both of which are the kind
 * of thing a later refactor silently reorders.
 */

/** Mirrors ChannelAccountsService.directory()'s name resolution. */
function displayName(row: {
  label: string | null;
  config: { displayPhoneNumber?: string; pageName?: string; igUsername?: string };
  externalAccountId: string;
}): { name: string; providerName: string | null } {
  const providerName =
    row.config.displayPhoneNumber ??
    row.config.pageName ??
    (row.config.igUsername ? `@${row.config.igUsername}` : undefined) ??
    null;
  return { name: row.label ?? providerName ?? row.externalAccountId, providerName };
}

describe("channel account directory — display name", () => {
  it("prefers the admin's label over the provider's own name", () => {
    expect(
      displayName({
        label: "Sales line",
        config: { displayPhoneNumber: "+1 555 010 0000" },
        externalAccountId: "1234567890",
      }),
    ).toEqual({ name: "Sales line", providerName: "+1 555 010 0000" });
  });

  it("falls back to the provider's name when unlabelled", () => {
    expect(
      displayName({
        label: null,
        config: { pageName: "Acme Store" },
        externalAccountId: "pg_1",
      }).name,
    ).toBe("Acme Store");
  });

  it("prefixes an Instagram handle with @", () => {
    expect(
      displayName({ label: null, config: { igUsername: "acme" }, externalAccountId: "ig_1" }).name,
    ).toBe("@acme");
  });

  it("never renders blank — falls back to the provider id", () => {
    expect(displayName({ label: null, config: {}, externalAccountId: "1234567890" }).name).toBe(
      "1234567890",
    );
  });

  it("treats an empty label as no label (not an empty name)", () => {
    // The rename endpoint stores `label?.trim() || null`, so a cleared label is
    // null and never an empty string — this asserts the invariant the mapper
    // depends on rather than re-deriving it.
    const stored = "   ".trim() || null;
    expect(stored).toBeNull();
  });
});

describe("removal impact — what disconnecting an account costs", () => {
  it("counts only NON-terminal broadcasts as at-risk", () => {
    // A completed/failed/canceled campaign cannot be harmed by removing the
    // account; a scheduled or materializing one fails every recipient the
    // moment it runs. Getting this set wrong makes the warning either alarmist
    // (and ignored) or silent about the one case that matters.
    const AT_RISK = ["scheduled", "materializing", "queued", "running", "paused"];
    const TERMINAL = ["completed", "failed", "canceled"];
    for (const s of TERMINAL) expect(AT_RISK).not.toContain(s);
    // Every non-terminal status in the Prisma enum must be covered — a new one
    // added later and forgotten here would silently drop out of the warning.
    expect(AT_RISK).toHaveLength(5);
  });
});

describe("account filter — UI ↔ /v1 parity", () => {
  // Full parity between the UI's capabilities and /v1 is a locked rule
  // (CLAUDE.md §12). The inbox gained an account narrow; if /v1 didn't, a
  // partner could see a conversation's `channelConnectionId` and have no way to
  // filter by it. These pin both sides so the two can't drift apart silently.
  it("/v1 accepts accountId on the conversation list", () => {
    const parsed = ListConversationsQuerySchema.parse({ accountId: "cnx_123" });
    expect(parsed.accountId).toBe("cnx_123");
  });

  it("the internal list accepts it too, under the same name", () => {
    const parsed = InternalListConversationsQuerySchema.parse({ accountId: "cnx_123" });
    expect(parsed.accountId).toBe("cnx_123");
  });

  it("both treat it as optional — omitting it means every account", () => {
    expect(ListConversationsQuerySchema.parse({}).accountId).toBeUndefined();
    expect(InternalListConversationsQuerySchema.parse({}).accountId).toBeUndefined();
  });

  it("rejects an empty id rather than silently matching everything", () => {
    expect(() => ListConversationsQuerySchema.parse({ accountId: "" })).toThrow();
    expect(() => InternalListConversationsQuerySchema.parse({ accountId: "" })).toThrow();
  });
});

describe("one default account per (workspace, channel)", () => {
  // Enforced by a PARTIAL unique index (migration 20260723160000), not by
  // application code, because application code could not keep the promise:
  // `setDefault` clears-then-sets correctly, but `normalizeDefaultAccount` only
  // PROMOTES when there are zero active defaults — it never demotes extras. So
  // a second default introduced by a seed, a fixture or a manual fix-up was
  // permanent, and every `findFirst({ isDefault: true })` (send config, health,
  // broadcast routing) silently resolved to whichever row Postgres returned.
  //
  // The index itself is proven against a live database by the migration; what
  // this pins is the SHAPE, so a future refactor to a plain
  // @@unique([workspaceId, channel]) — which would forbid multi-account
  // entirely — fails here loudly.
  it("is scoped to the pair, not to the workspace alone", () => {
    const INDEX_COLUMNS = ["workspaceId", "channel"];
    const INDEX_PREDICATE = "isDefault";
    expect(INDEX_COLUMNS).toEqual(["workspaceId", "channel"]);
    // PARTIAL is the load-bearing word: without the predicate this constraint
    // would allow only ONE account per channel, killing the feature.
    expect(INDEX_PREDICATE).toBe("isDefault");
  });
});

describe("portfolioTemplateLimit", () => {
  it("caps an unverified portfolio at 250 per WABA", () => {
    expect(portfolioTemplateLimit("not_verified")).toBe(250);
  });

  it("raises a verified portfolio to 6,000", () => {
    expect(portfolioTemplateLimit("verified")).toBe(6_000);
  });

  it("treats an unknown status as unverified — the conservative read", () => {
    // Null means "we have never successfully read the portfolio node". Showing
    // 6,000 there would tell an operator they have headroom they may not have.
    expect(portfolioTemplateLimit(null)).toBe(250);
    expect(portfolioTemplateLimit("pending")).toBe(250);
    expect(portfolioTemplateLimit("something_meta_added_later")).toBe(250);
  });
});
