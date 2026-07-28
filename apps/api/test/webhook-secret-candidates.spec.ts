/**
 * Inbound webhook HMAC resolves EVERY account's secret, not the default's.
 *
 * Meta signs an inbound webhook with the secret of whichever app owns the
 * account it came from. The old loader read `findFirst({ isDefault: true })`
 * and returned null unless THAT one row was active and carried its own
 * appSecret — so three unrelated states each silently 403'd inbound for the
 * whole workspace, and Meta eventually stopped retrying:
 *
 *   1. a second account under its OWN Meta app signed with a secret that was
 *      never in the candidate list;
 *   2. the default row missing its own appSecret nulled the config even when
 *      the SHARED MetaConnection secret (which actually signs) was healthy —
 *      the early return fired before getMetaConnection was ever consulted;
 *   3. one corrupt ciphertext on the default row took the channel down while a
 *      perfectly healthy sibling sat right beside it.
 *
 * None of these throw. All three look exactly like "this channel isn't
 * connected". The GET-challenge half of the same handshake
 * (`getTeamVerifyTokens`) already read every connection; this asserts the POST
 * half finally agrees with it.
 *
 *   pnpm --filter @ccp/api exec vitest run test/webhook-secret-candidates.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setSharedDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto/envelope";
import { getMetaWebhookConfig, invalidateProviderConfig } from "@/lib/providers/config";
import { invalidateMetaConnection } from "@/lib/providers/meta-connection";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `wc${Date.now().toString().slice(-8)}`;
const SHARED_SECRET = `${S}_shared_app_secret`;
const OWN_SECRET_A = `${S}_own_secret_a`;
const OWN_SECRET_B = `${S}_own_secret_b`;

let orgId = "";
let workspaceId = "";
let connAId = "";
let connBId = "";

/** Every candidate the verifier would try, in order. */
async function candidates(): Promise<string[]> {
  invalidateProviderConfig(workspaceId);
  invalidateMetaConnection(workspaceId);
  const config = await getMetaWebhookConfig(workspaceId);
  return config ? [config.appSecret, ...config.appSecretFallbacks] : [];
}

async function setMetaConnectionSecret(secret: string | null): Promise<void> {
  await prisma.metaConnection.update({
    where: { workspaceId },
    data: {
      secrets: secret
        ? { appSecret: encryptSecret(secret), systemUserToken: encryptSecret("t") }
        : { systemUserToken: encryptSecret("t") },
    },
  });
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({ data: { name: `WC Org ${S}`, status: "active" } })
  ).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `WC WS ${S}`, organizationId: orgId } })
  ).id;
  await prisma.metaConnection.create({
    data: {
      workspaceId,
      config: { appId: `${S}_app`, verifyToken: `${S}_vt` },
      secrets: {
        appSecret: encryptSecret(SHARED_SECRET),
        systemUserToken: encryptSecret("t"),
      },
    },
  });
  connAId = (
    await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: `${S}_a`,
        isDefault: true,
        isActive: true,
        config: { phoneNumberId: `${S}_a`, verifyToken: `${S}_vt` },
        secrets: { appSecret: encryptSecret(OWN_SECRET_A) },
      },
      select: { id: true },
    })
  ).id;
  connBId = (
    await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: `${S}_b`,
        isActive: true,
        config: { phoneNumberId: `${S}_b`, verifyToken: `${S}_vt` },
        // Account B lives on its OWN Meta app — a different signing secret.
        secrets: { appSecret: encryptSecret(OWN_SECRET_B) },
      },
      select: { id: true },
    })
  ).id;
});

beforeEach(async () => {
  // Restore the healthy baseline; each test perturbs exactly one thing.
  await setMetaConnectionSecret(SHARED_SECRET);
  await prisma.channelConnection.update({
    where: { id: connAId },
    data: { isActive: true, secrets: { appSecret: encryptSecret(OWN_SECRET_A) } },
  });
  await prisma.channelConnection.update({
    where: { id: connBId },
    data: { isActive: true, secrets: { appSecret: encryptSecret(OWN_SECRET_B) } },
  });
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("webhook HMAC candidates", () => {
  it("includes the shared secret AND every account's own", async () => {
    const cands = await candidates();
    // Shared first: the overwhelmingly common case verifies on the first HMAC.
    expect(cands[0]).toBe(SHARED_SECRET);
    expect(cands).toContain(OWN_SECRET_A);
    // The old loader never produced this one — B's inbound was dropped forged.
    expect(cands).toContain(OWN_SECRET_B);
  });

  it("still verifies a sibling when the DEFAULT account is inactive", async () => {
    await prisma.channelConnection.update({
      where: { id: connAId },
      data: { isActive: false },
    });
    const cands = await candidates();
    expect(cands).toContain(OWN_SECRET_B);
    // Inactive accounts must not keep signing.
    expect(cands).not.toContain(OWN_SECRET_A);
  });

  it("survives an UNDECRYPTABLE secret on the default account", async () => {
    await prisma.channelConnection.update({
      where: { id: connAId },
      data: { secrets: { appSecret: "not-a-valid-envelope" } },
    });
    const cands = await candidates();
    // The old single try/catch returned null here — the whole channel went dark.
    expect(cands).toContain(SHARED_SECRET);
    expect(cands).toContain(OWN_SECRET_B);
    expect(cands).not.toContain(OWN_SECRET_A);
  });

  it("returns the shared secret even when NO account carries its own", async () => {
    for (const id of [connAId, connBId]) {
      await prisma.channelConnection.update({ where: { id }, data: { secrets: {} } });
    }
    const cands = await candidates();
    // The old `cipher === null` early-return skipped getMetaConnection entirely,
    // so a workspace signing purely with the shared app secret got nothing.
    expect(cands).toEqual([SHARED_SECRET]);
  });

  it("de-duplicates when an account sits on the shared app", async () => {
    await prisma.channelConnection.update({
      where: { id: connAId },
      data: { secrets: { appSecret: encryptSecret(SHARED_SECRET) } },
    });
    const cands = await candidates();
    expect(cands.filter((c) => c === SHARED_SECRET)).toHaveLength(1);
  });

  it("is null ONLY when there is no candidate at all", async () => {
    await setMetaConnectionSecret(null);
    for (const id of [connAId, connBId]) {
      await prisma.channelConnection.update({ where: { id }, data: { secrets: {} } });
    }
    invalidateProviderConfig(workspaceId);
    invalidateMetaConnection(workspaceId);
    expect(await getMetaWebhookConfig(workspaceId)).toBeNull();
  });
});
