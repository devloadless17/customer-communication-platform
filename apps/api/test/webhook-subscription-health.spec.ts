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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { setSharedDb } from "@/lib/db";

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
        // The COLUMN, not just config — the sweeper selects `wabaId` off the
        // row and skips the connection outright when it is null. Setting only
        // `config.wabaId` made every case here skip, which passed the
        // negative assertions VACUOUSLY. Kept in both places because the
        // provider config loader reads the config copy.
        wabaId: WABA,
        config: { phoneNumberId: PHONE, wabaId: WABA },
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
      if (url.includes(WABA)) return { data: [{ whatsapp_business_api_data: { id: "app_1" } }] };
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
    expect(mockedEnsure).not.toHaveBeenCalledWith(WABA, expect.anything(), expect.anything());
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

    expect(mockedEnsure).toHaveBeenCalledWith(WABA, expect.any(String), expect.any(String));
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
    expect(mockedEnsure).not.toHaveBeenCalledWith(WABA, expect.anything(), expect.anything());
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
