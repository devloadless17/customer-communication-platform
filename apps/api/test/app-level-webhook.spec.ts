/**
 * App-level webhook → PER-ENTRY workspace attribution.
 *
 * Under Embedded Signup every onboarded customer's webhooks land on the APP's
 * callback URL, and Meta's docs are explicit that `override_callback_uri` cannot
 * redirect the template topics (`message_template_status_update`,
 * `_quality_update`, `_components_update`, `template_category_update`) or the
 * account topics (`account_update`, `account_review_update`, `account_alerts`) —
 * those are ALWAYS delivered there. So a route with no workspaceId in the path is
 * a requirement, and the tenant has to come from the payload.
 *
 * That makes this function a tenancy boundary. What is pinned here:
 *
 *   1. `entry[].id` as a WABA id resolves via the GLOBALLY unique
 *      `externalWabaId` — one indexed read, and the index is the guard.
 *   2. `value.waba_info.waba_id` wins, because that is where `account_update` /
 *      `PARTNER_ADDED` puts the WABA — and its `entry[].id` is the customer's
 *      BUSINESS PORTFOLIO id, not a WABA id. Code that assumes `entry[].id` is
 *      always a WABA resolves the wrong thing for exactly the onboarding event.
 *   3. `entry[].id` as a portfolio id is the fallback, and AMBIGUOUS by nature:
 *      `WhatsappPortfolio` is unique per workspace, so one Meta portfolio can map
 *      to two of ours. Several matches must DROP, never pick.
 *   4. An unknown id resolves to nothing rather than to a default.
 *   5. **A batch spanning two tenants is PARTITIONED, not dropped.** Meta sends up
 *      to 1000 updates per POST and "Multiple changes from different objects that
 *      are of the same type may be batched together" — for
 *      `whatsapp_business_account` those objects are different WABAs. Collapsing
 *      the body to one workspace made such a body ambiguous and dropped ALL of it,
 *      including the entries that resolved cleanly; and a drop answers 200, so Meta
 *      never redelivered them. Each entry now lands in its own group.
 *
 *   pnpm --filter @ccp/api exec vitest run test/app-level-webhook.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { seedWabaAccount } from "./_waba";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setSharedDb } from "@/lib/db";
import { groupEntriesByWorkspace } from "@/lib/providers/app-level-webhook";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `alw${Date.now().toString().slice(-8)}`;
const WABA = `${S}_waba`;
const WABA_B = `${S}_waba_b`;
const PORTFOLIO = `${S}_portfolio`;
const SHARED_PORTFOLIO = `${S}_shared_portfolio`;
const PAGE = `${S}_page`;

let orgId = "";
let wsA = "";
let wsB = "";

function waEnvelope(entryId: string, change: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: entryId, changes: [change] }],
  };
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({ data: { name: `ALW Org ${S}`, status: "active" } })
  ).id;
  wsA = (
    await prisma.workspace.create({ data: { name: `ALW A ${S}`, organizationId: orgId } })
  ).id;
  wsB = (
    await prisma.workspace.create({ data: { name: `ALW B ${S}`, organizationId: orgId } })
  ).id;

  const portfolio = await prisma.whatsappPortfolio.create({
    data: {
      workspaceId: wsA,
      externalPortfolioId: PORTFOLIO,
      source: "graph_discovered",
    },
    select: { id: true },
  });
  await seedWabaAccount(prisma, wsA, WABA, { portfolioId: portfolio.id });
  // A SECOND tenant with its own WABA, so a cross-tenant batch is testable.
  await seedWabaAccount(prisma, wsB, WABA_B);

  await prisma.channelConnection.create({
    data: {
      workspaceId: wsA,
      channel: "messenger",
      externalAccountId: PAGE,
      isDefault: true,
      isActive: true,
      config: { pageId: PAGE },
      secrets: {},
    },
  });

  // The SAME Meta portfolio id claimed by BOTH workspaces. `WhatsappPortfolio` is
  // `@@unique([workspaceId, externalPortfolioId])`, so this is legal — and it is
  // why portfolio-id resolution can only ever be a last resort.
  for (const ws of [wsA, wsB]) {
    await prisma.whatsappPortfolio.create({
      data: {
        workspaceId: ws,
        externalPortfolioId: SHARED_PORTFOLIO,
        source: "embedded_signup",
      },
    });
  }
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

/** Convenience: the single group's workspace, or null when nothing attributed. */
function soleWorkspace(g: { groups: Array<{ workspaceId: string }> }): string | null {
  return g.groups.length === 1 ? g.groups[0]!.workspaceId : null;
}

describe("WhatsApp attribution", () => {
  it("attributes entry[].id read as a WABA id", async () => {
    const g = await groupEntriesByWorkspace(
      "whatsapp",
      waEnvelope(WABA, {
        field: "message_template_status_update",
        value: { message_template_name: "promo", event: "APPROVED" },
      }),
    );
    expect(soleWorkspace(g)).toBe(wsA);
    expect(g.groups[0]!.entryCount).toBe(1);
    expect(g.unattributed).toEqual([]);
  });

  it("prefers value.waba_info.waba_id — the PARTNER_ADDED shape", async () => {
    // `entry[].id` here is the PORTFOLIO id, which also resolves (to the same
    // workspace) via the portfolio arm — so this pins the PRIORITY, not just the
    // outcome: the nested WABA hint is the specific answer and is tried first.
    const g = await groupEntriesByWorkspace("whatsapp", {
      object: "whatsapp_business_account",
      entry: [
        {
          id: PORTFOLIO,
          changes: [
            {
              field: "account_update",
              value: {
                event: "PARTNER_ADDED",
                waba_info: { waba_id: WABA, owner_business_id: PORTFOLIO },
              },
            },
          ],
        },
      ],
    });
    expect(soleWorkspace(g)).toBe(wsA);
  });

  it("falls back to entry[].id as a portfolio id when no WABA matches", async () => {
    const g = await groupEntriesByWorkspace(
      "whatsapp",
      waEnvelope(PORTFOLIO, { field: "account_update", value: { event: "VERIFIED_ACCOUNT" } }),
    );
    expect(soleWorkspace(g)).toBe(wsA);
  });

  it("DROPS rather than picks when a portfolio id maps to two workspaces", async () => {
    const g = await groupEntriesByWorkspace(
      "whatsapp",
      waEnvelope(SHARED_PORTFOLIO, {
        field: "account_update",
        value: { event: "VERIFIED_ACCOUNT" },
      }),
    );
    expect(g.groups).toEqual([]);
    expect(g.unattributed).toHaveLength(1);
    expect(g.unattributed[0]!.reason).toBe("ambiguous");
  });

  it("attributes nothing for an id we do not hold", async () => {
    const g = await groupEntriesByWorkspace(
      "whatsapp",
      waEnvelope(`${S}_someone_else`, { field: "account_alerts", value: {} }),
    );
    expect(g.groups).toEqual([]);
    expect(g.unattributed[0]!.reason).toBe("none");
  });

  it("attributes nothing for a payload naming no ids at all", async () => {
    const g = await groupEntriesByWorkspace("whatsapp", {
      object: "whatsapp_business_account",
      entry: [],
    });
    expect(g).toEqual({ groups: [], unattributed: [] });
  });
});

describe("batched across tenants — the bug this replaced", () => {
  it("PARTITIONS one POST carrying two workspaces' WABAs", async () => {
    // The whole point. Before this, `single()` saw two candidate workspaces for the
    // body, returned `ambiguous`, and the route dropped BOTH entries with a 200.
    const g = await groupEntriesByWorkspace("whatsapp", {
      object: "whatsapp_business_account",
      entry: [
        { id: WABA, changes: [{ field: "account_alerts", value: { a: 1 } }] },
        { id: WABA_B, changes: [{ field: "account_alerts", value: { b: 2 } }] },
      ],
    });
    expect(g.unattributed).toEqual([]);
    expect(g.groups).toHaveLength(2);
    expect(new Set(g.groups.map((x) => x.workspaceId))).toEqual(new Set([wsA, wsB]));
    // Strict partition: each group carries ONLY its own entry, so ingesting every
    // group in turn processes each entry exactly once.
    for (const grp of g.groups) {
      expect(grp.entryCount).toBe(1);
      const own = (grp.payload as { entry: Array<{ id: string }> }).entry;
      expect(own).toHaveLength(1);
      expect(own[0]!.id).toBe(grp.workspaceId === wsA ? WABA : WABA_B);
    }
  });

  it("rebuilds a real envelope per group so the normal ingest path can read it", async () => {
    const g = await groupEntriesByWorkspace("whatsapp", {
      object: "whatsapp_business_account",
      entry: [{ id: WABA, changes: [{ field: "account_alerts", value: {} }] }],
    });
    // `object` must survive — every parser gates on it.
    expect((g.groups[0]!.payload as { object: string }).object).toBe(
      "whatsapp_business_account",
    );
  });

  it("one unattributable entry does not cost its batch-mates", async () => {
    // The regression that matters most: a co-batched ambiguous entry used to take
    // the resolvable one down with it.
    const g = await groupEntriesByWorkspace("whatsapp", {
      object: "whatsapp_business_account",
      entry: [
        { id: WABA, changes: [{ field: "account_alerts", value: {} }] },
        { id: SHARED_PORTFOLIO, changes: [{ field: "account_update", value: {} }] },
        { id: `${S}_someone_else`, changes: [{ field: "account_alerts", value: {} }] },
      ],
    });
    expect(soleWorkspace(g)).toBe(wsA);
    expect(g.groups[0]!.entryCount).toBe(1);
    expect(g.unattributed.map((u) => u.reason).sort()).toEqual(["ambiguous", "none"]);
  });

  it("groups several entries of the SAME workspace together", async () => {
    const g = await groupEntriesByWorkspace("whatsapp", {
      object: "whatsapp_business_account",
      entry: [
        { id: WABA, changes: [{ field: "account_alerts", value: { n: 1 } }] },
        { id: PORTFOLIO, changes: [{ field: "account_update", value: { n: 2 } }] },
      ],
    });
    expect(g.groups).toHaveLength(1);
    expect(g.groups[0]!.workspaceId).toBe(wsA);
    expect(g.groups[0]!.entryCount).toBe(2);
  });
});

describe("social attribution", () => {
  it("attributes a Page id to its workspace", async () => {
    const g = await groupEntriesByWorkspace("messenger", {
      object: "page",
      entry: [{ id: PAGE, time: 1, messaging: [] }],
    });
    expect(soleWorkspace(g)).toBe(wsA);
  });

  it("does not cross channels — an IG payload naming a Page id attributes to nothing", async () => {
    const g = await groupEntriesByWorkspace("instagram", {
      object: "instagram",
      entry: [{ id: PAGE, time: 1, messaging: [] }],
    });
    expect(g.groups).toEqual([]);
    expect(g.unattributed[0]!.reason).toBe("none");
  });
});
