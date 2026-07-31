/**
 * Template LABELS — the workspace's own organizational taxonomy over its
 * WhatsApp template catalog ("promo", "ramadan-2026").
 *
 * The properties that carry the risk:
 *
 *   1. **Labels are OURS and survive a catalog re-sync.** Like
 *      `variableBindings`, Meta cannot give them back — a reconcile that
 *      clobbered them would be silent, permanent data loss.
 *   2. **Case-insensitive identity, first-seen casing preserved.** "Promo" and
 *      "promo" are one label to the operator; a filter that matched exact-case
 *      would silently split the taxonomy.
 *   3. **`/v1` parity**: the list exposes `labels` + a `?label=` filter, the
 *      labels PATCH exists, and both stay scope-gated.
 *
 *   pnpm --filter @ccp/api exec vitest run test/template-labels.spec.ts
 */
import { existsSync, readFileSync } from "node:fs";

import { createTestPrismaClient } from "./_prisma";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { setSharedDb } from "@/lib/db";
import { seedWabaAccount } from "./_waba";
import { encryptSecret } from "@/lib/crypto/envelope";
import { invalidateProviderConfig } from "@/lib/providers/config";
import {
  normalizeTemplateLabels,
  templateIdsWithLabel,
} from "@/lib/templates/labels";
import { externalTemplate } from "@/lib/external-shapes";
import type { ProviderTemplate } from "@ccp/shared/providers/types";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();

const S = `tl${Date.now().toString().slice(-8)}`;
const WABA = `waba_${S}`;

let orgId = "";
let workspaceId = "";
let wabaAccountId = "";

/** Same fake-provider shape as template-catalog-sync.spec.ts. */
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

// Imported AFTER the mock so the modules under test pick it up.
const { syncTemplateCatalog } = await import("@/lib/templates/catalog-sync");
const { WhatsappService } = await import(
  "@/workspace-settings/whatsapp/whatsapp.service"
);
const { UpdateTemplateBindingsSchema } = await import(
  "@/workspace-settings/whatsapp/whatsapp.schemas"
);
const { ExternalTemplateListQuerySchema, ExternalUpdateTemplateLabelsSchema } =
  await import("@/external/v1/external-v1.schemas");

/** The real service with a no-op bus — labels don't need fanout assertions. */
const bus = { publish: vi.fn().mockResolvedValue(undefined) };
const whatsapp = new WhatsappService(
  prisma as unknown as ConstructorParameters<typeof WhatsappService>[0],
  bus as unknown as ConstructorParameters<typeof WhatsappService>[1],
);

const tpl = (over: Partial<ProviderTemplate> & { name: string }): ProviderTemplate => ({
  language: "en_US",
  category: "utility",
  status: "approved",
  bodyText: "Hi {{1}}",
  components: [{ type: "BODY", text: "Hi {{1}}" }],
  parameterFormat: "positional",
  ...over,
});

async function mkTemplate(name: string, labels: string[] = []) {
  return (
    await prisma.messageTemplate.create({
      data: {
        workspaceId,
        wabaAccountId,
        name,
        language: "en_US",
        status: "approved",
        category: "utility",
        bodyText: "hello",
        components: [{ type: "BODY", text: "hello" }],
        labels,
      },
      select: { id: true },
    })
  ).id;
}

beforeAll(async () => {
  setSharedDb(prisma as unknown as Parameters<typeof setSharedDb>[0]);
  orgId = (
    await prisma.organization.create({ data: { name: `TL Org ${S}`, status: "active" } })
  ).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `TL ws ${S}`, organizationId: orgId } })
  ).id;
  wabaAccountId = await seedWabaAccount(prisma, workspaceId, WABA);
  await prisma.channelConnection.create({
    data: {
      workspaceId,
      channel: "whatsapp",
      externalAccountId: `pn_${S}`,
      wabaAccountId,
      isDefault: true,
      isActive: true,
      config: { phoneNumberId: `pn_${S}` },
      secrets: { accessToken: encryptSecret("test-token") },
    },
  });
  invalidateProviderConfig(workspaceId);
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("validation + normalization", () => {
  it("dedupes case-insensitively, preserving FIRST-seen casing", () => {
    expect(normalizeTemplateLabels(["Promo", "promo", "PROMO", "support"])).toEqual([
      "Promo",
      "support",
    ]);
  });

  it("drops empty/whitespace entries after trimming", () => {
    expect(normalizeTemplateLabels(["  ramadan-2026  ", "   ", ""])).toEqual([
      "ramadan-2026",
    ]);
  });

  it("Zod refuses an over-long label, an over-full set, and an empty patch", () => {
    expect(
      UpdateTemplateBindingsSchema.safeParse({ labels: ["x".repeat(41)] }).success,
    ).toBe(false);
    expect(
      UpdateTemplateBindingsSchema.safeParse({
        labels: Array.from({ length: 21 }, (_, i) => `l${i}`),
      }).success,
    ).toBe(false);
    // Neither bindings nor labels = nothing to update.
    expect(UpdateTemplateBindingsSchema.safeParse({}).success).toBe(false);
    // Zod trims, so a padded 40-char label still passes.
    expect(
      UpdateTemplateBindingsSchema.safeParse({ labels: [`  ${"x".repeat(40)}  `] })
        .success,
    ).toBe(true);
  });
});

describe("PATCH persistence (internal service — the same writer /v1 uses)", () => {
  it("persists deduped labels and leaves variableBindings alone", async () => {
    const id = await mkTemplate(`patch_${S}`);
    await prisma.messageTemplate.update({
      where: { id },
      data: { variableBindings: { body: [{ label: "n", source: { kind: "manual" } }] } },
    });

    await whatsapp.updateTemplateBindings(workspaceId, id, {
      labels: ["Promo", "promo", "Ramadan-2026"],
    });

    const row = await prisma.messageTemplate.findUniqueOrThrow({
      where: { id },
      select: { labels: true, variableBindings: true },
    });
    expect(row.labels).toEqual(["Promo", "Ramadan-2026"]);
    // A labels-only patch must not touch the bindings.
    expect(row.variableBindings).toEqual({
      body: [{ label: "n", source: { kind: "manual" } }],
    });
  });

  it("404s a template of ANOTHER workspace (tenancy in the where)", async () => {
    const otherWs = await prisma.workspace.create({
      data: { name: `TL other ${S}`, organizationId: orgId },
      select: { id: true },
    });
    const id = await mkTemplate(`foreign_${S}`);
    await expect(
      whatsapp.updateTemplateBindings(otherWs.id, id, { labels: ["x"] }),
    ).rejects.toMatchObject({ response: { error: "template_not_found" } });
  });
});

describe("list filter by label", () => {
  // A label the other suites never use, so their rows can't bleed in here.
  it("matches case-insensitively across differently-cased rows", async () => {
    const a = await mkTemplate(`filter_a_${S}`, ["FltPromo"]);
    const b = await mkTemplate(`filter_b_${S}`, ["fltpromo", "flt-support"]);
    await mkTemplate(`filter_c_${S}`, ["flt-support"]);

    const ids = await templateIdsWithLabel(prisma, workspaceId, "FLTPROMO");
    expect(ids.sort()).toEqual([a, b].sort());
  });

  it("is tenant-scoped and exact (no substring match)", async () => {
    expect(await templateIdsWithLabel(prisma, `ws_not_${S}`, "fltpromo")).toEqual([]);
    // "fltprom" is not "fltpromo" — the filter is exact, only case folds.
    expect(await templateIdsWithLabel(prisma, workspaceId, "fltprom")).toEqual([]);
  });

  it("the internal list route threads the filter through", async () => {
    const out = await whatsapp.listTemplates(workspaceId, undefined, "fLtPrOmO");
    const names = out.templates.map((t) => t.name).sort();
    expect(names).toEqual([`filter_a_${S}`, `filter_b_${S}`].sort());
    // And every DTO carries its labels.
    expect(out.templates.every((t) => Array.isArray(t.labels))).toBe(true);
  });
});

describe("catalog sync never clobbers labels", () => {
  it("a reconcile UPDATE leaves labels untouched", async () => {
    const name = `sync_keep_${S}`;
    const id = await mkTemplate(name, ["Ramadan-2026", "promo"]);
    // Past the create-grace window so the row is fully reconciled, not spared.
    await prisma.messageTemplate.update({
      where: { id },
      data: { syncedAt: new Date(Date.now() - 600_000) },
    });

    // Meta returns the template (new body, new status) — the upsert's update
    // branch runs and must write explicit fields only.
    catalogs.set(WABA, [tpl({ name, status: "paused", bodyText: "changed {{1}}" })]);
    const out = await syncTemplateCatalog(workspaceId);
    expect(out.failed).toEqual([]);

    const row = await prisma.messageTemplate.findUniqueOrThrow({
      where: { id },
      select: { labels: true, status: true, bodyText: true },
    });
    // The sync DID reconcile the Meta-owned fields…
    expect(row.status).toBe("paused");
    expect(row.bodyText).toBe("changed {{1}}");
    // …and left ours alone.
    expect(row.labels).toEqual(["Ramadan-2026", "promo"]);
  });

  it("a resync-created row starts unlabeled (the column default)", async () => {
    const name = `sync_new_${S}`;
    catalogs.set(WABA, [tpl({ name: `sync_keep_${S}` }), tpl({ name })]);
    await syncTemplateCatalog(workspaceId);
    const row = await prisma.messageTemplate.findFirstOrThrow({
      where: { workspaceId, name },
      select: { labels: true },
    });
    expect(row.labels).toEqual([]);
  });
});

describe("/v1 parity", () => {
  it("the external wire shape carries labels verbatim", () => {
    const wire = externalTemplate({
      id: "t1",
      externalId: null,
      wabaAccount: { externalWabaId: WABA },
      name: "n",
      language: "en_US",
      category: "utility",
      correctCategory: null,
      status: "approved",
      statusReason: null,
      statusDetail: null,
      parameterFormat: "positional",
      messageSendTtlSeconds: null,
      bodyText: "hi",
      components: [],
      qualityScore: null,
      qualityScoreAt: null,
      linkTrackingOptedOut: null,
      labels: ["Promo", "support"],
      archivedAt: null,
      lastUsedAt: null,
      syncedAt: new Date(),
    });
    expect(wire.labels).toEqual(["Promo", "support"]);
  });

  it("the list query schema accepts ?label= and stays strict", () => {
    expect(
      ExternalTemplateListQuerySchema.safeParse({ label: "promo" }).success,
    ).toBe(true);
    expect(ExternalTemplateListQuerySchema.safeParse({ label: "" }).success).toBe(false);
    // `.strict()` — a typo'd param must not silently return the whole catalog.
    expect(
      ExternalTemplateListQuerySchema.safeParse({ label_: "promo" }).success,
    ).toBe(false);
  });

  it("the labels PATCH schema mirrors the internal bounds", () => {
    expect(
      ExternalUpdateTemplateLabelsSchema.safeParse({ labels: ["promo"] }).success,
    ).toBe(true);
    expect(ExternalUpdateTemplateLabelsSchema.safeParse({}).success).toBe(false);
    expect(
      ExternalUpdateTemplateLabelsSchema.safeParse({ labels: ["x".repeat(41)] })
        .success,
    ).toBe(false);
  });

  it("both /v1 template-label routes stay @RequireScope-gated", () => {
    // Source-shaped assertion, same approach as scripts/check-v1-docs.mjs:
    // ScopeGuard is permissive by default, so a decorator dropped in a refactor
    // silently opens the route to ANY valid key.
    // Path is cwd-relative (vitest runs from apps/api), like the sibling
    // source-shaped assertions in broadcast-tag-safety.spec.ts.
    const src = readFileSync("src/external/v1/external-v1.controller.ts", "utf8");
    const gated = (verb: string, path: string) =>
      new RegExp(
        `@${verb}\\("${path.replace(/[:/]/g, (c) => `\\${c}`)}"\\)\\s*\\n\\s*@RequireScope\\("[^"]+"\\)`,
      ).test(src);
    expect(gated("Get", "templates")).toBe(true);
    expect(gated("Patch", "templates/:id")).toBe(true);
  });
});
