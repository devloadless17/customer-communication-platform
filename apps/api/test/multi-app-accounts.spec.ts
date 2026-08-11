/**
 * A workspace may hold accounts on DIFFERENT Meta apps — and a re-save must never
 * overwrite one app's credentials with another's.
 *
 * ## Why this is supported at all
 *
 * `MetaConnection` (one per workspace: app id, app secret, system-user token) is a
 * DEFAULT, not a constraint. Every `ChannelConnection` stores its own encrypted
 * `appSecret`/token, and the whole inbound path is already built for the mixed
 * case: `getMetaWebhookConfig` verifies an incoming HMAC against the shared secret
 * AND every account's own secret, `getTeamVerifyTokens` accepts any account's
 * verify token on the GET handshake, and `appsecret_proof` is computed with the
 * connection's own secret ("the app secret must belong to the app that ISSUED the
 * token"). So a second number on its own Meta app works by design.
 *
 * ## The bug this pins
 *
 * Credential resolution on save read `input.appSecret || meta.appSecret` — with no
 * fallback to the row's OWN stored value. So ANY re-save of an own-app account
 * (changing a label, re-running the WABA check, or `MetaService.resyncChannels`
 * after a shared-credential rotation) silently replaced its secret and token with
 * the shared app's. Meta then signs that account's webhooks with a secret we no
 * longer hold, so every inbound is dropped as forged — the same silent
 * total-inbound-loss class as the `""`-placeholder default-account bug.
 *
 *   pnpm --filter @ccp/api exec vitest run test/multi-app-accounts.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { seedWabaAccount } from "./_waba";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { setSharedDb } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto/envelope";
import { invalidateProviderConfig } from "@/lib/providers/config";
import { invalidateMetaConnection } from "@/lib/providers/meta-connection";
import { WhatsappService } from "@/workspace-settings/whatsapp/whatsapp.service";
import { InstagramService } from "@/workspace-settings/instagram/instagram.service";
import { invalidateInstagramConfig } from "@/lib/providers/instagram-config";
import type { DbService } from "@/db/db.service";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const bus = { publish: async () => undefined };
const service = new WhatsappService(prisma as unknown as DbService, bus as never);
const instagram = new InstagramService(prisma as unknown as DbService, bus as never);

const S = `maa${Date.now().toString().slice(-8)}`;
const SHARED_SECRET = `${S}_shared_app_secret`;
const SHARED_TOKEN = `${S}_shared_system_token`;
const OWN_SECRET = `${S}_own_app_secret`;
const OWN_TOKEN = `${S}_own_app_token`;

const PHONE_SHARED = `${S}_pn_shared`;
const PHONE_OWN = `${S}_pn_own`;
const WABA_SHARED = `${S}_waba_shared`;
const WABA_OWN = `${S}_waba_own`;

/** Instagram's account key is the IG professional-account id, NOT the Page id. */
const IG_PAGE_OWN = `${S}_page_own`;
const IG_ID_OWN = `${S}_ig_own`;

let orgId = "";
let workspaceId = "";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Stand-in Graph: accepts every read `updateConfig` makes on the happy path. */
function stubGraph() {
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const owns = url.match(/\/([^/?]+)\/phone_numbers/);
    if (owns) {
      const ids = owns[1] === WABA_OWN ? [PHONE_OWN] : [PHONE_SHARED];
      return jsonResponse({ data: ids.map((id) => ({ id })) });
    }
    // The single read `InstagramService.updateConfig` makes: resolve the linked
    // IG professional account (and derive a Page token) from the Page node.
    if (url.includes("instagram_business_account")) {
      return jsonResponse({
        name: "Test Page",
        access_token: `${S}_derived_page_token`,
        instagram_business_account: { id: IG_ID_OWN, username: "testhandle" },
      });
    }
    if (url.includes("fields=display_phone_number")) {
      return jsonResponse({
        display_phone_number: "+1 555 0100",
        verified_name: "Test",
        name_status: "APPROVED",
        code_verification_status: "VERIFIED",
        status: "CONNECTED",
      });
    }
    return jsonResponse({ success: true, data: [] });
  });
}

/** The stored, decrypted credentials of one account. */
async function storedCreds(externalAccountId: string) {
  const row = await prisma.channelConnection.findFirstOrThrow({
    where: { workspaceId, channel: "whatsapp", externalAccountId },
    select: { secrets: true },
  });
  const secrets = (row.secrets ?? {}) as { accessToken?: string; appSecret?: string };
  return {
    accessToken: secrets.accessToken ? decryptSecret(secrets.accessToken) : null,
    appSecret: secrets.appSecret ? decryptSecret(secrets.appSecret) : null,
  };
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({ data: { name: `MAA Org ${S}`, status: "active" } })
  ).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `MAA WS ${S}`, organizationId: orgId } })
  ).id;

  // The workspace's SHARED Meta app.
  await prisma.metaConnection.create({
    data: {
      workspaceId,
      config: { appId: `${S}_app`, verifyToken: `${S}_vt` },
      secrets: {
        appSecret: encryptSecret(SHARED_SECRET),
        systemUserToken: encryptSecret(SHARED_TOKEN),
      },
    },
  });
  invalidateMetaConnection(workspaceId);

  // Number A — on the shared app (no explicit creds, so it inherits).
  await prisma.channelConnection.create({
    data: {
      workspaceId,
      channel: "whatsapp",
      externalAccountId: PHONE_SHARED,
      wabaAccountId: await seedWabaAccount(prisma, workspaceId, WABA_SHARED),
      isDefault: true,
      isActive: true,
      config: { phoneNumberId: PHONE_SHARED },
      secrets: {
        accessToken: encryptSecret(SHARED_TOKEN),
        appSecret: encryptSecret(SHARED_SECRET),
      },
      messagingHealthUpdatedAt: new Date(),
    },
  });

  // Number B — deliberately on its OWN, different Meta app.
  await prisma.channelConnection.create({
    data: {
      workspaceId,
      channel: "whatsapp",
      externalAccountId: PHONE_OWN,
      wabaAccountId: await seedWabaAccount(prisma, workspaceId, WABA_OWN),
      isDefault: false,
      isActive: true,
      config: { phoneNumberId: PHONE_OWN },
      secrets: {
        accessToken: encryptSecret(OWN_TOKEN),
        appSecret: encryptSecret(OWN_SECRET),
      },
      messagingHealthUpdatedAt: new Date(),
    },
  });
  // An INSTAGRAM account, also on its own Meta app. Keyed on the IG id (that is
  // what Meta puts in `entry[].id` on an `object:"instagram"` webhook), with the
  // Page id living in `config` — the split that made this channel's copy of the
  // own-secret lookup read the wrong key.
  await prisma.channelConnection.create({
    data: {
      workspaceId,
      channel: "instagram",
      externalAccountId: IG_ID_OWN,
      isDefault: true,
      isActive: true,
      config: { igId: IG_ID_OWN, pageId: IG_PAGE_OWN, appId: `${S}_own_app` },
      secrets: {
        igAccessToken: encryptSecret(OWN_TOKEN),
        appSecret: encryptSecret(OWN_SECRET),
      },
    },
  });
  invalidateProviderConfig(workspaceId);
  invalidateInstagramConfig(workspaceId);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("an account on its OWN Meta app", () => {
  it("keeps its own credentials when re-saved without explicit ones", async () => {
    stubGraph();
    // A perfectly ordinary re-save: the operator supplies only the identity.
    await service.updateConfig(workspaceId, {
      phoneNumberId: PHONE_OWN,
      wabaId: WABA_OWN,
    });

    const creds = await storedCreds(PHONE_OWN);
    // Before the fix both of these were the SHARED app's values, after which Meta
    // signed this number's webhooks with a secret we no longer held.
    expect(creds.appSecret).toBe(OWN_SECRET);
    expect(creds.accessToken).toBe(OWN_TOKEN);
  });

  it("still accepts an EXPLICIT credential change — input always wins", async () => {
    stubGraph();
    const rotated = `${S}_own_app_secret_v2`;
    await service.updateConfig(workspaceId, {
      phoneNumberId: PHONE_OWN,
      wabaId: WABA_OWN,
      appSecret: rotated,
    });
    expect((await storedCreds(PHONE_OWN)).appSecret).toBe(rotated);

    // Put it back so the ordering of these tests can't matter.
    await service.updateConfig(workspaceId, {
      phoneNumberId: PHONE_OWN,
      wabaId: WABA_OWN,
      appSecret: OWN_SECRET,
    });
    expect((await storedCreds(PHONE_OWN)).appSecret).toBe(OWN_SECRET);
  });
});

describe("an INSTAGRAM account on its OWN Meta app", () => {
  it("keeps its own app secret when re-saved without explicit ones", async () => {
    stubGraph();
    // Record which bearer authenticates the Page probe — regression pin for the
    // 2026-08-11 review: a stored PAGE token must never drive the probe (it
    // cannot read `instagram_business_account`, and preferring it over the
    // shared token broke the Save-to-reconnect self-heal).
    const probeBearers: string[] = [];
    const stubbed = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("instagram_business_account")) {
          const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
          if (auth) probeBearers.push(auth);
        }
        return stubbed(input as string, init);
      },
    );

    // The ordinary re-save: the operator supplies only the Page. This is also
    // exactly what `MetaService.resyncChannels` replays for every Instagram row.
    await instagram.updateConfig(workspaceId, { pageId: IG_PAGE_OWN });

    const row = await prisma.channelConnection.findFirstOrThrow({
      where: { workspaceId, channel: "instagram", externalAccountId: IG_ID_OWN },
      select: { secrets: true },
    });
    const secrets = (row.secrets ?? {}) as { appSecret?: string; igAccessToken?: string };
    // Instagram's copy of this guard looked the row up by `pageId`, but an
    // Instagram row is keyed by the IG id — so it matched nothing, `ownAppSecret`
    // was always null, and the shared app's secret won every time. Meta then
    // signed this handle's webhooks with a secret we no longer held and every
    // inbound DM was dropped as forged.
    expect(secrets.appSecret ? decryptSecret(secrets.appSecret) : null).toBe(OWN_SECRET);
    // STORE-time pair coherence (2026-08-11): the re-save derived a fresh Page
    // token via the SHARED app's system-user token, but an own-app row must
    // keep its stored token — persisting the shared-app derivation beside the
    // row's own appSecret is the app-A-token/app-B-secret mis-pair.
    expect(secrets.igAccessToken ? decryptSecret(secrets.igAccessToken) : null).toBe(OWN_TOKEN);
    // And the probe itself authenticated with the SHARED system-user token —
    // never the stored Page token.
    expect(probeBearers).toEqual([`Bearer ${SHARED_TOKEN}`]);
  });
});

describe("an account on the SHARED Meta app", () => {
  it("takes the shared credentials when they are passed explicitly (rotation)", async () => {
    // This is the shape `MetaService.resyncChannels` uses after a shared-credential
    // save: it names the new values outright, precisely because a row's own stored
    // secret would otherwise win and the rotation would silently do nothing.
    stubGraph();
    const rotatedShared = `${S}_shared_app_secret_v2`;
    await service.updateConfig(workspaceId, {
      phoneNumberId: PHONE_SHARED,
      wabaId: WABA_SHARED,
      appSecret: rotatedShared,
      accessToken: SHARED_TOKEN,
    });

    expect((await storedCreds(PHONE_SHARED)).appSecret).toBe(rotatedShared);
    // …and the own-app number is untouched by the other account's rotation.
    expect((await storedCreds(PHONE_OWN)).appSecret).toBe(OWN_SECRET);
  });
});
