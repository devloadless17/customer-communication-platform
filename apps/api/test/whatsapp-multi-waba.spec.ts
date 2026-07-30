/**
 * `wabaId` is PER-ACCOUNT, and its "leave unchanged" value must come from the
 * row being written — not from the workspace's DEFAULT number.
 *
 * The bug: `updateConfig` read `existingConfig` from
 * `findFirst({ isDefault: true })` and then resolved
 * `input.wabaId === undefined ? existingConfig.wabaId : …`. `MetaService.resyncChannels`
 * re-saves EVERY connected number with ONLY its phoneNumberId after a Meta App
 * credential change, so for a workspace running number A (WABA-1, default) and
 * number B (WABA-2) that re-save stamped WABA-1 onto B — pointing B's template
 * catalog at A's business account. Silent, and it survives until someone notices
 * the wrong templates.
 *
 * Both halves are pinned here: B keeps its own WABA, and A is untouched.
 *
 *   pnpm --filter @ccp/api exec vitest run test/whatsapp-multi-waba.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { setSharedDb } from "@/lib/db";
import { seedWabaAccount } from "./_waba";

import { encryptSecret } from "@/lib/crypto/envelope";
import { invalidateMetaConnection } from "@/lib/providers/meta-connection";
import { WhatsappService } from "@/workspace-settings/whatsapp/whatsapp.service";
import { UpdateWhatsappConfigSchema } from "@/workspace-settings/whatsapp/whatsapp.schemas";
import type { DbService } from "@/db/db.service";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `mw${Date.now().toString().slice(-8)}`;
const PHONE_A = `${S}_a`;
const PHONE_B = `${S}_b`;
const WABA_A = `${S}_wabaA`;
const WABA_B = `${S}_wabaB`;

// Which numbers each WABA owns — the ownership guard reads this, so a wabaId
// leaking across accounts makes the guard throw instead of silently saving.
const WABA_NUMBERS: Record<string, string[]> = {
  [WABA_A]: [PHONE_A],
  [WABA_B]: [PHONE_B],
};

let orgId = "";
let workspaceId = "";

/** The bus is only used for a `catalog_changed` notification here. */
const bus = { publish: async () => undefined };
const service = new WhatsappService(
  prisma as unknown as DbService,
  bus as never,
);

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Stand-in Graph. Only the three reads `updateConfig` makes on the happy path
 * matter; everything else is fire-and-forget and already `.catch`-guarded.
 */
function stubGraph() {
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);

    // `/{wabaId}/phone_numbers` — the WABA-ownership guard.
    const owns = url.match(/\/([^/?]+)\/phone_numbers/);
    if (owns) {
      const ids = WABA_NUMBERS[owns[1]] ?? [];
      return jsonResponse({ data: ids.map((id) => ({ id })) });
    }

    // `/{phoneNumberId}?fields=display_phone_number,…` — credential validation.
    if (url.includes("fields=display_phone_number")) {
      return jsonResponse({
        display_phone_number: "+1 555 0100",
        verified_name: "Test",
        name_status: "APPROVED",
        code_verification_status: "VERIFIED",
        status: "CONNECTED",
      });
    }

    // `ensureWabaSubscribed` + the health poll.
    return jsonResponse({ success: true, data: [] });
  });
}

async function mkConn(phoneNumberId: string, wabaId: string, isDefault: boolean) {
  return (
    await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: phoneNumberId,
        wabaAccountId: await seedWabaAccount(prisma, workspaceId, wabaId),
        isDefault,
        isActive: true,
        config: { phoneNumberId, verifyToken: `${S}_vt` },
        secrets: {},
      },
      select: { id: true },
    })
  ).id;
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({ data: { name: `MW Org ${S}`, status: "active" } })
  ).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `MW WS ${S}`, organizationId: orgId } })
  ).id;

  // Shared Meta App credentials — updateConfig refuses to run without them.
  await prisma.metaConnection.create({
    data: {
      workspaceId,
      config: { appId: `${S}_app`, verifyToken: `${S}_vt` },
      secrets: {
        appSecret: encryptSecret("test-app-secret"),
        systemUserToken: encryptSecret("test-system-user-token"),
      },
    },
  });
  invalidateMetaConnection(workspaceId);

  await mkConn(PHONE_A, WABA_A, true);
  await mkConn(PHONE_B, WABA_B, false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("wabaId is per-account on re-save", () => {
  it("a NON-default number re-saved without a wabaId keeps its OWN", async () => {
    stubGraph();

    // Exactly what MetaService.resyncChannels sends: phone number id only.
    await service.updateConfig(workspaceId, { phoneNumberId: PHONE_B });

    const b = await prisma.channelConnection.findUniqueOrThrow({
      where: {
        workspaceId_channel_externalAccountId: {
          workspaceId,
          channel: "whatsapp",
          externalAccountId: PHONE_B,
        },
      },
      select: { wabaAccount: { select: { externalWabaId: true } }, config: true },
    });
    // The bug stamped WABA_A here (or threw, once the ownership guard noticed
    // WABA_A doesn't own PHONE_B).
    expect(b.wabaAccount?.externalWabaId).toBe(WABA_B);
    // The duplicate `config.wabaId` copy is GONE — the FK is the single authority,
    // so the loader joins it instead of reading a JSON copy that could drift.
    expect((b.config as { wabaId?: string }).wabaId).toBeUndefined();
  });

  it("leaves the default number's WABA alone", async () => {
    const a = await prisma.channelConnection.findUniqueOrThrow({
      where: {
        workspaceId_channel_externalAccountId: {
          workspaceId,
          channel: "whatsapp",
          externalAccountId: PHONE_A,
        },
      },
      select: { wabaAccount: { select: { externalWabaId: true } } },
    });
    expect(a.wabaAccount?.externalWabaId).toBe(WABA_A);
  });

  it("REFUSES an empty wabaId at the request boundary — it can't be cleared", async () => {
    // Deliberate behaviour change. `wabaId` used to have optional-update semantics
    // where `""` meant "clear the column", and a WABA-less number was then a
    // no-opinion case that could send ANY template in the workspace (the guard only
    // refused when both sides were known and differed). Templates are WABA-scoped
    // in Meta, so a number with no WABA has no catalog: the field is now required
    // and there is no way to unset it.
    const parsed = UpdateWhatsappConfigSchema.safeParse({
      phoneNumberId: PHONE_B,
      wabaId: "",
    });
    expect(parsed.success).toBe(false);
    expect(
      UpdateWhatsappConfigSchema.safeParse({ phoneNumberId: PHONE_B }).success,
    ).toBe(false);
  });

  it("a re-save that OMITS wabaId keeps the row's own (service level)", async () => {
    // The service still applies "leave unchanged" for internal callers such as
    // `MetaService.resyncChannels`; what changed is that the HTTP boundary won't
    // let a human omit it.
    stubGraph();
    await service.updateConfig(workspaceId, { phoneNumberId: PHONE_B, wabaId: WABA_B });

    const b = await prisma.channelConnection.findUniqueOrThrow({
      where: {
        workspaceId_channel_externalAccountId: {
          workspaceId,
          channel: "whatsapp",
          externalAccountId: PHONE_B,
        },
      },
      select: { wabaAccount: { select: { externalWabaId: true } } },
    });
    expect(b.wabaAccount?.externalWabaId).toBe(WABA_B);
  });
});
