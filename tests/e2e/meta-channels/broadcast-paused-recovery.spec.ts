/**
 * Paused-broadcast auto-recovery.
 *
 * A broadcast parks itself `paused` when its credentials are dead at fire time,
 * when the mid-run permanent-error breaker trips, or when a graceful shutdown
 * stops it mid-send. Until this change the ONLY thing that ever resumed one was
 * the boot reconciler — so a campaign paused at 2am sat dead until the next
 * deploy. For a 100k send that is hours of silent stall with no operator signal.
 *
 * `resumePausedBroadcasts` is now shared by the boot reconciler AND the drift
 * sweeper. These tests drive it directly and pin the four behaviours that make
 * it safe to run on a timer:
 *
 *   1. a paused row past the cooldown resumes (paused → queued)
 *   2. a row paused MORE RECENTLY than the cooldown is left alone — this is what
 *      stops a permanently-broken campaign spinning on its failure
 *   3. a paused row with NOTHING left to send is completed, not resumed (the
 *      "previous process sent everyone then died" case)
 *   4. already-sent recipients are never reset — resuming must not re-bill
 *
 * (4) is the one that matters most: template sends are billed and irreversible.
 *
 * ISOLATION: own throwaway team, dropped afterwards.
 */

import { test, expect } from "@playwright/test";

import { setSharedDb } from "../../../apps/api/src/lib/db";
import { resumePausedBroadcasts } from "../../../apps/api/src/lib/broadcast-runner";
import { createTestWorkspace, db } from "../_helpers/db";

test.describe.configure({ mode: "serial" });

const TEAM_ID = `e2e-paused-${Date.now()}`;
const HOUR = 3_600_000;

let contactIds: string[] = [];

/** Create a paused broadcast with the given recipient statuses. */
async function seedPaused(opts: {
  pausedAt: Date | null;
  statuses: Array<"queued" | "sent">;
  pausedReason?: string;
}): Promise<string> {
  const b = await db().broadcast.create({
    data: {
      workspaceId: TEAM_ID,
      name: `paused-${Math.random().toString(36).slice(2)}`,
      channel: "whatsapp",
      status: "paused",
      audienceMode: "selected",
      variables: {},
      pausedAt: opts.pausedAt,
      pausedReason: opts.pausedReason ?? null,
      totalCount: opts.statuses.length,
      sentCount: opts.statuses.filter((s) => s === "sent").length,
    },
    select: { id: true },
  });
  await db().broadcastRecipient.createMany({
    data: opts.statuses.map((status, i) => ({
      broadcastId: b.id,
      contactId: contactIds[i]!,
      status,
      ...(status === "sent"
        ? { deliveryState: "sent" as const, sentAt: new Date(), externalId: `wamid-${b.id}-${i}` }
        : {}),
    })),
  });
  return b.id;
}

async function statusOf(id: string): Promise<string> {
  const row = await db().broadcast.findUniqueOrThrow({
    where: { id },
    select: { status: true },
  });
  return row.status;
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  setSharedDb(db());
  await createTestWorkspace({ id: TEAM_ID, name: "E2E Paused Recovery Team", status: "active" });
  await db().contact.createMany({
    data: Array.from({ length: 10 }, (_, i) => ({
      workspaceId: TEAM_ID,
      name: `paused-contact-${i}`,
      phoneNumber: `16665${String(i).padStart(6, "0")}`,
      identityChannel: "whatsapp" as const,
      source: "manual" as const,
    })),
  });
  contactIds = (
    await db().contact.findMany({ where: { workspaceId: TEAM_ID }, select: { id: true } })
  ).map((c) => c.id);
  expect(contactIds.length).toBe(10);
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  await db().broadcast.deleteMany({ where: { workspaceId: TEAM_ID } });
  await db().contact.deleteMany({ where: { workspaceId: TEAM_ID } });
  // Delete the ORG — it cascades to the workspace. Deleting only the workspace
  // leaves an orphan Organization behind on every run.
  await db().organization.deleteMany({ where: { workspaces: { some: { id: TEAM_ID } } } });
});

test("THE FIX: a broadcast paused past the cooldown is resumed, not left dead", async () => {
  await seedPaused({
    pausedAt: new Date(Date.now() - 2 * HOUR),
    statuses: ["queued", "queued", "queued"],
  });
  const resumed = await resumePausedBroadcasts({
    pausedBefore: new Date(Date.now() - 10 * 60_000),
    workspaceId: TEAM_ID,
    label: "test",
  });
  // The return count IS the assertion: it only increments after the
  // paused→queued CAS succeeds and the row is handed to the runner.
  //
  // Deliberately NOT asserting the row's status here. The runner fires
  // immediately and, since this throwaway team has no real WhatsApp
  // credentials, re-parks the row as `paused` within milliseconds — which is
  // the intended cooldown loop, not a failure. Asserting `!== "paused"` made
  // this test pass alone and fail in the full suite, where a warm runner won
  // the race. Scoped to TEAM_ID so a fixture from another spec can't inflate it.
  expect(resumed).toBe(1);
});

test("a broadcast paused INSIDE the cooldown is left alone (no hot retry loop)", async () => {
  const id = await seedPaused({
    // Paused 1 minute ago — a still-broken cause would be retried every tick
    // without this guard.
    pausedAt: new Date(Date.now() - 60_000),
    statuses: ["queued", "queued"],
  });
  await resumePausedBroadcasts({
    pausedBefore: new Date(Date.now() - 10 * 60_000),
    workspaceId: TEAM_ID,
    label: "test",
  });
  expect(await statusOf(id)).toBe("paused");
});

test("a paused row with nothing left to send is COMPLETED, not resumed", async () => {
  const id = await seedPaused({
    pausedAt: new Date(Date.now() - 2 * HOUR),
    statuses: ["sent", "sent"],
  });
  await resumePausedBroadcasts({
    pausedBefore: new Date(Date.now() - 10 * 60_000),
    workspaceId: TEAM_ID,
    label: "test",
  });
  // Without this branch the row would flip to `queued` and stall forever with
  // zero queued recipients.
  expect(await statusOf(id)).toBe("completed");
});

test("SAFETY: resuming never resets an already-sent recipient (no re-bill)", async () => {
  const id = await seedPaused({
    pausedAt: new Date(Date.now() - 2 * HOUR),
    statuses: ["sent", "sent", "queued"],
  });
  const before = await db().broadcastRecipient.findMany({
    where: { broadcastId: id, status: "sent" },
    select: { id: true, externalId: true, sentAt: true },
    orderBy: { id: "asc" },
  });

  await resumePausedBroadcasts({
    pausedBefore: new Date(Date.now() - 10 * 60_000),
    workspaceId: TEAM_ID,
    label: "test",
  });

  const after = await db().broadcastRecipient.findMany({
    where: { broadcastId: id, status: "sent" },
    select: { id: true, externalId: true, sentAt: true },
    orderBy: { id: "asc" },
  });
  // Same rows, same Meta message ids, same timestamps — untouched. A regression
  // here would re-send a billed template to customers Meta already charged for.
  expect(after).toEqual(before);
  expect(after.length).toBe(2);
});

test("a NULL pausedAt (paused before the column existed) is treated as eligible", async () => {
  await seedPaused({ pausedAt: null, statuses: ["queued"] });
  const resumed = await resumePausedBroadcasts({
    pausedBefore: new Date(Date.now() - 10 * 60_000),
    workspaceId: TEAM_ID,
    label: "test",
  });
  // Same reasoning as the first test: count, not status — the runner may
  // already have re-parked the row by the time we could read it.
  expect(resumed).toBe(1);
});

test("a template-fatal pause is NOT auto-resumed by the SWEEPER (retrying only burns recipients)", async () => {
  const id = await seedPaused({
    pausedAt: new Date(Date.now() - 2 * HOUR),
    statuses: ["queued", "queued"],
    pausedReason: "template",
  });
  const resumed = await resumePausedBroadcasts({
    pausedBefore: new Date(Date.now() - 10 * 60_000),
    workspaceId: TEAM_ID,
    skipTemplatePauses: true, // what the sweeper passes
    label: "test",
  });
  // The template is disabled at Meta; only an operator can fix that. Each
  // auto-retry would burn another PERMANENT_ERROR_PAUSE_THRESHOLD recipients
  // into \ for nothing, so this cause must stay parked until Retry.
  expect(resumed).toBe(0);
  expect(await statusOf(id)).toBe("paused");
});

test("a rate-limit pause IS auto-resumed — that cause clears on its own", async () => {
  await seedPaused({
    pausedAt: new Date(Date.now() - 2 * HOUR),
    statuses: ["queued"],
    pausedReason: "rate_limited",
  });
  const resumed = await resumePausedBroadcasts({
    pausedBefore: new Date(Date.now() - 10 * 60_000),
    workspaceId: TEAM_ID,
    // Sweeper semantics: the template row seeded by the previous test must be
    // skipped, leaving exactly this rate-limited one.
    skipTemplatePauses: true,
    label: "test",
  });
  // Waiting IS the fix here, so resuming after the cooldown is exactly right.
  expect(resumed).toBe(1);
});

test("REGRESSION: BOOT still resumes a template pause — excluding it everywhere strands it forever", async () => {
  await seedPaused({
    pausedAt: new Date(Date.now() - 2 * HOUR),
    statuses: ["queued"],
    pausedReason: "template",
  });
  // Boot passes no `skipTemplatePauses`. This matters because `retryFailed`
  // CASes on status IN ('completed','failed','canceled') and there is no resume
  // route — so if BOTH callers skipped template pauses, a template-paused
  // broadcast could never be released by any code path or operator action, and
  // its queued recipients would sit forever.
  const resumed = await resumePausedBroadcasts({ workspaceId: TEAM_ID, label: "test" });
  expect(resumed).toBeGreaterThanOrEqual(1);
});
