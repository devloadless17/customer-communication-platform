import { existsSync } from "node:fs";

import { createTestPrismaClient } from "./_prisma";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * A super admin is a platform OPERATOR, not a tenant.
 *
 * They oversee every organization and belong to none — but `User.organizationId`
 * is required, so the seed hangs the operator off an anchor org. That row is an
 * artifact of the foreign key. It was being rendered in the platform console as
 * a customer ("Loadless", one workspace nested under it, sitting beside real
 * organizations) and counted in the platform's own totals, which is the opposite
 * of what the console is for.
 *
 * `Organization.isPlatform` marks it. These are the three places it must never
 * appear, asserted against the real database because the whole failure mode is a
 * `where` clause that compiles clean and doesn't filter (Prisma's XOR unions
 * defeat excess-property checking — see [[prisma-where-not-typechecked]]).
 *
 *   pnpm --filter @ccp/api exec vitest run test/platform-anchor-org.spec.ts
 */

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();

const S = `pa${Date.now().toString().slice(-8)}`;
let anchorOrgId = "";
let anchorWorkspaceId = "";
let customerOrgId = "";

beforeAll(async () => {
  const anchor = await prisma.organization.create({
    data: { name: `${S} anchor`, status: "active", isPlatform: true },
    select: { id: true },
  });
  anchorOrgId = anchor.id;
  const ws = await prisma.workspace.create({
    data: { name: `${S} anchor ws`, organizationId: anchorOrgId },
    select: { id: true },
  });
  anchorWorkspaceId = ws.id;

  // A real customer, to prove the filter excludes ONLY the anchor rather than
  // quietly emptying the console.
  const customer = await prisma.organization.create({
    data: { name: `${S} customer`, status: "active" },
    select: { id: true },
  });
  customerOrgId = customer.id;
});

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { organizationId: anchorOrgId } });
  await prisma.organization.deleteMany({
    where: { id: { in: [anchorOrgId, customerOrgId] } },
  });
  await prisma.$disconnect();
});

describe("the platform anchor is not a customer organization", () => {
  it("is absent from the console's organization list", async () => {
    const listed = await prisma.organization.findMany({
      where: { isPlatform: false },
      select: { id: true },
    });
    const ids = listed.map((o) => o.id);
    expect(ids, "the anchor must not be listed").not.toContain(anchorOrgId);
    expect(ids, "real customers must still be listed").toContain(customerOrgId);
  });

  it("is excluded from the platform's own totals", async () => {
    // Counting the anchor inflates "how many organizations are on the platform"
    // by one, permanently — the operator would always see one phantom customer.
    //
    // Scoped to THIS SPEC'S OWN ROWS. The earlier form counted the whole table
    // (`all - scoped === 1`), which asserts a global property of the database:
    // "exactly one platform org exists anywhere". That is true only on a
    // database with no seeded anchor and no debris — it passed locally and went
    // red in CI, where `db:seed` creates the real anchor, and it had already
    // flaked once against a suite that OOM'd and left `pa*` rows behind. The
    // property under test is the FILTER, not the table's contents: among the two
    // rows this spec created, exactly the anchor must be excluded. That still
    // catches the real defect (a `where` that compiles but doesn't filter would
    // make `scoped` 2), and it no longer depends on what else lives in the DB.
    const ours = { id: { in: [anchorOrgId, customerOrgId] } };
    const [scoped, all] = await Promise.all([
      prisma.organization.count({ where: { isPlatform: false, ...ours } }),
      prisma.organization.count({ where: ours }),
    ]);
    expect(all, "both of this spec's orgs must exist").toBe(2);
    expect(scoped, "the anchor must be filtered out, the customer kept").toBe(1);
  });

  it("has no reachable workspace detail page", async () => {
    // The console never links there (its org isn't listed), but the URL is
    // guessable, so the query itself excludes it.
    const reachable = await prisma.workspace.findFirst({
      where: { id: anchorWorkspaceId, organization: { isPlatform: false } },
      select: { id: true },
    });
    expect(reachable).toBeNull();

    // …and the guard is specific: a customer's workspace still resolves.
    const customerWs = await prisma.workspace.create({
      data: { name: `${S} customer ws`, organizationId: customerOrgId },
      select: { id: true },
    });
    const ok = await prisma.workspace.findFirst({
      where: { id: customerWs.id, organization: { isPlatform: false } },
      select: { id: true },
    });
    expect(ok?.id).toBe(customerWs.id);
    await prisma.workspace.delete({ where: { id: customerWs.id } });
  });

  it("defaults to false, so a normal signup is never hidden", async () => {
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: customerOrgId },
      select: { isPlatform: true },
    });
    expect(org.isPlatform).toBe(false);
  });
});
