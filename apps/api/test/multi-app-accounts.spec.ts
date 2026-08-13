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

import { PrismaClient, type Prisma } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { seedWabaAccount } from "./_waba";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { setSharedDb } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto/envelope";
import { getMetaSendConfig, invalidateProviderConfig } from "@/lib/providers/config";
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

/**
 * LOAD-TIME token/secret pairing — the twin of the store-time pins above
 * (2026-08-13, pre-Embedded-Signup fence).
 *
 * `getMetaSendConfig` prefers a WABA-row business token when one exists (ES
 * stores ONE customer-scoped token per WABA), but until 2026-08-13 the
 * `appsecret_proof` secret ALWAYS came from the connection row — a token and
 * a secret from two different Meta apps, which 400s every signed call. The
 * pairing is now chosen as one struct in one branch: a WABA token takes the
 * WABA row's secret, else the platform META_APP_SECRET (ES business tokens
 * are issued by the platform app) — never the connection row's.
 */
describe("load-time token/secret pairing (WABA business token)", () => {
  const ES_TOKEN = `${S}_es_business_token`;
  let ownConnId = "";

  beforeAll(async () => {
    ownConnId = (
      await prisma.channelConnection.findFirstOrThrow({
        where: { workspaceId, channel: "whatsapp", externalAccountId: PHONE_OWN },
        select: { id: true },
      })
    ).id;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await prisma.whatsappBusinessAccount.update({
      where: { externalWabaId: WABA_OWN },
      data: { secrets: {} },
    });
    invalidateProviderConfig(workspaceId);
  });

  it("pairs a WABA-row token with the platform secret, never the connection row's", async () => {
    vi.stubEnv("META_APP_SECRET", `${S}_platform_secret`);
    await prisma.whatsappBusinessAccount.update({
      where: { externalWabaId: WABA_OWN },
      data: { secrets: { accessToken: encryptSecret(ES_TOKEN) } },
    });
    invalidateProviderConfig(workspaceId);

    const config = await getMetaSendConfig(workspaceId, ownConnId);
    expect(config.accessToken).toBe(ES_TOKEN); // the WABA token won
    expect(config.appSecret).toBe(`${S}_platform_secret`); // paired with the platform app
    expect(config.appSecret).not.toBe(OWN_SECRET); // the exact fenced bug
  });

  it("a WABA row carrying its OWN secret pairs with that one", async () => {
    await prisma.whatsappBusinessAccount.update({
      where: { externalWabaId: WABA_OWN },
      data: {
        secrets: {
          accessToken: encryptSecret(ES_TOKEN),
          appSecret: encryptSecret(`${S}_waba_own_secret`),
        },
      },
    });
    invalidateProviderConfig(workspaceId);

    const config = await getMetaSendConfig(workspaceId, ownConnId);
    expect(config.accessToken).toBe(ES_TOKEN);
    expect(config.appSecret).toBe(`${S}_waba_own_secret`);
  });

  it("without a WABA token, the connection row's own pair still holds", async () => {
    const config = await getMetaSendConfig(workspaceId, ownConnId);
    expect(config.accessToken).toBe(OWN_TOKEN);
    expect(config.appSecret).toBe(OWN_SECRET);
  });
});

/**
 * getConfig's LIVE `subscribed_apps` verdict (2026-08-13) — WhatsApp parity
 * with the Messenger/Instagram settings reads. The static "final check" hint
 * becomes a real answer, and it must be scoped to OUR app (a WABA shared with
 * another BSP reads non-empty while we receive nothing).
 */
describe("whatsapp getConfig live subscription verdict", () => {
  const OUR_APP = `${S}_verdict_app`;

  async function setDefaultRowAppId(appId: string | null) {
    const row = await prisma.channelConnection.findFirstOrThrow({
      where: { workspaceId, channel: "whatsapp", isDefault: true },
      select: { id: true, config: true },
    });
    const config = { ...(row.config as Record<string, unknown>) };
    if (appId) config.appId = appId;
    else delete config.appId;
    await prisma.channelConnection.update({
      where: { id: row.id },
      data: { config: config as Prisma.InputJsonObject },
    });
  }

  function stubSubscribedApps(payload: unknown | Error) {
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/subscribed_apps")) {
        if (payload instanceof Error) throw payload;
        return jsonResponse(payload);
      }
      return jsonResponse({ success: true, data: [] });
    });
  }

  afterEach(async () => {
    vi.unstubAllGlobals();
    await setDefaultRowAppId(null);
  });

  it("false when only another BSP subscribes; true when ours is present; honest about scoping", async () => {
    await setDefaultRowAppId(OUR_APP);
    stubSubscribedApps({ data: [{ whatsapp_business_api_data: { id: "someone_else" } }] });
    let view = await service.getConfig(workspaceId);
    expect(view.subscription).toEqual({ subscribed: false, scopedToApp: true });

    stubSubscribedApps({
      data: [
        { whatsapp_business_api_data: { id: "someone_else" } },
        { whatsapp_business_api_data: { id: OUR_APP } },
      ],
    });
    view = await service.getConfig(workspaceId);
    expect(view.subscription).toEqual({ subscribed: true, scopedToApp: true });
  });

  it("falls back to any-app (scopedToApp=false) when no appId is stored", async () => {
    stubSubscribedApps({ data: [{ whatsapp_business_api_data: { id: "someone_else" } }] });
    const view = await service.getConfig(workspaceId);
    expect(view.subscription).toEqual({ subscribed: true, scopedToApp: false });
  });

  it("a Graph error leaves the verdict NULL and never fails getConfig", async () => {
    stubSubscribedApps(new Error("Graph 503"));
    const view = await service.getConfig(workspaceId);
    expect(view.subscription).toBeNull();
    expect(view.phoneNumberId).not.toBeNull(); // the page still rendered
  });
});
