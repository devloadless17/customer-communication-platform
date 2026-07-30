/**
 * App-level webhook → workspace resolution.
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
 *
 *   pnpm --filter @ccp/api exec vitest run test/app-level-webhook.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { seedWabaAccount } from "./_waba";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setSharedDb } from "@/lib/db";
import { resolveAppLevelWorkspace } from "@/lib/providers/app-level-webhook";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `alw${Date.now().toString().slice(-8)}`;
const WABA = `${S}_waba`;
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

describe("WhatsApp resolution", () => {
  it("resolves entry[].id read as a WABA id", async () => {
    const out = await resolveAppLevelWorkspace(
      "whatsapp",
      waEnvelope(WABA, {
        field: "message_template_status_update",
        value: { message_template_name: "promo", event: "APPROVED" },
      }),
    );
    expect(out).toEqual({ kind: "ok", workspaceId: wsA, via: "waba_id" });
  });

  it("prefers value.waba_info.waba_id — the PARTNER_ADDED shape", async () => {
    // Note `entry[].id` here is the BUSINESS PORTFOLIO id, exactly as Meta sends
    // it for `account_update`. Resolving off `entry[].id` alone would land on the
    // portfolio arm (or miss); the nested WABA hint is the specific answer.
    const out = await resolveAppLevelWorkspace("whatsapp", {
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
    expect(out).toEqual({ kind: "ok", workspaceId: wsA, via: "waba_info" });
  });

  it("falls back to entry[].id as a portfolio id when no WABA matches", async () => {
    const out = await resolveAppLevelWorkspace(
      "whatsapp",
      waEnvelope(PORTFOLIO, { field: "account_update", value: { event: "VERIFIED_ACCOUNT" } }),
    );
    expect(out).toEqual({ kind: "ok", workspaceId: wsA, via: "portfolio_id" });
  });

  it("DROPS rather than picks when a portfolio id maps to two workspaces", async () => {
    const out = await resolveAppLevelWorkspace(
      "whatsapp",
      waEnvelope(SHARED_PORTFOLIO, {
        field: "account_update",
        value: { event: "VERIFIED_ACCOUNT" },
      }),
    );
    expect(out.kind).toBe("ambiguous");
  });

  it("resolves to nothing for an id we do not hold", async () => {
    const out = await resolveAppLevelWorkspace(
      "whatsapp",
      waEnvelope(`${S}_someone_else`, { field: "account_alerts", value: {} }),
    );
    expect(out).toEqual({ kind: "none" });
  });

  it("resolves to nothing for a payload naming no ids at all", async () => {
    const out = await resolveAppLevelWorkspace("whatsapp", {
      object: "whatsapp_business_account",
      entry: [],
    });
    expect(out).toEqual({ kind: "none" });
  });
});

describe("social resolution", () => {
  it("resolves a Page id to its workspace", async () => {
    const out = await resolveAppLevelWorkspace("messenger", {
      object: "page",
      entry: [{ id: PAGE, time: 1, messaging: [] }],
    });
    expect(out).toEqual({ kind: "ok", workspaceId: wsA, via: "account_id" });
  });

  it("does not cross channels — an IG payload naming a Page id resolves to nothing", async () => {
    const out = await resolveAppLevelWorkspace("instagram", {
      object: "instagram",
      entry: [{ id: PAGE, time: 1, messaging: [] }],
    });
    expect(out).toEqual({ kind: "none" });
  });
});
