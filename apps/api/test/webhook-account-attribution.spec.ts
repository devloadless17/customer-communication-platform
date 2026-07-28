/**
 * Account-level webhook attribution.
 *
 * Account-level WhatsApp webhooks (`phone_number_quality_update`,
 * `business_capability_update`, template lifecycle) carry no
 * `metadata.phone_number_id`, and the controller used to fall back to the
 * workspace DEFAULT connection — so in a two-number workspace, number B's RED
 * quality was written onto number A, and a template rejection on WABA B
 * flipped WABA A's same-named template (halting the wrong campaigns).
 *
 * These tests drive the REAL parse → ingest chain (no controller): the parser
 * stamps `entry[].id` (the WABA) + `display_phone_number` onto the events, and
 * ingest resolves the subject from those hints — or drops per-number fields
 * with a warn when nothing pins one connection.
 *
 *   pnpm --filter @ccp/api exec vitest run test/webhook-account-attribution.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { setSharedDb } from "@/lib/db";

// Ingest publishes `team.catalog_changed` after a template flip; the bus is
// irrelevant to what's under test, so stub publish alone.
vi.mock("@/lib/events/bus", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/events/bus")>();
  return { ...actual, publish: vi.fn(async () => undefined) };
});

import { metaProvider } from "@/lib/providers/meta";
import { ingestEvents } from "@/lib/providers/ingest";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `wa${Date.now().toString().slice(-8)}`;
const WABA_A = `${S}_waba_a`;
const WABA_B = `${S}_waba_b`;
const WABA_SHARED = `${S}_waba_shared`;

let orgId = "";
let workspaceId = "";
let connA = ""; // default; WABA_A; +1 555 010 0001
let connB = ""; // WABA_B; +1 555 010 0002
let portfolioA = "";
let portfolioB = "";
let portfolioShared = "";
let tplA = "";
let tplB = "";
let tplLegacy = "";

/** Wrap one change the way Meta delivers it. */
function webhook(entryId: string, field: string, value: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: entryId, changes: [{ field, value }] }],
  };
}

/** Parse with the real provider, ingest with NO batch account (the controller
 *  passes none for account-level payloads). */
async function deliver(payload: unknown) {
  const events = metaProvider.parseWebhook(payload);
  expect(events.length).toBeGreaterThan(0);
  await ingestEvents(workspaceId, "whatsapp", events, undefined);
}

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `WA Org ${S}`, status: "active" },
  });
  orgId = org.id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `WA WS ${S}`, organizationId: orgId } })
  ).id;

  const mkPortfolio = async (ext: string) =>
    (
      await prisma.whatsappPortfolio.create({
        data: {
          workspaceId,
          externalPortfolioId: ext,
          messagingTier: "TIER_250",
          messagingDailyCap: 250,
          messagingHealthUpdatedAt: new Date(),
        },
        select: { id: true },
      })
    ).id;
  portfolioA = await mkPortfolio(`${S}_pf_a`);
  portfolioB = await mkPortfolio(`${S}_pf_b`);
  portfolioShared = await mkPortfolio(`${S}_pf_shared`);

  const mkConn = async (
    phoneId: string,
    display: string,
    wabaId: string,
    portfolioId: string,
    isDefault: boolean,
  ) =>
    (
      await prisma.channelConnection.create({
        data: {
          workspaceId,
          channel: "whatsapp",
          externalAccountId: phoneId,
          isDefault,
          isActive: true,
          wabaId,
          portfolioId,
          config: { phoneNumberId: phoneId, displayPhoneNumber: display, wabaId },
          secrets: {},
        },
        select: { id: true },
      })
    ).id;
  connA = await mkConn(`${S}_pn_a`, "+1 555-010-0001", WABA_A, portfolioA, true);
  connB = await mkConn(`${S}_pn_b`, "+1 555-010-0002", WABA_B, portfolioB, false);
  // TWO numbers under one shared WABA — the "WABA alone can't pin a number" case.
  await mkConn(`${S}_pn_c`, "+1 555-010-0003", WABA_SHARED, portfolioShared, false);
  await mkConn(`${S}_pn_d`, "+1 555-010-0004", WABA_SHARED, portfolioShared, false);

  const mkTpl = async (wabaId: string, name: string) =>
    (
      await prisma.messageTemplate.create({
        data: {
          workspaceId,
          wabaId,
          name,
          language: "en",
          status: "approved",
          category: "marketing",
          components: [],
        },
        select: { id: true },
      })
    ).id;
  tplA = await mkTpl(WABA_A, `${S}_promo`);
  tplB = await mkTpl(WABA_B, `${S}_promo`); // same (name, language), different WABA
  tplLegacy = await mkTpl("", `${S}_legacy_promo`); // pre-multi-account sentinel
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("channel-health attribution", () => {
  it("writes quality onto the number the payload names — not the default", async () => {
    await deliver(
      webhook(WABA_B, "phone_number_quality_update", {
        display_phone_number: "+1 555-010-0002",
        event: "ONBOARDING",
        current_quality_rating: "RED",
        max_daily_conversations_per_business: 10000,
      }),
    );

    const [a, b] = await Promise.all([
      prisma.channelConnection.findUniqueOrThrow({
        where: { id: connA },
        select: { qualityRating: true },
      }),
      prisma.channelConnection.findUniqueOrThrow({
        where: { id: connB },
        select: { qualityRating: true },
      }),
    ]);
    expect(b.qualityRating).toBe("RED");
    expect(a.qualityRating).toBeNull();

    // The tier landed on B's portfolio only — A's independent budget untouched.
    const [pa, pb] = await Promise.all([
      prisma.whatsappPortfolio.findUniqueOrThrow({
        where: { id: portfolioA },
        select: { messagingTier: true },
      }),
      prisma.whatsappPortfolio.findUniqueOrThrow({
        where: { id: portfolioB },
        select: { messagingTier: true, messagingDailyCap: true },
      }),
    ]);
    expect(pb.messagingTier).toBe("TIER_10K");
    expect(pb.messagingDailyCap).toBe(10_000);
    expect(pa.messagingTier).toBe("TIER_250");
  });

  it("quality-only payload (no tier field) still updates the rating", async () => {
    // W6 regression: this used to return null from the parser entirely, so the
    // band only ever refreshed via the periodic Graph poll.
    await deliver(
      webhook(WABA_A, "phone_number_quality_update", {
        display_phone_number: "+1 555-010-0001",
        current_quality_rating: "YELLOW",
      }),
    );
    const a = await prisma.channelConnection.findUniqueOrThrow({
      where: { id: connA },
      select: { qualityRating: true },
    });
    expect(a.qualityRating).toBe("YELLOW");
  });

  it("drops per-number fields it cannot attribute, but still lands the tier on the WABA's portfolio", async () => {
    await deliver(
      webhook(WABA_SHARED, "phone_number_quality_update", {
        display_phone_number: "+1 999-999-9999", // matches nothing
        current_quality_rating: "RED",
        max_daily_conversations_per_business: 2000,
      }),
    );

    // Neither number under the shared WABA got the unattributable RED.
    const tainted = await prisma.channelConnection.count({
      where: { workspaceId, wabaId: WABA_SHARED, qualityRating: { not: null } },
    });
    expect(tainted).toBe(0);
    // The tier is portfolio-scoped and the WABA pins the portfolio — it lands.
    const shared = await prisma.whatsappPortfolio.findUniqueOrThrow({
      where: { id: portfolioShared },
      select: { messagingTier: true },
    });
    expect(shared.messagingTier).toBe("TIER_2K");
  });
});

describe("utility-template enforcement", () => {
  it("a rate-limit restriction lands on the WABA's connection with Meta's expiry", async () => {
    const expiry = Math.floor(Date.now() / 1000) + 7 * 86_400;
    await deliver(
      webhook(WABA_B, "account_update", {
        event: "ACCOUNT_RESTRICTION",
        violation_info: { violation_type: "UTILITY_TEMPLATE_ABUSE_RATE_LIMIT" },
        restriction_info: [
          {
            restriction_type: "RATE_LIMITED_UTILITY_TEMPLATE_MESSAGING",
            expiration: expiry,
          },
        ],
      }),
    );
    const [a, b] = await Promise.all([
      prisma.channelConnection.findUniqueOrThrow({
        where: { id: connA },
        select: { utilityRestrictionType: true },
      }),
      prisma.channelConnection.findUniqueOrThrow({
        where: { id: connB },
        select: { utilityRestrictionType: true, utilityRestrictedUntil: true },
      }),
    ]);
    expect(b.utilityRestrictionType).toBe("RATE_LIMITED_UTILITY_TEMPLATE_MESSAGING");
    expect(b.utilityRestrictedUntil?.getTime()).toBe(expiry * 1000);
    // Enforcement is WABA-scoped — the other WABA's number is untouched.
    expect(a.utilityRestrictionType).toBeNull();
  });

  it("the recovery webhook clears the stored restriction", async () => {
    await deliver(
      webhook(WABA_B, "account_update", {
        event: "ACCOUNT_RESTRICTION",
        violation_info: {
          violation_type: "UTILITY_TEMPLATE_ABUSE_RATE_LIMIT_RECOVERY",
        },
      }),
    );
    const b = await prisma.channelConnection.findUniqueOrThrow({
      where: { id: connB },
      select: { utilityRestrictionType: true, utilityRestrictedUntil: true },
    });
    expect(b.utilityRestrictionType).toBeNull();
    expect(b.utilityRestrictedUntil).toBeNull();
  });
});

describe("account alerts (W8)", () => {
  it("persists an unparsed account_update event on the WABA's connections", async () => {
    // The class where "app removed from WABA" will land — used to be a warn
    // log at info severity and nothing else.
    await deliver(
      webhook(WABA_B, "account_update", {
        event: "SOME_FUTURE_EVENT",
        detail_code: "X123",
      }),
    );
    const b = await prisma.channelConnection.findUniqueOrThrow({
      where: { id: connB },
      select: { lastAccountAlert: true, qualityRating: true },
    });
    const alert = b.lastAccountAlert as {
      source?: string;
      event?: string;
      observedAt?: string;
    } | null;
    expect(alert?.source).toBe("account_update");
    expect(alert?.event).toBe("SOME_FUTURE_EVENT");
    expect(alert?.observedAt).toBeTruthy();
    // The sibling WABA's connection carries no alert.
    const a = await prisma.channelConnection.findUniqueOrThrow({
      where: { id: connA },
      select: { lastAccountAlert: true },
    });
    expect(a.lastAccountAlert).toBeNull();
  });
});

describe("phone_number_name_update", () => {
  it("writes the decision onto the number the payload names", async () => {
    // A rejection lands as DECLINED and keeps the previous verified name.
    await deliver(
      webhook(WABA_B, "phone_number_name_update", {
        display_phone_number: "+1 555-010-0002",
        decision: "REJECTED",
        requested_verified_name: "Totally Different Brand",
        rejection_reason: "NONE",
      }),
    );
    const b = await prisma.channelConnection.findUniqueOrThrow({
      where: { id: connB },
      select: { nameStatus: true, verifiedName: true },
    });
    expect(b.nameStatus).toBe("DECLINED");
    expect(b.verifiedName).toBeNull(); // rejection must not adopt the requested name

    // An approval flips the status AND adopts the reviewed name.
    await deliver(
      webhook(WABA_B, "phone_number_name_update", {
        display_phone_number: "+1 555-010-0002",
        decision: "APPROVED",
        requested_verified_name: "Support Line",
      }),
    );
    const after = await prisma.channelConnection.findUniqueOrThrow({
      where: { id: connB },
      select: { nameStatus: true, verifiedName: true },
    });
    expect(after.nameStatus).toBe("APPROVED");
    expect(after.verifiedName).toBe("Support Line");
    // The sibling number is untouched.
    const a = await prisma.channelConnection.findUniqueOrThrow({
      where: { id: connA },
      select: { nameStatus: true },
    });
    expect(a.nameStatus).toBeNull();
  });
});

describe("template-status attribution (W2)", () => {
  it("a rejection on WABA B's template does not flip WABA A's same-named template", async () => {
    await deliver(
      webhook(WABA_B, "message_template_status_update", {
        message_template_name: `${S}_promo`,
        message_template_language: "en",
        event: "REJECTED",
        reason: "INCORRECT_CATEGORY",
      }),
    );

    const [a, b] = await Promise.all([
      prisma.messageTemplate.findUniqueOrThrow({
        where: { id: tplA },
        select: { status: true },
      }),
      prisma.messageTemplate.findUniqueOrThrow({
        where: { id: tplB },
        select: { status: true, statusReason: true },
      }),
    ]);
    expect(b.status).toBe("rejected");
    expect(b.statusReason).toBe("INCORRECT_CATEGORY");
    expect(a.status).toBe("approved"); // untouched — the old bug flipped this too
  });

  it("still matches a legacy row synced before wabaId existed (the \"\" sentinel)", async () => {
    await deliver(
      webhook(WABA_B, "message_template_status_update", {
        message_template_name: `${S}_legacy_promo`,
        message_template_language: "en",
        event: "PAUSED",
      }),
    );
    const legacy = await prisma.messageTemplate.findUniqueOrThrow({
      where: { id: tplLegacy },
      select: { status: true },
    });
    expect(legacy.status).toBe("paused");
  });
});
