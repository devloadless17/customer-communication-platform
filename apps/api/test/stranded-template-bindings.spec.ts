/**
 * Migration `20260729120000_merge_stranded_template_bindings`.
 *
 * WHY THIS SPEC EXISTS. The migration fixes a state that no longer occurs in
 * dev (zero rows match), so running the migration proves nothing — it is a
 * no-op against every database I can reach. The only honest way to verify it is
 * to CONSTRUCT the stranded state and run the migration's own SQL against it.
 * The SQL below is read from the migration file rather than retyped, so a spec
 * that passes cannot be testing a different statement from the one that ships.
 *
 * THE STATE. `20260728120000` adopted legacy `wabaId = ''` templates into their
 * workspace's real WABA, and correctly refused to delete a `''` duplicate
 * carrying `variableBindings` — Meta cannot re-supply those. But its step 2 then
 * skipped those same rows, because the `(workspaceId, wabaId, name, language)`
 * slot they would move into was already taken by the live row. Result: the
 * bindings sit forever on a dead row while the live template has none, and the
 * workspace shows the template twice.
 *
 *   pnpm --filter @ccp/api exec vitest run test/stranded-template-bindings.spec.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestPrismaClient } from "./_prisma";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();

const MIGRATION = join(
  process.cwd(),
  "../../prisma/migrations/20260729120000_merge_stranded_template_bindings/migration.sql",
);

const S = `stb${Date.now().toString().slice(-8)}`;
const WABA = `${S}_waba`;
const BINDINGS = { "1": "contact.firstName", "2": "contact.company" };

let orgId = "";
let workspaceId = "";

/** Run the shipped migration, statement by statement. */
async function runMigration(): Promise<void> {
  const sql = readFileSync(MIGRATION, "utf8");
  const statements = sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  expect(statements.length, "the migration should carry the UPDATE and the DELETE").toBe(2);
  for (const stmt of statements) await prisma.$executeRawUnsafe(stmt);
}

async function seedTemplate(
  wabaId: string,
  name: string,
  bindings: object,
): Promise<string> {
  const row = await prisma.messageTemplate.create({
    data: {
      workspaceId,
      wabaId,
      name,
      language: "en",
      category: "marketing",
      status: "approved",
      components: [{ type: "BODY", text: "Hello {{1}}" }],
      variableBindings: bindings,
    },
    select: { id: true },
  });
  return row.id;
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `STB ${S}`, status: "active" } })).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `STB WS ${S}`, organizationId: orgId } })
  ).id;
}, 60_000);

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("merge stranded template bindings", () => {
  it("moves the bindings onto the live row and removes the orphan", async () => {
    const legacyId = await seedTemplate("", `${S}_promo`, BINDINGS);
    const liveId = await seedTemplate(WABA, `${S}_promo`, {});

    await runMigration();

    const live = await prisma.messageTemplate.findUnique({
      where: { id: liveId },
      select: { variableBindings: true, wabaId: true },
    });
    // The mappings Meta cannot re-supply now live on the row the composer sends
    // from and the catalog sync maintains.
    expect(live?.variableBindings).toEqual(BINDINGS);
    expect(live?.wabaId).toBe(WABA);

    // ...and the duplicate the workspace could see is gone.
    expect(await prisma.messageTemplate.findUnique({ where: { id: legacyId } })).toBeNull();
  });

  it("NEVER overwrites bindings the live row already has", async () => {
    const liveOwn = { "1": "contact.lastName" };
    const legacyId = await seedTemplate("", `${S}_keep`, BINDINGS);
    const liveId = await seedTemplate(WABA, `${S}_keep`, liveOwn);

    await runMigration();

    const live = await prisma.messageTemplate.findUnique({
      where: { id: liveId },
      select: { variableBindings: true },
    });
    // Someone configured these after the bad migration ran. Theirs wins.
    expect(live?.variableBindings).toEqual(liveOwn);
    expect(await prisma.messageTemplate.findUnique({ where: { id: legacyId } })).toBeNull();
  });

  it("LEAVES a legacy row that is the only copy of its template", async () => {
    // No live counterpart: this row still IS the template. Deleting it would
    // destroy it; it adopts its wabaId on the next catalog sync instead.
    const soleId = await seedTemplate("", `${S}_sole`, BINDINGS);

    await runMigration();

    const still = await prisma.messageTemplate.findUnique({
      where: { id: soleId },
      select: { wabaId: true, variableBindings: true },
    });
    expect(still, "a legacy row with no live counterpart must survive").not.toBeNull();
    expect(still?.wabaId).toBe("");
    expect(still?.variableBindings).toEqual(BINDINGS);
  });

  it("is idempotent — a second run changes nothing", async () => {
    const legacyId = await seedTemplate("", `${S}_idem`, BINDINGS);
    const liveId = await seedTemplate(WABA, `${S}_idem`, {});

    await runMigration();
    const after1 = await prisma.messageTemplate.findUnique({
      where: { id: liveId },
      select: { variableBindings: true },
    });
    await runMigration();
    const after2 = await prisma.messageTemplate.findUnique({
      where: { id: liveId },
      select: { variableBindings: true },
    });

    expect(after2?.variableBindings).toEqual(after1?.variableBindings);
    expect(await prisma.messageTemplate.findUnique({ where: { id: legacyId } })).toBeNull();
  });

  it("does not touch another workspace's templates", async () => {
    const otherOrg = await prisma.organization.create({
      data: { name: `STB other ${S}`, status: "active" },
    });
    const otherWs = await prisma.workspace.create({
      data: { name: `STB other WS ${S}`, organizationId: otherOrg.id },
    });
    const foreign = await prisma.messageTemplate.create({
      data: {
        workspaceId: otherWs.id,
        wabaId: "",
        name: `${S}_promo`, // SAME name/language as the merged pair above
        language: "en",
        category: "marketing",
        status: "approved",
        components: [{ type: "BODY", text: "Hello {{1}}" }],
        variableBindings: BINDINGS,
      },
      select: { id: true },
    });

    await runMigration();

    // It has no live counterpart IN ITS OWN workspace, so it must survive —
    // the join is workspace-scoped, not name-scoped.
    expect(
      await prisma.messageTemplate.findUnique({ where: { id: foreign.id } }),
    ).not.toBeNull();

    await prisma.organization.delete({ where: { id: otherOrg.id } }).catch(() => undefined);
  });
});
