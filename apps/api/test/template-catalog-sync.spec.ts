/**
 * Template catalog reconciliation.
 *
 * Two properties carry almost all the risk here, and both used to be violated:
 *
 *   1. **A sync is authoritative only for the WABA it fetched.** The prune step
 *      deletes local rows Meta no longer returns — scoped to the wrong set, it
 *      wipes another account's entire catalog, taking the `variableBindings` we
 *      own (and Meta cannot give back) with it.
 *   2. **A template Meta RETURNED is never treated as deleted.** The normalizer
 *      used to drop any row whose `status` or `category` it couldn't map, which
 *      made it indistinguishable from absent — so hitting the WABA template cap
 *      (`LIMIT_EXCEEDED`, a documented status) deleted templates out of the app.
 *
 * Both are silent, permanent data loss, which is why they get a DB-backed test
 * rather than a unit test over the pure parts.
 *
 *   pnpm --filter @ccp/api exec vitest run test/template-catalog-sync.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { setSharedDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto/envelope";
import { invalidateProviderConfig } from "@/lib/providers/config";
import type { ProviderTemplate } from "@ccp/shared/providers/types";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const S = `cs${Date.now().toString().slice(-8)}`;
const WABA_A = `waba_a_${S}`;
const WABA_B = `waba_b_${S}`;

let orgId = "";
let workspaceId = "";

/**
 * What the fake provider returns, keyed by the WABA being fetched. An `Error`
 * value makes that WABA's fetch throw, which is how "Graph is down for this one
 * account" is expressed.
 */
const catalogs = new Map<string, ProviderTemplate[] | Error>();

vi.mock("@/lib/providers", async () => {
  const actual = await vi.importActual<typeof import("@/lib/providers")>("@/lib/providers");
  return {
    ...actual,
    getMetaProvider: () => ({
      fetchTemplates: (config: { wabaId?: string }) => {
        const hit = catalogs.get(config.wabaId ?? "") ?? [];
        return hit instanceof Error ? Promise.reject(hit) : Promise.resolve(hit);
      },
    }),
  };
});

// Imported AFTER the mock so the module under test picks it up.
const { syncTemplateCatalog } = await import("@/lib/templates/catalog-sync");

const tpl = (over: Partial<ProviderTemplate> & { name: string }): ProviderTemplate => ({
  language: "en_US",
  category: "utility",
  status: "approved",
  bodyText: "Hi {{1}}",
  components: [{ type: "BODY", text: "Hi {{1}}" }],
  parameterFormat: "positional",
  ...over,
});

async function connectAccount(phoneNumberId: string, wabaId: string, isDefault: boolean) {
  await prisma.channelConnection.create({
    data: {
      workspaceId,
      channel: "whatsapp",
      externalAccountId: phoneNumberId,
      wabaId,
      isDefault,
      isActive: true,
      config: { phoneNumberId, wabaId },
      secrets: { accessToken: encryptSecret("test-token") },
    },
  });
  invalidateProviderConfig(workspaceId);
}

const rows = () =>
  prisma.messageTemplate.findMany({
    where: { workspaceId },
    orderBy: [{ wabaId: "asc" }, { name: "asc" }],
    select: {
      name: true,
      wabaId: true,
      status: true,
      category: true,
      correctCategory: true,
      qualityScore: true,
      qualityScoreAt: true,
      variableBindings: true,
    },
  });

beforeAll(async () => {
  setSharedDb(prisma as unknown as Parameters<typeof setSharedDb>[0]);
  orgId = (await prisma.organization.create({ data: { name: `CS Org ${S}`, status: "active" } })).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `CS ws ${S}`, organizationId: orgId } })
  ).id;
  await connectAccount(`pn_a_${S}`, WABA_A, true);
  await connectAccount(`pn_b_${S}`, WABA_B, false);
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("multi-WABA scoping", () => {
  it("syncs EVERY connected WABA, keying each template to its own", async () => {
    catalogs.set(WABA_A, [tpl({ name: `a_one_${S}` })]);
    catalogs.set(WABA_B, [tpl({ name: `b_one_${S}` })]);

    const out = await syncTemplateCatalog(workspaceId);
    expect(out.syncedCount).toBe(2);
    expect(out.failed).toEqual([]);

    const all = await rows();
    expect(all.map((r) => [r.wabaId, r.name])).toEqual([
      [WABA_A, `a_one_${S}`],
      [WABA_B, `b_one_${S}`],
    ]);
  });

  it("is idempotent — a second run neither duplicates nor prunes", async () => {
    // The `wabaId` the WHERE looks up must be the one the CREATE wrote, or the
    // upsert misses its own row and the insert collides on the unique key.
    const out = await syncTemplateCatalog(workspaceId);
    expect(out.prunedCount).toBe(0);
    expect(await rows()).toHaveLength(2);
  });

  it("NEVER prunes another WABA's catalog", async () => {
    // THE regression test. The old code fetched only the DEFAULT account's WABA
    // and then pruned every local row in the workspace whose (name, language)
    // wasn't in that one list — so a single Sync click deleted B's entire
    // catalog. Both templates are past the create-grace window, and each WABA
    // returns only its own, which is precisely the shape that used to lose B.
    catalogs.set(WABA_A, [tpl({ name: `a_one_${S}` })]);
    catalogs.set(WABA_B, [tpl({ name: `b_one_${S}` })]);
    await prisma.messageTemplate.updateMany({
      where: { workspaceId },
      data: { syncedAt: new Date(Date.now() - 600_000) },
    });

    const out = await syncTemplateCatalog(workspaceId);
    expect(out.prunedCount).toBe(0);
    expect((await rows()).map((r) => r.name).sort()).toEqual([`a_one_${S}`, `b_one_${S}`]);
  });

  it("leaves a WABA's rows alone when its fetch FAILS", async () => {
    catalogs.set(WABA_B, [tpl({ name: `b_two_${S}` })]);
    await syncTemplateCatalog(workspaceId);
    await prisma.messageTemplate.updateMany({
      where: { workspaceId },
      data: { syncedAt: new Date(Date.now() - 600_000) },
    });

    // A throws; its templates must survive rather than be read as "deleted".
    catalogs.set(WABA_A, new Error("graph 500"));
    const out = await syncTemplateCatalog(workspaceId);

    expect(out.failed.map((f) => f.wabaId)).toContain(WABA_A);
    const names = (await rows()).map((r) => r.name);
    expect(names).toContain(`a_one_${S}`);
  });
});

describe("unmappable fields", () => {
  it("keeps a template Meta returned with a status we don't map", async () => {
    // `LIMIT_EXCEEDED` normalizes to `status: null`. The row must survive the
    // prune with its stored status intact — dropping it deleted the template
    // AND the bindings we own.
    const target = `a_one_${S}`;
    await prisma.messageTemplate.updateMany({
      where: { workspaceId, name: target },
      data: {
        variableBindings: { body: [{ label: "First name", source: { kind: "manual" } }] },
        syncedAt: new Date(Date.now() - 600_000),
      },
    });

    catalogs.set(WABA_A, [tpl({ name: target, status: null })]);
    catalogs.set(WABA_B, [tpl({ name: `b_two_${S}` })]);
    await syncTemplateCatalog(workspaceId);

    const row = (await rows()).find((r) => r.name === target);
    expect(row).toBeDefined();
    // Stored status preserved, not guessed over.
    expect(row!.status).toBe("approved");
    expect(row!.variableBindings).toEqual({
      body: [{ label: "First name", source: { kind: "manual" } }],
    });
  });

  it("keeps a template whose CATEGORY we don't map", async () => {
    const target = `a_one_${S}`;
    await prisma.messageTemplate.updateMany({
      where: { workspaceId, name: target },
      data: { syncedAt: new Date(Date.now() - 600_000) },
    });
    catalogs.set(WABA_A, [tpl({ name: target, category: null })]);
    await syncTemplateCatalog(workspaceId);

    const row = (await rows()).find((r) => r.name === target);
    expect(row?.category).toBe("utility");
  });
});

describe("archival", () => {
  it("stamps the deletion countdown ONCE, on the transition into archived", async () => {
    const target = `a_one_${S}`;
    catalogs.set(WABA_A, [tpl({ name: target, status: "archived" })]);
    catalogs.set(WABA_B, [tpl({ name: `b_two_${S}` })]);
    await syncTemplateCatalog(workspaceId);

    const first = await prisma.messageTemplate.findFirst({
      where: { workspaceId, name: target },
      select: { status: true, archivedAt: true },
    });
    expect(first!.status).toBe("archived");
    expect(first!.archivedAt).not.toBeNull();

    // A later sync must NOT re-stamp it: Meta deletes 28 days after ARCHIVAL,
    // and pushing the timestamp forward on every sync would hide a template
    // that is about to be destroyed.
    await syncTemplateCatalog(workspaceId);
    const second = await prisma.messageTemplate.findFirst({
      where: { workspaceId, name: target },
      select: { archivedAt: true },
    });
    expect(second!.archivedAt?.getTime()).toBe(first!.archivedAt?.getTime());
  });

  it("clears the countdown when the template is unarchived", async () => {
    const target = `a_one_${S}`;
    // Unarchiving restores the previous status and cancels the deletion.
    catalogs.set(WABA_A, [tpl({ name: target, status: "approved" })]);
    await syncTemplateCatalog(workspaceId);

    const row = await prisma.messageTemplate.findFirst({
      where: { workspaceId, name: target },
      select: { status: true, archivedAt: true },
    });
    expect(row!.status).toBe("approved");
    expect(row!.archivedAt).toBeNull();
  });

  it("does NOT clear a live deadline when Meta reports an unmappable status", async () => {
    const target = `a_one_${S}`;
    catalogs.set(WABA_A, [tpl({ name: target, status: "archived" })]);
    await syncTemplateCatalog(workspaceId);

    // `status: null` = a value we don't map. It leaves the stored status alone,
    // so it must leave the archival deadline alone too — clearing it would make
    // an expiring template look safe.
    catalogs.set(WABA_A, [tpl({ name: target, status: null })]);
    await syncTemplateCatalog(workspaceId);

    const row = await prisma.messageTemplate.findFirst({
      where: { workspaceId, name: target },
      select: { status: true, archivedAt: true },
    });
    expect(row!.status).toBe("archived");
    expect(row!.archivedAt).not.toBeNull();
  });
});

describe("pending recategorization", () => {
  it("stores correct_category separately and clears it when it lands", async () => {
    const target = `a_one_${S}`;
    catalogs.set(WABA_A, [
      tpl({ name: target, category: "utility", correctCategory: "marketing" }),
    ]);
    await syncTemplateCatalog(workspaceId);

    let row = (await rows()).find((r) => r.name === target);
    // `category` stays the BILLED truth until Meta actually moves it.
    expect(row!.category).toBe("utility");
    expect(row!.correctCategory).toBe("marketing");

    // Meta applied the move: category catches up and the notice goes away.
    catalogs.set(WABA_A, [tpl({ name: target, category: "marketing", correctCategory: null })]);
    await syncTemplateCatalog(workspaceId);
    row = (await rows()).find((r) => r.name === target);
    expect(row!.category).toBe("marketing");
    expect(row!.correctCategory).toBeNull();
  });
});

describe("quality score", () => {
  it("stores the band and the date Meta computed it", async () => {
    const target = `a_one_${S}`;
    catalogs.set(WABA_A, [
      tpl({
        name: target,
        qualityScore: "RED",
        qualityScoreAt: new Date("2026-07-20T00:00:00.000Z"),
      }),
    ]);
    await syncTemplateCatalog(workspaceId);

    const row = (await rows()).find((r) => r.name === target);
    expect(row?.qualityScore).toBe("RED");
    expect(row?.qualityScoreAt?.toISOString()).toBe("2026-07-20T00:00:00.000Z");
  });

  it("leaves a stored band alone when Meta returns none", async () => {
    // The webhook is the FRESHER source: it fires the moment the band changes,
    // while a sync only reports what the list endpoint chose to include. A sync
    // that asked and got nothing must not wipe a band the webhook just wrote.
    const target = `a_one_${S}`;
    await prisma.messageTemplate.updateMany({
      where: { workspaceId, name: target },
      data: { qualityScore: "YELLOW", syncedAt: new Date(Date.now() - 600_000) },
    });

    catalogs.set(WABA_A, [tpl({ name: target })]);
    await syncTemplateCatalog(workspaceId);

    expect((await rows()).find((r) => r.name === target)?.qualityScore).toBe("YELLOW");
  });
});
