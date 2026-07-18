/**
 * Sustained Meta rate limits must NOT manufacture failed recipients.
 *
 * THE OLD BEHAVIOUR: a rate-limited send got exactly one retry after ~3s. If
 * that also came back rate-limited, the recipient was marked **failed** —
 * permanently, from the operator's point of view. But a WhatsApp spam/quality
 * throttle can last ~30 minutes, and at broadcast pace that turns a temporary
 * limit into thousands of recipients recorded as undeliverable who were never
 * undeliverable at all. The only remedy was a Retry button that then re-sent
 * every one of them.
 *
 * THE NEW BEHAVIOUR: the recipient stays `queued` (its idempotency claim is
 * released so it re-sends cleanly) and the whole broadcast parks as `paused`
 * with `pausedReason: "rate_limited"`. The drift sweeper resumes it after a
 * cooldown, by which time the limit has cleared. Nothing is marked failed and
 * nothing is double-sent — the queued→sent CAS still guarantees exactly-once.
 *
 * This drives the REAL runner against the mock Graph, armed to return 130429
 * (per-second throughput) on every send.
 *
 * Runs against META_TEST_TEAM_ID because the runner needs a real WhatsApp
 * ChannelConnection pointed at the mock; it creates and deletes only its own
 * broadcast rows.
 */

import { test, expect } from "@playwright/test";

import { startBroadcast } from "../../../apps/api/src/lib/broadcast-runner";
import { setSharedDb } from "../../../apps/api/src/lib/db";
import { db, pollUntil } from "../_helpers/db";
import { seedMetaTestTeam, resetMock, META_TEST_TEAM_ID, GRAPH_MOCK_BASE } from "../_helpers/meta";

test.describe.configure({ mode: "serial" });

/** Meta's per-second throughput error — normalizes to `rate_limited`. */
const RATE_LIMIT_CODE = 130429;

let broadcastId: string | null = null;

/** Arm the mock to reject the next `count` sends with a Meta error `code`. */
async function armFailures(count: number, code: number): Promise<void> {
  const res = await fetch(`${GRAPH_MOCK_BASE}/__mock/fail-next-send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: 400, count, code }),
  });
  expect(res.status).toBe(200);
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  setSharedDb(db());
  await seedMetaTestTeam();
});

test.afterAll(async () => {
  test.setTimeout(60_000);
  await resetMock();
  if (broadcastId) {
    await db().broadcastRecipient.deleteMany({ where: { broadcastId } });
    await db().broadcast.deleteMany({ where: { id: broadcastId } });
  }
});

test("THE FIX: a sustained rate limit pauses the broadcast and leaves recipients queued", async () => {
  test.setTimeout(120_000);

  // Contacts to send to. Reuse whatever the meta test team already has so this
  // spec stays light; create a couple if it's empty.
  let contacts = await db().contact.findMany({
    where: { teamId: META_TEST_TEAM_ID, identityChannel: "whatsapp", deletedAt: null },
    select: { id: true },
    take: 2,
  });
  if (contacts.length < 2) {
    await db().contact.createMany({
      data: [0, 1].map((i) => ({
        teamId: META_TEST_TEAM_ID,
        name: `ratelimit-contact-${i}`,
        phoneNumber: `15558${String(i).padStart(6, "0")}`,
        identityChannel: "whatsapp" as const,
        source: "manual" as const,
      })),
      skipDuplicates: true,
    });
    contacts = await db().contact.findMany({
      where: { teamId: META_TEST_TEAM_ID, identityChannel: "whatsapp", deletedAt: null },
      select: { id: true },
      take: 2,
    });
  }
  expect(contacts.length).toBe(2);

  // Every send rate-limited, including the in-lane retry, so the branch under
  // test (retry ALSO rate-limited) is the one that fires.
  await armFailures(50, RATE_LIMIT_CODE);

  const b = await db().broadcast.create({
    data: {
      teamId: META_TEST_TEAM_ID,
      name: `ratelimit-${Date.now()}`,
      channel: "whatsapp",
      status: "queued",
      audienceMode: "selected",
      kind: "freeform",
      bodyText: "rate limit requeue probe",
      variables: {},
      totalCount: contacts.length,
    },
    select: { id: true },
  });
  broadcastId = b.id;
  await db().broadcastRecipient.createMany({
    data: contacts.map((c) => ({ broadcastId: b.id, contactId: c.id, status: "queued" as const })),
  });

  void startBroadcast(b.id);

  // Poll until it leaves `queued`/`running`, then assert on where it landed —
  // rather than polling for `paused` specifically. If the runner takes a
  // different branch, this reports WHICH one instead of an opaque timeout.
  const row = await pollUntil(
    async () => {
      const r = await db().broadcast.findUnique({
        where: { id: b.id },
        select: { status: true, pausedReason: true, failedCount: true, lastError: true },
      });
      return r && r.status !== "queued" && r.status !== "running" ? r : null;
    },
    { label: "broadcast reaches a terminal/paused state", timeoutMs: 60_000 },
  );
  const diag = await db().broadcastRecipient.findMany({
    where: { broadcastId: b.id },
    select: { status: true, errorMessage: true, errorCode: true },
  });
  expect(
    row.status,
    `unexpected terminal state (lastError=${row.lastError}) recipients=${JSON.stringify(diag)}`,
  ).toBe("paused");

  // Paused for the RIGHT reason — this is what tells auto-resume it's transient.
  expect(row.pausedReason).toBe("rate_limited");
  // The whole point: nothing was marked failed.
  expect(row.failedCount).toBe(0);

  const recipients = await db().broadcastRecipient.findMany({
    where: { broadcastId: b.id },
    select: { status: true },
  });
  expect(recipients.length).toBe(2);
  // Every recipient still queued — none burned into `failed` by a temporary
  // throttle. On resume they send normally.
  expect(recipients.every((r) => r.status === "queued")).toBe(true);
});

test("the idempotency claim is released, so a resumed recipient can re-send", async () => {
  // A retained claim would make the resumed send hit the "may have reached
  // Meta" abort branch and flip the recipient straight back to failed —
  // silently converting the requeue into the very failure it was avoiding.
  //
  // POLLED, not read once: the lane that trips the pause releases its claim
  // immediately, but a SIBLING lane can still be inside its ~3s rate-limit
  // backoff holding a claim it is about to release. Asserting instantly reads
  // that in-flight lane and fails on a state that resolves a moment later.
  const recipients = await db().broadcastRecipient.findMany({
    where: { broadcastId: broadcastId! },
    select: { id: true },
  });
  expect(recipients.length).toBeGreaterThan(0);
  const jobIds = recipients.map((r) => `bc-recipient-${r.id}`);

  await pollUntil(
    async () => {
      const held = await db().outboundSendAttempt.count({
        where: { jobId: { in: jobIds } },
      });
      return held === 0 ? true : null;
    },
    { label: "every rate-limited recipient's idempotency claim released", timeoutMs: 30_000 },
  );
});
