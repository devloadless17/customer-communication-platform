/**
 * Inbound-webhook GAP DETECTION — the sweeper that stands between a silently
 * dropped Meta subscription and days of missing customer messages.
 *
 * Why this file exists: `lib/sweepers/webhook-subscription-health.ts` had ZERO
 * tests (verification program, 2026-07-29) despite being 272 lines of
 * self-healing state machine guarding the one failure where data disappears
 * with no error anywhere — a Meta-dashboard re-save resets the WABA/Page
 * subscription, credentials stay valid, inbound goes to zero, nothing throws.
 * That exact failure took Messenger dark in production on 2026-07-10.
 *
 * It could not be tested against the existing harness either: the mock Graph
 * (`tests/e2e/_mock/graph-mock.mjs`) does not implement `/subscribed_apps` at
 * all. So this is a unit-level spec with Graph mocked at the module seam, in
 * the same style as `whatsapp-health-per-account.spec.ts`.
 *
 * The behaviours pinned are the ones whose failure is SILENT:
 *   - a transient Graph error must NOT be mistaken for "broken" (a flapping
 *     alert trains the reader to ignore the real one);
 *   - a genuinely missing subscription must self-heal, and a heal that FAILS
 *     must raise `needsReconnect` so the workspace admin sees the banner;
 *   - a dead token (Graph 190) must be classified as broken, not transient —
 *     a false negative here means the detector itself goes dark.
 *
 *   pnpm --filter @ccp/api exec vitest run test/webhook-subscription-health.spec.ts
 */
import { existsSync } from "node:fs";

import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { setSharedDb } from "@/lib/db";
import { seedWabaAccount } from "./_waba";

vi.mock("@/lib/providers/meta-graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/meta-graph")>();
  return { ...actual, graphGetJson: vi.fn() };
});
vi.mock("@/lib/providers/meta-waba-subscription", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/meta-waba-subscription")>();
  return { ...actual, ensureWabaSubscribed: vi.fn() };
});

import { graphGetJson } from "@/lib/providers/meta-graph";
import { ensureWabaSubscribed } from "@/lib/providers/meta-waba-subscription";
import { invalidateProviderConfig } from "@/lib/providers/config";
import { sweepWebhookSubscriptionHealthOnce } from "@/lib/sweepers/webhook-subscription-health";

import { createTestPrismaClient } from "./_prisma";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `whs${Date.now().toString().slice(-8)}`;
const PHONE = `${S}_phone`;
const WABA = `${S}_waba`;
/** OUR Meta app. `subscribed_apps` lists every app on the WABA, so the check is
 *  "is this id present", not "is the list non-empty" — see the scoping block. */
const APP = `${S}_app`;

let orgId = "";
let workspaceId = "";
let connId = "";

const mockedGraph = vi.mocked(graphGetJson);
const mockedEnsure = vi.mocked(ensureWabaSubscribed);

/** The sweeper reads EVERY active Meta connection on the platform, so a test
 *  must assert on ITS OWN row rather than on call counts — another spec's
 *  fixture (or the maintainer's real workspace) is in the same sweep. */
async function needsReconnect(): Promise<boolean> {
  const row = await prisma.channelConnection.findUniqueOrThrow({
    where: { id: connId },
    select: { needsReconnect: true },
  });
  return row.needsReconnect;
}

async function clearReconnectFlag(): Promise<void> {
  await prisma.channelConnection.update({
    where: { id: connId },
    data: { needsReconnect: false },
  });
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `WHS Org ${S}`, status: "active" } })).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `WHS WS ${S}`, organizationId: orgId } })
  ).id;
  connId = (
    await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: PHONE,
        isDefault: true,
        isActive: true,
        // The FK, not just config — the sweeper joins the WABA off the
        // row and skips the connection outright when it is null. Setting only
        // `config.wabaId` made every case here skip, which passed the
        // negative assertions VACUOUSLY. Kept in both places because the
        // provider config loader reads the config copy.
        wabaAccountId: await seedWabaAccount(prisma, workspaceId, WABA),
        config: { phoneNumberId: PHONE, appId: APP },
        // Plaintext rides decryptSecret's legacy passthrough, as elsewhere.
        secrets: { accessToken: `${S}_token` },
      },
      select: { id: true },
    })
  ).id;
});

beforeEach(async () => {
  mockedGraph.mockReset();
  mockedEnsure.mockReset();
  invalidateProviderConfig(workspaceId);
  await clearReconnectFlag();
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("webhook subscription health", () => {
  it("leaves a healthy subscription alone", async () => {
    mockedGraph.mockImplementation(async (url: string) => {
      if (url.includes(WABA)) return { data: [{ whatsapp_business_api_data: { id: APP } }] };
      throw new Error(`unexpected graph call: ${url}`);
    });

    await sweepWebhookSubscriptionHealthOnce();

    // NON-VACUITY GUARD. Every other assertion in this test is a negative, and
    // this spec has already been caught passing them without reaching the code
    // at all (the fixture set `config.wabaId` but not the `wabaId` COLUMN, so
    // the sweeper skipped the connection). Prove it actually probed OUR waba.
    expect(
      mockedGraph.mock.calls.some(([url]) => String(url).includes(WABA)),
      "the sweeper never probed this connection — the rest of this test is vacuous",
    ).toBe(true);
    expect(await needsReconnect()).toBe(false);
    // No heal attempted — the subscription was already there.
    expect(mockedEnsure).not.toHaveBeenCalledWith(
      WABA,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("SELF-HEALS a dropped subscription instead of alerting", async () => {
    // The 2026-07-10 production shape: credentials fine, subscription silently
    // reset by a dashboard re-save. The sweeper must re-subscribe with the same
    // idempotent helper onboarding uses, and NOT raise the reconnect banner —
    // there is nothing for the admin to do once it is fixed.
    mockedGraph.mockImplementation(async (url: string) => {
      if (url.includes(WABA)) return { data: [] };
      throw new Error(`unexpected graph call: ${url}`);
    });
    mockedEnsure.mockResolvedValue({ ok: true });

    await sweepWebhookSubscriptionHealthOnce();

    expect(mockedEnsure).toHaveBeenCalledWith(
      WABA,
      expect.any(String),
      expect.any(String),
      APP,
    );
    expect(await needsReconnect()).toBe(false);
  });

  it("raises needsReconnect when the subscription is gone AND cannot be healed", async () => {
    mockedGraph.mockImplementation(async (url: string) => {
      if (url.includes(WABA)) return { data: [] };
      throw new Error(`unexpected graph call: ${url}`);
    });
    mockedEnsure.mockResolvedValue({ ok: false, error: "insufficient permission" });

    await sweepWebhookSubscriptionHealthOnce();

    expect(await needsReconnect()).toBe(true);
  });

  it("a TRANSIENT Graph failure must not be mistaken for broken", async () => {
    // The one that matters most. Graph 5xx / a network blip must leave state
    // untouched so the next tick retries; flagging here would flap the admin's
    // reconnect banner on every hiccup and train them to ignore the real one.
    mockedGraph.mockRejectedValue(new Error("Graph 503 Service Unavailable"));

    await sweepWebhookSubscriptionHealthOnce();

    expect(
      mockedGraph.mock.calls.some(([url]) => String(url).includes(WABA)),
      "the sweeper never probed this connection — the rest of this test is vacuous",
    ).toBe(true);
    expect(await needsReconnect()).toBe(false);
    // And it must not "heal" something it could not even read.
    expect(mockedEnsure).not.toHaveBeenCalledWith(
      WABA,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("classifies a DEAD TOKEN as broken, not transient", async () => {
    // A false negative here is silent and total: the token is a corpse, the
    // detector says "transient", and a receive-only workspace runs for days on
    // it. Graph reports this as code 190 / OAuthException.
    mockedGraph.mockRejectedValue(
      new Error('Graph error 400: {"error":{"message":"Session expired","code":190}}'),
    );

    await sweepWebhookSubscriptionHealthOnce();

    expect(await needsReconnect()).toBe(true);
  });

  it("skips an INACTIVE connection entirely", async () => {
    await prisma.channelConnection.update({
      where: { id: connId },
      data: { isActive: false },
    });
    mockedGraph.mockImplementation(async (url: string) => {
      throw new Error(`inactive connection must not be probed: ${url}`);
    });

    await sweepWebhookSubscriptionHealthOnce();

    expect(await needsReconnect()).toBe(false);
    await prisma.channelConnection.update({
      where: { id: connId },
      data: { isActive: true },
    });
  });
});

/**
 * "Is anyone subscribed" is a DIFFERENT question from "are we subscribed", and
 * the check used to ask the first one (`data.length > 0`).
 *
 * `GET /{waba-id}/subscribed_apps` returns every app subscribed to the WABA —
 * Meta's reference ships a "Multiple apps subscribed to WABA" example, and a WABA
 * shared with another BSP (Coexistence, partner onboarding, a vendor the customer
 * never detached) is the ordinary way that happens. Our app could be absent, so
 * receiving NOTHING, while the detector reported healthy: the exact silent hole
 * this sweeper exists to close, reopened inside the sweeper itself.
 *
 * Pinned here because nothing else can catch it — the shape is valid, Graph
 * returns 200, and no type says which id is ours.
 */
describe("the subscription has to be OURS", () => {
  const OTHER = { whatsapp_business_api_data: { id: "some_other_bsp_app" } };

  it("does NOT count another app's subscription as ours", async () => {
    mockedGraph.mockImplementation(async (url: string) => {
      if (url.includes(WABA)) return { data: [OTHER] };
      throw new Error(`unexpected graph call: ${url}`);
    });
    mockedEnsure.mockResolvedValue({ ok: true });

    await sweepWebhookSubscriptionHealthOnce();

    // The old `data.length > 0` read this as healthy and never attempted a heal.
    expect(mockedEnsure).toHaveBeenCalledWith(
      WABA,
      expect.any(String),
      expect.any(String),
      APP,
    );
  });

  it("raises the banner when we are absent and the re-subscribe fails", async () => {
    mockedGraph.mockImplementation(async (url: string) => {
      if (url.includes(WABA)) return { data: [OTHER] };
      throw new Error(`unexpected graph call: ${url}`);
    });
    mockedEnsure.mockResolvedValue({ ok: false, error: "no permission on this WABA" });

    await sweepWebhookSubscriptionHealthOnce();

    expect(await needsReconnect()).toBe(true);
  });

  it("still counts a subscription among OTHERS when ours is there too", async () => {
    // The realistic shared-WABA shape: two BSPs, both subscribed. Nothing to fix.
    mockedGraph.mockImplementation(async (url: string) => {
      if (url.includes(WABA)) {
        return { data: [OTHER, { whatsapp_business_api_data: { id: APP } }] };
      }
      throw new Error(`unexpected graph call: ${url}`);
    });

    await sweepWebhookSubscriptionHealthOnce();

    expect(await needsReconnect()).toBe(false);
    expect(mockedEnsure).not.toHaveBeenCalled();
  });

  it("falls back to any-app when the connection has no appId", async () => {
    // A row stored before the id was captured cannot answer "are WE subscribed".
    // Refusing to answer would take the detector down for those rows, so the
    // pre-existing any-app reading stands — a weaker check, never a false alarm.
    await prisma.channelConnection.update({
      where: { id: connId },
      data: { config: { phoneNumberId: PHONE } },
    });
    invalidateProviderConfig(workspaceId);
    mockedGraph.mockImplementation(async (url: string) => {
      if (url.includes(WABA)) return { data: [OTHER] };
      throw new Error(`unexpected graph call: ${url}`);
    });

    try {
      await sweepWebhookSubscriptionHealthOnce();

      expect(await needsReconnect()).toBe(false);
      expect(mockedEnsure).not.toHaveBeenCalled();
    } finally {
      await prisma.channelConnection.update({
        where: { id: connId },
        data: { config: { phoneNumberId: PHONE, appId: APP } },
      });
      invalidateProviderConfig(workspaceId);
    }
  });
});

/**
 * A WhatsApp webhook subscription lives on the WABA, and every number under it
 * shares that ONE subscription — so the check is per WABA, not per number.
 *
 * The loop used to iterate connections, asking Graph the same question once per
 * number for an answer that cannot differ. Four numbers under one WABA burned
 * four calls a tick against a rate-limited API.
 *
 * Both halves are pinned here, because the fix is only safe if the result still
 * reaches every number: dedupe the CALL, fan out the RESULT. If a WABA's
 * subscription is gone, every number under it lost inbound together, so each one
 * needs its own reconnect banner.
 */
describe("the WABA is the subscription unit, not the number", () => {
  let siblingId = "";

  beforeEach(async () => {
    siblingId = (
      await prisma.channelConnection.create({
        data: {
          workspaceId,
          channel: "whatsapp",
          externalAccountId: `${PHONE}_sib`,
          isDefault: false,
          isActive: true,
          wabaAccountId: (
            await prisma.channelConnection.findUniqueOrThrow({
              where: { id: connId },
              select: { wabaAccountId: true },
            })
          ).wabaAccountId,
          config: { phoneNumberId: `${PHONE}_sib` },
          secrets: { accessToken: `${S}_token` },
          messagingHealthUpdatedAt: new Date(),
        },
        select: { id: true },
      })
    ).id;
    invalidateProviderConfig(workspaceId);
  });

  afterEach(async () => {
    await prisma.channelConnection.delete({ where: { id: siblingId } }).catch(() => undefined);
    invalidateProviderConfig(workspaceId);
  });

  it("asks Graph about the WABA ONCE for two numbers under it", async () => {
    mockedGraph.mockImplementation(async (url: string) => {
      if (url.includes(WABA)) return { data: [{ whatsapp_business_api_data: { id: APP } }] };
      throw new Error(`unexpected graph call: ${url}`);
    });

    await sweepWebhookSubscriptionHealthOnce();

    // Scoped to OUR waba id — the sweep covers every connection on the platform,
    // so a global call count would be another fixture's business.
    const ours = mockedGraph.mock.calls.filter(([url]) => String(url).includes(WABA));
    expect(ours).toHaveLength(1);
  });

  it("still flags BOTH numbers when that one subscription is broken", async () => {
    mockedGraph.mockImplementation(async (url: string) => {
      if (url.includes(WABA)) return { data: [] };
      throw new Error(`unexpected graph call: ${url}`);
    });
    mockedEnsure.mockResolvedValue({ ok: false, error: "no permission" });

    await sweepWebhookSubscriptionHealthOnce();

    expect(await needsReconnect(), "probe number").toBe(true);
    const sibling = await prisma.channelConnection.findUniqueOrThrow({
      where: { id: siblingId },
      select: { needsReconnect: true },
    });
    expect(sibling.needsReconnect, "sibling number under the same WABA").toBe(true);
  });
});
