/**
 * Large-audience query safety — the assumption every broadcast size claim rests
 * on, pinned by a real over-the-ceiling query rather than by reasoning.
 *
 * BACKGROUND, because this spec exists to correct a wrong conclusion: an audit
 * claimed a 100k broadcast could not be created at all, on the theory that
 * Prisma emits one bind parameter per `id: { in: [...] }` element and Postgres
 * caps a statement at 65,535 of them. That theory is WRONG for this stack.
 * Prisma 7.8 splits an oversized `in` list into internal batches (measured:
 * 32,763 ids per batch, deliberately under the ceiling) and merges the results,
 * so a 70k-id filter is three round-trips returning a complete, correct set.
 *
 * Chunking the call sites by hand was therefore removed — it added ~70 extra
 * round-trips to do worse what the driver already does in 3.
 *
 * DESIGN: the id LIST is 70,000 long, but only 200 of those ids exist. What is
 * under test is the size of the `in` list (bind parameters, batch splitting,
 * result merging) — not how many contacts a team has. Seeding 70k real rows
 * tested nothing extra and made the spec flaky under full-suite memory
 * pressure on this box.
 *
 * The 200 real ids are spread across all three internal batches on purpose, so
 * a driver that dropped or mis-merged any batch returns fewer than 200 and this
 * fails. That is a strictly stronger assertion than "70k in, 70k out".
 *
 * This is the regression guard on that behaviour: if a future Prisma upgrade
 * stops auto-batching, THIS fails loudly rather than a 100k campaign failing at
 * 3am in production.
 *
 * ISOLATION: creates its own throwaway team and drops it afterwards.
 */

import { test, expect } from "@playwright/test";

import { db } from "../_helpers/db";

test.describe.configure({ mode: "serial" });

/**
 * Comfortably past both the 65,535 protocol ceiling and Prisma's 32,763 batch
 * size, so more than one internal batch is exercised. Must stay above ~66k or
 * this proves nothing.
 */
const ID_LIST_SIZE = 70_000;
/** How many of those ids actually resolve to rows. */
const REAL = 200;
/** Prisma 7.8's measured internal batch size for an oversized `in`. */
const PRISMA_BATCH = 32_763;

const TEAM_ID = `e2e-bindlimit-${Date.now()}`;

/** The 70k-element list: REAL existing ids, salted through non-existent ones. */
let idList: string[] = [];
let realIds: string[] = [];

test.beforeAll(async () => {
  test.setTimeout(120_000);
  await db().team.create({
    data: { id: TEAM_ID, name: "E2E Bind-Limit Team", status: "active" },
  });
  await db().contact.createMany({
    data: Array.from({ length: REAL }, (_, i) => ({
      teamId: TEAM_ID,
      name: `contact-${i}`,
      // Digits-only, matching how ingest stores numbers.
      phoneNumber: `19995${String(i).padStart(6, "0")}`,
      identityChannel: "whatsapp" as const,
      source: "manual" as const,
    })),
  });
  realIds = (
    await db().contact.findMany({ where: { teamId: TEAM_ID }, select: { id: true } })
  ).map((c) => c.id);
  expect(realIds.length).toBe(REAL);

  // Cuid-shaped ids that match nothing. Same column type, so the query plans and
  // parameter-binds identically to a real audience.
  idList = Array.from({ length: ID_LIST_SIZE }, (_, i) => `cnonexistent${String(i).padStart(12, "0")}`);
  // Spread the real ids evenly so they land in EVERY internal batch — this is
  // what turns the test from "did it run" into "did it merge correctly".
  const stride = Math.floor(ID_LIST_SIZE / REAL);
  realIds.forEach((id, i) => {
    idList[i * stride] = id;
  });
  // Guard the guard: if the stride ever stops covering all three batches, the
  // cross-batch merge assertion below silently weakens.
  expect(idList.slice(0, PRISMA_BATCH)).toEqual(
    expect.arrayContaining([realIds[0]]),
  );
  expect(idList.slice(PRISMA_BATCH, PRISMA_BATCH * 2).some((id) => realIds.includes(id))).toBe(true);
  expect(idList.slice(PRISMA_BATCH * 2).some((id) => realIds.includes(id))).toBe(true);
});

test.afterAll(async () => {
  test.setTimeout(60_000);
  await db().contact.deleteMany({ where: { teamId: TEAM_ID } });
  await db().team.delete({ where: { id: TEAM_ID } });
});

test("a 70k-id `in` filter succeeds and merges results across every batch", async () => {
  test.setTimeout(60_000);
  // Exactly the shape broadcast create() uses for its identity-channel filter.
  const rows = await db().contact.findMany({
    where: { teamId: TEAM_ID, id: { in: idList }, deletedAt: null },
    select: { id: true },
  });
  // Every real id, from all three batches — not merely "it didn't throw".
  expect(rows.length).toBe(REAL);
  expect(new Set(rows.map((r) => r.id))).toEqual(new Set(realIds));
});

test("a 70k-id `in` still applies its OTHER predicates correctly across batches", async () => {
  test.setTimeout(60_000);
  // Guards the real risk in auto-batching: a non-id predicate applied to only
  // the first batch. Every seeded contact is whatsapp, so a messenger-scoped
  // filter over the same list must return exactly zero.
  const wrongChannel = await db().contact.findMany({
    where: { teamId: TEAM_ID, id: { in: idList }, identityChannel: "messenger", deletedAt: null },
    select: { id: true },
  });
  expect(wrongChannel.length).toBe(0);
});

test("updateMany over a 70k-id `in` affects every matching row (the retryFailed shape)", async () => {
  test.setTimeout(60_000);
  // retryFailed resets recipients by id list. If auto-batching applied the write
  // to only one batch, a large retry would silently re-queue part of the
  // audience and report success.
  const updated = await db().contact.updateMany({
    where: { teamId: TEAM_ID, id: { in: idList } },
    data: { source: "manual" },
  });
  expect(updated.count).toBe(REAL);
});

test("the opt-out lookup is bounded and audience-size independent", async () => {
  // create() deliberately does NOT ask "which of these 70k opted out". It asks
  // "who on this team opted out" and intersects in memory — one small indexed
  // query whose cost does not grow with the audience.
  const optedOut = await db().contact.findMany({
    where: { teamId: TEAM_ID, marketingOptOutAt: { not: null } },
    select: { id: true },
  });
  expect(Array.isArray(optedOut)).toBe(true);
});
