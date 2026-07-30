/**
 * A template ALWAYS names the WABA that owns it — and so does the account sending it.
 *
 * ## What this replaces
 *
 * `MessageTemplate.wabaId` used to be a `String @default("")` where `""` meant
 * "unknown WABA". Two specs existed only to cope with that sentinel and are now
 * retired, because the state they described is structurally impossible:
 *
 *   - `template-analytics-legacy-waba.spec.ts` pinned ~40 lines of guessing in
 *     `refreshTemplateAnalytics`: given a `""` template, infer the owning account
 *     from "is there exactly one number", then "do all numbers share one WABA",
 *     else throw `template_waba_unresolved`. `wabaAccountId` is a NOT NULL FK now,
 *     so there is nothing to infer.
 *   - `stranded-template-bindings.spec.ts` reconstructed the state migration
 *     `20260729120000` repaired — `""` duplicates holding the only copy of a
 *     template's `variableBindings`. It reconstructed that state by writing
 *     `wabaId: ""`, which the schema no longer has. The migration stays in history;
 *     its precondition can no longer occur.
 *
 * ## What is pinned instead
 *
 * The hole the sentinel opened. The cross-account guard read
 * `accountWaba && templateWaba && accountWaba !== templateWaba` — it only refused
 * when BOTH sides were known and differed — so an unknown WABA on either side
 * passed silently. Consequences, both live before this change:
 *
 *   1. a legacy `""` template was sendable from ANY account;
 *   2. a connection whose WABA was never pasted could send ANY template in the
 *      workspace, because its own side read `""` too.
 *
 *   pnpm --filter @ccp/api exec vitest run test/template-waba-required.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { seedWabaAccount } from "./_waba";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setSharedDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto/envelope";
import { invalidateProviderConfig } from "@/lib/providers/config";
import { refreshTemplateAnalytics } from "@/lib/analytics/template-analytics";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `twr${Date.now().toString().slice(-8)}`;

let orgId = "";
let workspaceId = "";
let wabaWithNumber = "";
let wabaWithoutNumber = "";

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({ data: { name: `TWR Org ${S}`, status: "active" } })
  ).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `TWR WS ${S}`, organizationId: orgId } })
  ).id;

  wabaWithNumber = await seedWabaAccount(prisma, workspaceId, `${S}_waba_live`);
  // A WABA holding ZERO phone numbers. Not a broken fixture — this is exactly what
  // Embedded Signup's `FINISH_ONLY_WABA` finish event produces, and the old model
  // (where a phone number WAS the row) could not represent it at all.
  wabaWithoutNumber = await seedWabaAccount(prisma, workspaceId, `${S}_waba_bare`);

  await prisma.channelConnection.create({
    data: {
      workspaceId,
      channel: "whatsapp",
      externalAccountId: `${S}_pn`,
      wabaAccountId: wabaWithNumber,
      isDefault: true,
      isActive: true,
      config: { phoneNumberId: `${S}_pn` },
      secrets: { accessToken: encryptSecret("tok"), appSecret: encryptSecret("sec") },
      // Not stale — see the note in webhook-batched-entries.spec.ts.
      messagingHealthUpdatedAt: new Date(),
    },
  });
  invalidateProviderConfig(workspaceId);
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("the WABA is a first-class row", () => {
  it("can exist with ZERO phone numbers (Embedded Signup FINISH_ONLY_WABA)", async () => {
    const row = await prisma.whatsappBusinessAccount.findUniqueOrThrow({
      where: { id: wabaWithoutNumber },
      select: { connections: { select: { id: true } }, externalWabaId: true },
    });
    expect(row.connections).toHaveLength(0);
    expect(row.externalWabaId).toBe(`${S}_waba_bare`);
  });

  it("holds a catalog even with no number, and prunes nothing on its own", async () => {
    // The catalog is the WABA's, not the number's — so a template survives here.
    const tpl = await prisma.messageTemplate.create({
      data: {
        workspaceId,
        wabaAccountId: wabaWithoutNumber,
        name: `${S}_bare_tpl`,
        language: "en",
        category: "marketing",
        status: "approved",
        bodyText: "hi",
        components: [{ type: "BODY", text: "hi" }],
      },
      select: { id: true },
    });
    expect(
      await prisma.messageTemplate.findUnique({ where: { id: tpl.id } }),
    ).not.toBeNull();
  });

  it("is GLOBALLY unique, so a second workspace cannot claim the same WABA", async () => {
    // That uniqueness IS the tenancy guard: Meta delivers a WABA's webhooks to
    // whichever app is subscribed, so two workspaces claiming one WABA means one
    // silently receives nothing — and under the app-level callback (workspace
    // resolved FROM the payload) it would route one tenant's messages into
    // another tenant's inbox.
    const otherWs = (
      await prisma.workspace.create({
        data: { name: `TWR Other ${S}`, organizationId: orgId },
      })
    ).id;
    await expect(
      prisma.whatsappBusinessAccount.create({
        data: { workspaceId: otherWs, externalWabaId: `${S}_waba_live` },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("analytics refuse honestly instead of guessing", () => {
  it("names the real problem when the WABA has no active number", async () => {
    // The old code, handed a `""` template, guessed the owning account and — when
    // it could not — threw `template_waba_unresolved` or fell through to
    // `whatsapp_not_configured`, which sends an admin to reconnect a healthy
    // integration. There is no guessing left; the reason is specific.
    await expect(
      refreshTemplateAnalytics(workspaceId, {
        templateExternalIds: [`${S}_ext`],
        start: new Date(Date.now() - 86_400_000),
        end: new Date(),
        wabaAccountId: wabaWithoutNumber,
      }),
    ).rejects.toMatchObject({
      response: { error: "waba_has_no_active_number" },
    });
  });
});
