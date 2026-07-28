/**
 * Legacy `wabaId = ""` templates must still reach Meta's analytics.
 *
 * `template_analytics` is a field on the WABA node, so a fetch needs an account
 * that can read the right catalog. A legacy row names no catalog, and the code
 * passed `null` straight into `getSendConfig` — which REFUSES on a multi-account
 * workspace (ACCOUNT_UNRESOLVED). The capture sweeper catches per-WABA and logs,
 * so the throw became a console line and the metrics expired unfetched at Meta's
 * ~7-day horizon. Permanent, silent loss.
 *
 * Two halves are pinned here:
 *   - resolve it whenever the answer is UNAMBIGUOUS (one number, or several
 *     numbers sharing one catalog) — this is the case for nearly every real
 *     workspace, and the accompanying migration stamps the rows outright;
 *   - when it genuinely IS ambiguous, fail with a reason that names the actual
 *     problem instead of "whatsapp_not_configured", which sends an admin to
 *     reconnect a perfectly healthy integration.
 *
 *   pnpm --filter @ccp/api exec vitest run test/template-analytics-legacy-waba.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setSharedDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto/envelope";
import { invalidateProviderConfig } from "@/lib/providers/config";
import { refreshTemplateAnalytics } from "@/lib/analytics/template-analytics";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `la${Date.now().toString().slice(-8)}`;
let orgId = "";

/** A workspace with `wabas.length` WhatsApp numbers on the given WABA ids. */
async function makeWorkspace(tag: string, wabas: string[]): Promise<string> {
  const workspaceId = (
    await prisma.workspace.create({
      data: { name: `LA ${tag} ${S}`, organizationId: orgId },
    })
  ).id;
  for (const [i, wabaId] of wabas.entries()) {
    await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: `${S}_${tag}_${i}`,
        wabaId,
        isDefault: i === 0,
        isActive: true,
        config: { phoneNumberId: `${S}_${tag}_${i}`, wabaId },
        secrets: { accessToken: encryptSecret("tok"), appSecret: encryptSecret("sec") },
      },
    });
  }
  invalidateProviderConfig(workspaceId);
  return workspaceId;
}

/** Attempt a legacy (`wabaId: null`) analytics refresh and report how it ended. */
async function legacyRefresh(workspaceId: string): Promise<{ error?: string }> {
  try {
    await refreshTemplateAnalytics(workspaceId, {
      templateExternalIds: [`${S}_ext`],
      start: new Date(Date.now() - 3 * 86_400_000),
      end: new Date(),
      wabaId: null,
    });
    return {};
  } catch (err) {
    const res = (err as { response?: { error?: string } })?.response;
    return { error: res?.error ?? (err as Error).message };
  }
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({ data: { name: `LA Org ${S}`, status: "active" } })
  ).id;
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("legacy \"\"-WABA analytics attribution", () => {
  it("resolves the sole account on a single-number workspace", async () => {
    const ws = await makeWorkspace("one", [`${S}_w1`]);
    const { error } = await legacyRefresh(ws);
    // It gets far enough to talk to Meta (which fails in this env) — the point
    // is that it is NOT refused before that for lack of an account.
    expect(error).not.toBe("whatsapp_not_configured");
    expect(error).not.toBe("template_waba_unresolved");
  });

  it("resolves when several numbers SHARE one catalog", async () => {
    // Two numbers, one WABA: they read identical analytics, so picking the
    // default is not a guess.
    const ws = await makeWorkspace("shared", [`${S}_w2`, `${S}_w2`]);
    const { error } = await legacyRefresh(ws);
    expect(error).not.toBe("whatsapp_not_configured");
    expect(error).not.toBe("template_waba_unresolved");
  });

  it("refuses with an HONEST reason when two catalogs are connected", async () => {
    const ws = await makeWorkspace("two", [`${S}_w3a`, `${S}_w3b`]);
    const { error } = await legacyRefresh(ws);
    // The old path surfaced ACCOUNT_UNRESOLVED as `whatsapp_not_configured`,
    // telling an admin to reconnect a healthy integration.
    expect(error).toBe("template_waba_unresolved");
    expect(error).not.toBe("whatsapp_not_configured");
  });
});
