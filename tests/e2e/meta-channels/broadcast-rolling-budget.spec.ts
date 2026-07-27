/**
 * The rolling-24h messaging budget — the gap that let three campaigns each pass
 * a cap they collectively blew through.
 *
 * WhatsApp's messaging-limit tier is not a per-campaign cap. It is the number of
 * UNIQUE customers a number may message per **rolling 24 hours, across every
 * send**. The eligibility gate used to compare only `audienceSize > cap`, so on
 * a 100K-tier number three 40,000-recipient campaigns each passed (40k < 100k)
 * for a total of 120k — and Meta rejected the excess. Those rejections were then
 * bucketed as "retryable", so the report actively advised the operator to retry
 * into an already-exhausted budget. These tests reproduce that shape at
 * TIER_250, where the arithmetic is identical and the fixtures are 300 rows.
 *
 * These tests drive the REAL gate (`checkBroadcastEligibility`) against real
 * BroadcastRecipient rows, asserting the three states that matter:
 *   1. fresh window, audience fits            → allowed
 *   2. prior sends consumed most of the budget → BLOCKED, with the arithmetic
 *      spelled out in the reason
 *   3. those prior sends aged past 24h         → allowed again (it ROLLS)
 *
 * Also pins the dedup rule: a contact messaged by two campaigns inside the
 * window is ONE customer against the cap, not two.
 *
 * ISOLATION: creates its own throwaway team + WhatsApp connection so the seeded
 * send history can't perturb the other meta specs (a lesson from the 70k spec).
 */

import { test, expect } from "@playwright/test";

import { setSharedDb } from "../../../apps/api/src/lib/db";
import { checkBroadcastEligibility } from "../../../apps/api/src/lib/providers/meta-health";
import { createTestWorkspace, db } from "../_helpers/db";

test.describe.configure({ mode: "serial" });

const TEAM_ID = `e2e-budget-${Date.now()}`;
/**
 * TIER_250 → a 250 unique-customer rolling allowance. Deliberately the SMALLEST
 * tier that still exercises real arithmetic: the budget logic is identical at
 * 250 and at 100,000, and the large variant OOM-killed this box while proving
 * nothing extra. Scale lives in the 70k bind-limit spec instead.
 */
const CAP = 250;

const HOUR = 3_600_000;
/** Inside the 24h window. */
const RECENT = () => new Date(Date.now() - 2 * HOUR);
/** Outside the 24h window, but inside the 72h broadcast lookback — the case
 *  that proves the window rolls rather than just "any past send counts". */
const AGED = () => new Date(Date.now() - 30 * HOUR);

let contactIds: string[] = [];

/**
 * Seed a completed broadcast whose recipients were sent at `sentAt`.
 * Returns nothing — the gate reads them back through its own queries.
 */
async function seedSend(sentAt: Date, contacts: string[]): Promise<void> {
  const b = await db().broadcast.create({
    data: {
      workspaceId: TEAM_ID,
      name: `seeded-${sentAt.toISOString()}`,
      channel: "whatsapp",
      status: "completed",
      // Required, no default. These recipients are hand-seeded below, which is
      // exactly what "selected" means.
      audienceMode: "selected",
      totalCount: contacts.length,
      sentCount: contacts.length,
      variables: {},
    },
    select: { id: true },
  });
  await db().broadcastRecipient.createMany({
    data: contacts.map((contactId) => ({
      broadcastId: b.id,
      contactId,
      status: "sent" as const,
      deliveryState: "sent" as const,
      sentAt,
    })),
    skipDuplicates: true,
  });
}

/** Remove seeded send history so each test starts from a known budget. */
async function clearSends(): Promise<void> {
  await db().broadcast.deleteMany({ where: { workspaceId: TEAM_ID } });
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  // The domain layer reads through the shared `lib/db` handle that DbService
  // normally populates at Nest boot. This spec calls the gate directly rather
  // than over HTTP (the endpoint is session-guarded), so point that handle at
  // the test client. Requires --conditions=react-server, which the
  // `test:e2e:meta` script sets so `server-only` is inert here.
  setSharedDb(db());
  await createTestWorkspace({ id: TEAM_ID, name: "E2E Rolling Budget Team", status: "active" });
  // A TIER_250 WhatsApp connection. `messagingHealthUpdatedAt` must be set or
  // the gate treats the tier as unknown and stays advisory-only.
  await db().channelConnection.create({
    data: {
      channel: "whatsapp",
      config: {},
      secrets: {},
      // The 24h limit is PORTFOLIO-scoped now, so the tier/cap live there.
      portfolio: {
        create: {
          workspace: { connect: { id: TEAM_ID } },
          messagingTier: "TIER_250",
          messagingDailyCap: CAP,
          messagingHealthUpdatedAt: new Date(),
        },
      },
      workspace: { connect: { id: TEAM_ID } },
      externalAccountId: "e2e_budget_wa",
      isDefault: true,
      qualityRating: "GREEN",
      messagingHealthUpdatedAt: new Date(),
    },
  });
  await db().contact.createMany({
    data: Array.from({ length: 300 }, (_, i) => ({
      workspaceId: TEAM_ID,
      name: `budget-contact-${i}`,
      phoneNumber: `17775${String(i).padStart(6, "0")}`,
      identityChannel: "whatsapp" as const,
      source: "manual" as const,
    })),
  });
  contactIds = (
    await db().contact.findMany({ where: { workspaceId: TEAM_ID }, select: { id: true } })
  ).map((c) => c.id);
  expect(contactIds.length).toBe(300);
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  await db().broadcast.deleteMany({ where: { workspaceId: TEAM_ID } });
  await db().contact.deleteMany({ where: { workspaceId: TEAM_ID } });
  await db().channelConnection.deleteMany({ where: { workspaceId: TEAM_ID } });
  // Delete the ORG — it cascades to the workspace. Deleting only the workspace
  // leaves an orphan Organization behind on every run.
  await db().organization.deleteMany({ where: { workspaces: { some: { id: TEAM_ID } } } });
});

test("fresh window: an audience inside the cap is allowed, budget reported", async () => {
  await clearSends();
  const gate = await checkBroadcastEligibility(TEAM_ID, 100);
  expect(gate.allowed).toBe(true);
  expect(gate.recentUniqueRecipients).toBe(0);
  expect(gate.remainingDailyBudget).toBe(CAP);
});

test("THE FIX: a second campaign that fits the cap but NOT the remaining budget is blocked", async () => {
  await clearSends();
  // 200 unique customers already messaged 2h ago → 50 left of 250.
  await seedSend(RECENT(), contactIds.slice(0, 200));

  // 100 < 250, so the OLD gate allowed this. It must now be refused.
  const gate = await checkBroadcastEligibility(TEAM_ID, 100);
  expect(gate.allowed).toBe(false);
  expect(gate.exceedsCap).toBe(true);
  expect(gate.recentUniqueRecipients).toBe(200);
  expect(gate.remainingDailyBudget).toBe(50);
  // The reason must carry the arithmetic — an operator staring at a blocked
  // 100-person campaign needs to know 50 of them would be rejected.
  expect(gate.reason).toContain("200");
  expect(gate.reason).toContain("50");
});

test("an audience that fits the REMAINING budget still goes through", async () => {
  await clearSends();
  await seedSend(RECENT(), contactIds.slice(0, 200));
  const gate = await checkBroadcastEligibility(TEAM_ID, 50);
  expect(gate.allowed).toBe(true);
  expect(gate.remainingDailyBudget).toBe(50);
});

test("the window ROLLS: sends older than 24h free their budget again", async () => {
  await clearSends();
  // Same 200 customers, but messaged 30h ago — outside the rolling window
  // while still inside the 72h broadcast lookback, so this proves the sentAt
  // filter is doing the work rather than the lookback accidentally hiding them.
  await seedSend(AGED(), contactIds.slice(0, 200));
  const gate = await checkBroadcastEligibility(TEAM_ID, 100);
  expect(gate.allowed).toBe(true);
  expect(gate.recentUniqueRecipients).toBe(0);
  expect(gate.remainingDailyBudget).toBe(CAP);
});

test("unique CUSTOMERS, not sends: the same contact in two campaigns counts once", async () => {
  await clearSends();
  const overlap = contactIds.slice(0, 125);
  await seedSend(RECENT(), overlap);
  await seedSend(RECENT(), overlap); // same people, second campaign
  const gate = await checkBroadcastEligibility(TEAM_ID, 100);
  // 250 rows sent, but only 125 distinct customers against the cap.
  expect(gate.recentUniqueRecipients).toBe(125);
  expect(gate.remainingDailyBudget).toBe(125);
  expect(gate.allowed).toBe(true);
});

test("an audience larger than the whole cap is still refused on its own terms", async () => {
  await clearSends();
  const gate = await checkBroadcastEligibility(TEAM_ID, CAP + 1);
  expect(gate.allowed).toBe(false);
  expect(gate.exceedsCap).toBe(true);
  // The cap-overage message, not the budget one — a different remedy.
  expect(gate.reason).toContain("per 24h");
});

test("THE OVERLAP FIX: re-messaging the SAME contacts inside the window is allowed", async () => {
  await clearSends();
  // 200 already messaged 2h ago → 50 of the 250 cap left.
  const sent = contactIds.slice(0, 200);
  await seedSend(RECENT(), sent);

  // A follow-up to those SAME 200 people. Meta counts unique customers per
  // window, so they are already paid for and cost no additional allowance.
  // The old gate compared 200 > 50 and hard-refused a send Meta would accept.
  const gate = await checkBroadcastEligibility(TEAM_ID, sent.length, sent);
  expect(gate.allowed).toBe(true);
  expect(gate.recentUniqueRecipients).toBe(200);
});

test("a MIXED audience is charged only for the contacts new to the window", async () => {
  await clearSends();
  await seedSend(RECENT(), contactIds.slice(0, 200)); // 50 left of 250

  // 180 repeats (free) + 40 new = 40 against a remaining 50 → fits.
  const fits = [...contactIds.slice(0, 180), ...contactIds.slice(200, 240)];
  expect((await checkBroadcastEligibility(TEAM_ID, fits.length, fits)).allowed).toBe(true);

  // 180 repeats + 60 new = 60 against a remaining 50 → blocked on the NEW ones.
  const blocked = [...contactIds.slice(0, 180), ...contactIds.slice(200, 260)];
  const gate = await checkBroadcastEligibility(TEAM_ID, blocked.length, blocked);
  expect(gate.allowed).toBe(false);
  // The message must explain the overlap, or a blocked 240-person campaign
  // looks arbitrary when only 10 recipients are actually over the line.
  expect(gate.reason).toContain("already messaged in this window");
});

test("without ids the gate stays CONSERVATIVE (treats every recipient as new)", async () => {
  await clearSends();
  await seedSend(RECENT(), contactIds.slice(0, 200));
  // No ids → cannot compute overlap → assume all new → block. Erring toward a
  // block is safe; erring the other way would wave through a doomed send.
  const gate = await checkBroadcastEligibility(TEAM_ID, 200);
  expect(gate.allowed).toBe(false);
});

test("legacy customer-mode broadcasts do not consume the WhatsApp budget", async () => {
  await clearSends();
  // The omnichannel customer mode was REMOVED 2026-07-27 (creation rejects
  // it), but rows sent before the removal can still sit inside the 72h
  // lookback — seeded directly here, as only the DB can produce one now.
  // Those stored channel:"whatsapp" as an inert default while routing each
  // recipient to their best channel — counting them would charge
  // Messenger/Instagram deliveries against this portfolio and falsely block.
  const b = await db().broadcast.create({
    data: {
      workspaceId: TEAM_ID,
      name: "customer-mode",
      channel: "whatsapp",
      targetMode: "customer",
      status: "completed",
      audienceMode: "selected",
      variables: {},
      totalCount: 200,
      sentCount: 200,
    },
    select: { id: true },
  });
  await db().broadcastRecipient.createMany({
    data: contactIds.slice(0, 200).map((contactId) => ({
      broadcastId: b.id,
      contactId,
      status: "sent" as const,
      deliveryState: "sent" as const,
      sentAt: RECENT(),
    })),
  });
  const gate = await checkBroadcastEligibility(TEAM_ID, 100);
  expect(gate.recentUniqueRecipients).toBe(0);
  expect(gate.allowed).toBe(true);
});
