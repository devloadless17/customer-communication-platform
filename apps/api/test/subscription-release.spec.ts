/**
 * Removing an account must RELEASE its webhook subscription — but only when
 * nothing else still depends on it.
 *
 * Connecting an account asserts its subscription (`ensureWabaSubscribed` /
 * `ensurePageSubscribedToMessaging`). Nothing ever released it, so Meta kept
 * POSTing a removed business's customer messages forever: ingest dropped them
 * fail-soft as `unknown_account`, but dropping is not the same as not receiving.
 *
 * The release has to be scoped to what each subscription actually covers, and BOTH
 * directions are dangerous:
 *
 *   - too little → Meta keeps delivering a removed account's traffic (the bug);
 *   - too much  → a SIBLING still using that WABA/Page goes dark, which is the
 *     silent total-inbound-loss failure this codebase has hit before.
 *
 * WhatsApp subscribes per WABA and numbers under one WABA share it. Messenger and
 * Instagram subscribe per PAGE and can share one — and because the field set is a
 * single shared union with no per-channel subset to subtract, releasing while the
 * sibling is connected is a no-op rather than a partial unsubscribe.
 *
 *   pnpm --filter @ccp/api exec vitest run test/subscription-release.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { seedWabaAccount } from "./_waba";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setSharedDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto/envelope";
import { ChannelAccountsService } from "@/workspace-settings/channel-accounts/channel-accounts.service";
import type { DbService } from "@/db/db.service";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const bus = { publish: async () => undefined };
const service = new ChannelAccountsService(
  prisma as unknown as DbService,
  bus as never,
);

const S = `srl${Date.now().toString().slice(-8)}`;

/** Every Graph call the release path makes, in order. */
let calls: Array<{ method: string; url: string }> = [];

function stubGraph() {
  calls = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    calls.push({ method, url });
    return new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

/** Did we DELETE the subscription for this id? */
function deletedFor(id: string): boolean {
  return calls.some(
    (c) => c.method === "DELETE" && c.url.includes(id) && c.url.includes("subscribed_apps"),
  );
}

let orgId = "";
let workspaceId = "";

async function freshWorkspace() {
  orgId = (
    await prisma.organization.create({ data: { name: `SRL Org ${S}`, status: "active" } })
  ).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `SRL WS ${S}`, organizationId: orgId } })
  ).id;
}

async function mkWhatsapp(suffix: string, wabaAccountId: string, isDefault = false) {
  return (
    await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: `${S}_${suffix}`,
        wabaAccountId,
        isDefault,
        isActive: true,
        config: { phoneNumberId: `${S}_${suffix}` },
        secrets: { accessToken: encryptSecret("tok"), appSecret: encryptSecret("sec") },
        messagingHealthUpdatedAt: new Date(),
      },
      select: { id: true },
    })
  ).id;
}

async function mkSocial(channel: "messenger" | "instagram", pageId: string, isDefault = true) {
  return (
    await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel,
        externalAccountId: `${S}_${channel}_acct`,
        isDefault,
        isActive: true,
        config: { pageId },
        secrets: { pageAccessToken: encryptSecret("ptok"), appSecret: encryptSecret("sec") },
      },
      select: { id: true },
    })
  ).id;
}

beforeEach(async () => {
  await freshWorkspace();
  stubGraph();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("WhatsApp — the WABA is the subscription unit", () => {
  it("does NOT release while a sibling number still uses the WABA", async () => {
    const waba = await seedWabaAccount(prisma, workspaceId, `${S}_waba_shared`);
    const a = await mkWhatsapp("a", waba, true);
    await mkWhatsapp("b", waba);

    await service.remove(workspaceId, "whatsapp", a);

    // Releasing here would take number B dark — the exact silent-inbound-loss
    // failure the release is supposed to avoid causing.
    expect(deletedFor(`${S}_waba_shared`)).toBe(false);
  });

  it("releases when the LAST number under the WABA is removed", async () => {
    const waba = await seedWabaAccount(prisma, workspaceId, `${S}_waba_solo`);
    const only = await mkWhatsapp("solo", waba, true);

    await service.remove(workspaceId, "whatsapp", only);

    expect(deletedFor(`${S}_waba_solo`)).toBe(true);
  });
});

describe("social — the PAGE is the subscription unit, and it can be shared", () => {
  it("does NOT release while the sibling channel still uses the Page", async () => {
    // Messenger and Instagram on ONE Page. The subscribed-field set is a single
    // shared union, so there is no per-channel subset to subtract: the only safe
    // move while the sibling is connected is to leave it alone entirely.
    const pageId = `${S}_shared_page`;
    const messenger = await mkSocial("messenger", pageId);
    await mkSocial("instagram", pageId);

    await service.remove(workspaceId, "messenger", messenger);

    expect(deletedFor(pageId)).toBe(false);
    // …and nothing tried to rewrite the field set either, which would have
    // unsubscribed Instagram's fields along with Messenger's.
    expect(calls.some((c) => c.method === "POST" && c.url.includes(pageId))).toBe(false);
  });

  it("releases when the LAST channel on the Page is removed", async () => {
    const pageId = `${S}_solo_page`;
    const messenger = await mkSocial("messenger", pageId);

    await service.remove(workspaceId, "messenger", messenger);

    expect(deletedFor(pageId)).toBe(true);
  });
});

describe("the release is best-effort", () => {
  it("still removes the account when Graph refuses the unsubscribe", async () => {
    // A removal the operator asked for must complete regardless. The worst case of
    // a failed release is the pre-existing behaviour: Meta keeps sending, ingest
    // drops as unknown_account.
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 403 }));
    const waba = await seedWabaAccount(prisma, workspaceId, `${S}_waba_fail`);
    const only = await mkWhatsapp("fail", waba, true);

    await expect(service.remove(workspaceId, "whatsapp", only)).resolves.toBeUndefined();
    expect(
      await prisma.channelConnection.findUnique({ where: { id: only } }),
    ).toBeNull();
  });
});
