/**
 * Message flags — per-message triage markers with an open → resolved/dismissed
 * lifecycle.
 *
 * Covers the paths where a regression is silent and expensive:
 *
 *   1. The full agent loop: flag a message from the bubble menu → chip appears
 *      → it shows in the /flags queue → resolve → it leaves the open queue.
 *   2. REALTIME convergence to a SECOND browser context — the whole feature is
 *      worthless if a teammate has to reload to see that a complaint was
 *      handled. Also covers the LRU chat-switch path (switch away and back),
 *      which is the classic stale-snapshot bug in this codebase.
 *   3. The audit trail, which the domain harness deliberately does NOT assert
 *      (the audit subscriber runs on the bus's detached BACKGROUND tier, so a
 *      bare non-Nest process can't observe it reliably). Two real bugs lived
 *      here: a metadata-only edit of a resolved flag wrote a SECOND "resolved"
 *      row, and a genuine reopen wrote none at all.
 *   4. The `?m=` deep-link anchor from the queue into the exact message.
 *   5. The "Flagged" inbox preset, including that it spans CLOSED threads.
 *
 * SAFE / self-cleaning: everything is created under the app-admin team with an
 * `e2e_mf_` prefix and removed in afterAll. No wipeTestData.
 */
import { test, expect, type Page } from "@playwright/test";
import { db, appAdmin } from "./_helpers/db";

test.describe.configure({ mode: "serial" });
// Dev-mode Next compiles routes lazily, so a first visit to /inbox or /flags
// can take tens of seconds on a cold worker. The assertions themselves are
// fast once painted — this ceiling only stops a compile from reading as a
// product failure.
test.setTimeout(120_000);

const PREFIX = "e2e_mf_";

let workspaceId: string;
let adminUserId: string;
let contactId: string;
let conversationId: string;
/** The message we flag — deliberately NOT the newest, so the `?m=` anchor has
 *  to actually scroll rather than landing on it by accident at the bottom. */
let targetMessageId: string;
let otherContactId: string;
let complaintId: string;

test.beforeAll(async () => {
  const admin = await appAdmin();
  workspaceId = admin.workspaceId;
  adminUserId = admin.userId;

  const contact = await db().contact.create({
    data: {
      workspaceId,
      name: `${PREFIX}Layla`,
      phoneNumber: `+99${Date.now().toString().slice(-10)}`,
      identityChannel: "whatsapp",
    },
  });
  contactId = contact.id;

  const conversation = await db().conversation.create({
    data: { workspaceId, contactId, channel: "whatsapp", status: "open" },
  });
  conversationId = conversation.id;

  // 40 messages, with the flagged one at index 12. Two constraints:
  //   - the thread hydration loads the most recent 30, so an index below 10
  //     would not be in the initial window at all (the bubble simply wouldn't
  //     exist, which is a different test);
  //   - it must be far enough from the bottom that a thread pinned to the
  //     bottom leaves it OFF-SCREEN, so "scrolled into view" is a real
  //     assertion rather than something that passes by accident.
  const base = Date.now() - 60 * 60 * 1000;
  for (let i = 0; i < 40; i++) {
    const msg = await db().message.create({
      data: {
        workspaceId,
        conversationId,
        externalId: `${PREFIX}${conversation.id}_${i}`,
        body:
          i === 12 ? `${PREFIX}the order arrived late again` : `${PREFIX}message ${i}`,
        direction: i % 2 === 0 ? "in" : "out",
        channel: "whatsapp",
        timestamp: new Date(base + i * 60_000),
      },
    });
    if (i === 12) targetMessageId = msg.id;
  }

  // A SECOND thread, so the LRU chat-switch test can switch away and back
  // entirely client-side (a page.goto would be a full reload, which never
  // touches the in-memory ThreadCache the test is actually about).
  const other = await db().contact.create({
    data: {
      workspaceId,
      name: `${PREFIX}Omar`,
      phoneNumber: `+98${Date.now().toString().slice(-10)}`,
      identityChannel: "whatsapp",
    },
  });
  otherContactId = other.id;
  const otherConv = await db().conversation.create({
    data: { workspaceId, contactId: other.id, channel: "whatsapp", status: "open" },
  });
  await db().message.create({
    data: {
      workspaceId,
      conversationId: otherConv.id,
      externalId: `${PREFIX}${otherConv.id}_0`,
      body: `${PREFIX}unrelated thread`,
      direction: "in",
      channel: "whatsapp",
      timestamp: new Date(base + 60 * 60_000),
    },
  });

  const complaint = await db().messageFlagDefinition.create({
    data: { workspaceId, name: `${PREFIX}Complaint`, color: "rose" },
  });
  complaintId = complaint.id;
  // A second definition so the "Flag as" submenu has more than one entry —
  // a one-item menu would pass even if the picker rendered the wrong list.
  await db().messageFlagDefinition.create({
    data: { workspaceId, name: `${PREFIX}Refund`, color: "amber" },
  });
});

test.afterAll(async () => {
  // Order matters: flags reference definitions with onDelete: Restrict.
  await db().messageFlag.deleteMany({ where: { workspaceId } });
  await db().messageFlagDefinition.deleteMany({
    where: { workspaceId, name: { startsWith: PREFIX } },
  });
  await db().conversation.deleteMany({
    where: { workspaceId, contactId: { in: [contactId, otherContactId] } },
  });
  await db().contact.deleteMany({
    where: { workspaceId, id: { in: [contactId, otherContactId] } },
  });
});

/**
 * Open the inbox on our seeded thread and wait for the bubbles to render.
 *
 * Retries once on the per-user rate limit. Every spec in this serial suite
 * drives the SAME admin account and a full inbox load costs ~10 API calls, so
 * a fast run legitimately trips the 300 req/min/user ceiling — the inbox then
 * renders its error boundary and no bubble ever appears. That's correct
 * product behaviour reacting to an artificial burst, not a defect, so the
 * accommodation belongs here rather than in a weakened rate limiter.
 */
async function openThread(page: Page): Promise<void> {
  const bubble = page.locator(`[data-message-id="${targetMessageId}"]`);
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(`/inbox?c=${conversationId}`);
    try {
      await expect(bubble).toBeVisible({ timeout: attempt === 0 ? 25_000 : 60_000 });
      return;
    } catch (err) {
      const rateLimited = await page
        .getByText(/rate_limited|too many requests/i)
        .count()
        .catch(() => 0);
      if (attempt === 1 || !rateLimited) throw err;
      // Token bucket is per MINUTE — wait for it to refill, then retry once.
      await page.waitForTimeout(15_000);
    }
  }
}

/**
 * Block until this page's Socket.io connection is live.
 *
 * Realtime specs that skip this are flaky by construction: a frame emitted
 * while the observer is still handshaking is simply never delivered, so the
 * assertion fails without anything being wrong with the fanout.
 */
async function waitForSocket(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      (window as unknown as { __ccpSocket?: { connected: boolean } }).__ccpSocket
        ?.connected === true,
    undefined,
    { timeout: 20_000 },
  );
  // `connected` is the TRANSPORT being up — the gateway still has to
  // authenticate the session and join the socket to `team:<id>` before a
  // team-scoped emit can reach it. There's no client-visible signal for that
  // join, and Socket.io never replays a frame sent during the gap, so a short
  // settle here is the difference between testing fanout correctness and
  // testing a handshake race.
  await page.waitForTimeout(750);
}

/** Raise a flag through the bubble's ⋯ menu — the real agent path. */
async function flagViaUi(page: Page, definitionName: string): Promise<void> {
  const bubble = page.locator(`[data-message-id="${targetMessageId}"]`);
  await bubble.hover();
  await bubble.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Flag as" }).click();
  await page.getByRole("menuitem", { name: definitionName }).click();
}

test("flag a message from the bubble menu, and the chip appears", async ({ page }) => {
  await openThread(page);
  await waitForSocket(page);
  await flagViaUi(page, `${PREFIX}Complaint`);

  // Assert the WRITE first, so a failure says which hop broke: no row means the
  // menu never fired the POST; a row with no chip means the realtime frame or
  // the reducer is at fault.
  await expect
    .poll(
      async () =>
        db().messageFlag.findFirst({
          where: { workspaceId, messageId: targetMessageId, definitionId: complaintId },
          select: { status: true, source: true, createdById: true },
        }),
      { timeout: 20_000 },
    )
    .toMatchObject({ status: "open", source: "human", createdById: adminUserId });

  // The chip is rendered from the message:flag SOCKET FRAME, not an optimistic
  // local write — so seeing it proves the realtime round-trip, not just that
  // the POST returned 200.
  await expect(
    page.locator(`[data-message-id="${targetMessageId}"]`).getByText(`${PREFIX}Complaint`),
  ).toBeVisible({ timeout: 20_000 });

  const conv = await db().conversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: { openFlagCount: true },
  });
  expect(conv.openFlagCount).toBe(1);
});

test("the chip survives a chat-switch round-trip (LRU cache path)", async ({ page }) => {
  await openThread(page);
  const chip = page
    .locator(`[data-message-id="${targetMessageId}"]`)
    .getByText(`${PREFIX}Complaint`);
  await expect(chip).toBeVisible({ timeout: 30_000 });

  // Switch away and back WITHIN the same page load. This is the whole point:
  // the inbox keeps an in-memory LRU of thread snapshots, and a per-thread
  // event wired into only the live hook (and not the cache shell) renders
  // correctly at first and then REVERTS on switch-back. A page.goto would
  // reload the app and re-hydrate from the server, which never exercises that
  // cache and would pass even with the bug present.
  await page.getByText(`${PREFIX}Omar`).first().click();
  await expect(
    page.locator(`[data-message-id="${targetMessageId}"]`),
  ).toBeHidden({ timeout: 20_000 });

  await page.getByText(`${PREFIX}Layla`).first().click();
  await expect(chip).toBeVisible({ timeout: 20_000 });
});

test("a teammate's resolve lands live in another browser, with no reload", async ({
  browser,
}) => {
  const ctxA = await browser.newContext({
    storageState: "tests/e2e/.auth/app-admin.json",
  });
  const ctxB = await browser.newContext({
    storageState: "tests/e2e/.auth/app-admin.json",
  });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  try {
    await openThread(pageA);
    await openThread(pageB);

    const chipA = pageA
      .locator(`[data-message-id="${targetMessageId}"]`)
      .getByText(`${PREFIX}Complaint`);
    const chipB = pageB
      .locator(`[data-message-id="${targetMessageId}"]`)
      .getByText(`${PREFIX}Complaint`);
    await expect(chipA).toBeVisible({ timeout: 15_000 });
    await expect(chipB).toBeVisible({ timeout: 15_000 });

    // Both sockets must be CONNECTED before the actor acts. Socket.io does not
    // replay a frame emitted while a client is still handshaking, so acting too
    // early makes the observer miss it and the test fail for a reason that has
    // nothing to do with fanout correctness. (This is how the spec first
    // "failed": B was still connecting.)
    await Promise.all([waitForSocket(pageA), waitForSocket(pageB)]);

    // A resolves via the chip menu.
    await chipA.click();
    await pageA.getByRole("menuitem", { name: "Mark resolved" }).click();

    // B must converge WITHOUT a reload. The resolved chip stays visible (the
    // record of "we handled this" is the point) but goes struck-through, so
    // assert on the DB + on B's own live state rather than on disappearance.
    await expect
      .poll(
        async () =>
          (
            await db().messageFlag.findFirstOrThrow({
              where: { workspaceId, messageId: targetMessageId, definitionId: complaintId },
              select: { status: true },
            })
          ).status,
        { timeout: 15_000 },
      )
      .toBe("resolved");

    // B's chip picks up the resolved styling from the socket frame.
    await expect(chipB.locator("xpath=ancestor::span[1]")).toHaveClass(
      /line-through/,
      { timeout: 15_000 },
    );

    // …and the counter went back to zero on both sides.
    await expect
      .poll(
        async () =>
          (
            await db().conversation.findUniqueOrThrow({
              where: { id: conversationId },
              select: { openFlagCount: true },
            })
          ).openFlagCount,
        { timeout: 10_000 },
      )
      .toBe(0);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test("the audit trail records each real lifecycle change exactly once", async ({
  request,
}) => {
  // Drive the API directly here — this is about the audit subscriber's mapping,
  // and the UI paths are covered above. Cookies come from the storageState.
  const existing = await db().messageFlag.findFirstOrThrow({
    where: { workspaceId, messageId: targetMessageId, definitionId: complaintId },
    select: { id: true, status: true },
  });
  expect(existing.status).toBe("resolved"); // left resolved by the previous spec

  const kindsNow = async () =>
    (
      await db().conversationEvent.findMany({
        where: {
          workspaceId,
          conversationId,
          kind: { in: ["flag_added", "flag_reopened", "flag_resolved", "flag_removed"] },
        },
        select: { kind: true },
      })
    ).reduce<Record<string, number>>((acc, r) => {
      acc[r.kind] = (acc[r.kind] ?? 0) + 1;
      return acc;
    }, {});

  // One `added` + one `resolved` from the specs above.
  await expect
    .poll(kindsNow, { timeout: 15_000 })
    .toMatchObject({ flag_added: 1, flag_resolved: 1 });

  // BUG 1: a metadata-only edit of an ALREADY-RESOLVED flag used to publish
  // `action: "resolved"` again — writing a second audit row and re-firing any
  // partner "complaint closed" automation for a change that closed nothing.
  const patch1 = await request.patch(`/api/message-flags/${existing.id}`, {
    data: { resolutionNote: `${PREFIX}refunded` },
  });
  expect(patch1.ok()).toBeTruthy();
  await new Promise((r) => setTimeout(r, 1500));
  expect(await kindsNow()).toMatchObject({ flag_added: 1, flag_resolved: 1 });

  // BUG 2: a genuine reopen used to publish `action: "updated"`, which the
  // audit subscriber skips — so the timeline still ended at "resolved" while
  // the flag was demonstrably open again in the queue.
  const patch2 = await request.patch(`/api/message-flags/${existing.id}`, {
    data: { status: "open" },
  });
  expect(patch2.ok()).toBeTruthy();
  await expect
    .poll(kindsNow, { timeout: 15_000 })
    .toMatchObject({ flag_added: 1, flag_resolved: 1, flag_reopened: 1 });
});

test("the /flags queue lists the open flag and resolving there clears it", async ({
  page,
}) => {
  await page.goto("/flags");

  const row = page.getByText(`${PREFIX}the order arrived late again`);
  // The queue fetches its rows client-side, so give it the same generous
  // window the rest of the suite uses for a first paint.
  await expect(row).toBeVisible({ timeout: 60_000 });

  // Resolve from the queue.
  await row.locator("xpath=ancestor::li[1]").getByRole("button", { name: "Mark resolved" }).click();

  // The row leaves the OPEN queue — driven by the socket frame, not a reload.
  await expect(row).toBeHidden({ timeout: 15_000 });

  // …and is findable under "Handled".
  await page.getByRole("button", { name: "Handled" }).click();
  await expect(
    page.getByText(`${PREFIX}the order arrived late again`),
  ).toBeVisible({ timeout: 15_000 });
});

test("the queue deep-links into the inbox anchored on the flagged message", async ({
  page,
}) => {
  // Re-open the flag so it's in the default queue view.
  const existing = await db().messageFlag.findFirstOrThrow({
    where: { workspaceId, messageId: targetMessageId, definitionId: complaintId },
    select: { id: true },
  });
  await db().messageFlag.update({
    where: { id: existing.id },
    data: { status: "open", resolvedAt: null, resolvedById: null },
  });
  await db().conversation.update({
    where: { id: conversationId },
    data: { openFlagCount: 1 },
  });

  await page.goto("/flags");
  const row = page.getByText(`${PREFIX}the order arrived late again`);
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.click();

  // Lands in the inbox on the right thread AND scrolled to the exact message.
  // The `?m=` param was silently ignored before this was wired — the thread
  // opened at the bottom and the agent had to hunt for what they'd clicked.
  await page.waitForURL(/\/inbox\?/, { timeout: 15_000 });
  const target = page.locator(`[data-message-id="${targetMessageId}"]`);
  await expect(target).toBeInViewport({ timeout: 15_000 });
});

test("the conversation panel has a Flags tab listing this thread's flags", async ({
  page,
}) => {
  // Re-open the flag so the tab has an OPEN item with actions on it.
  const existing = await db().messageFlag.findFirstOrThrow({
    where: { workspaceId, messageId: targetMessageId, definitionId: complaintId },
    select: { id: true },
  });
  await db().messageFlag.update({
    where: { id: existing.id },
    data: { status: "open", resolvedAt: null, resolvedById: null },
  });
  await db().conversation.update({
    where: { id: conversationId },
    data: { openFlagCount: 1 },
  });

  await openThread(page);
  await waitForSocket(page);

  // Flags is a TOP-LEVEL tab now, not a chip buried inside Files.
  const flagsTab = page.getByRole("tab", { name: /Flags/ });
  await expect(flagsTab).toBeVisible({ timeout: 30_000 });
  await flagsTab.click();

  // The flagged message is listed with its definition, scoped to THIS thread.
  await expect(
    page.getByText(`${PREFIX}the order arrived late again`).first(),
  ).toBeVisible({ timeout: 20_000 });

  // Resolving from the panel converges through the same socket frame.
  await page.getByRole("button", { name: "Mark resolved" }).first().click();
  await expect
    .poll(
      async () =>
        (
          await db().messageFlag.findFirstOrThrow({
            where: { id: existing.id },
            select: { status: true },
          })
        ).status,
      { timeout: 15_000 },
    )
    .toBe("resolved");
});

test("the /flags queue search narrows by message text and by contact", async ({
  page,
}) => {
  await page.goto("/flags");
  const search = page.getByRole("searchbox", { name: /Search flagged messages/i });
  await expect(search).toBeVisible({ timeout: 30_000 });

  // A term that matches nothing must empty the list — proves the query is
  // actually reaching the server rather than being ignored.
  await search.fill("zzz-no-such-flag-zzz");
  await expect(
    page.getByText(`${PREFIX}the order arrived late again`),
  ).toBeHidden({ timeout: 20_000 });

  // Searching by CONTACT name finds it again (the flag is resolved by now, so
  // look under Handled).
  await page.getByRole("button", { name: "Handled" }).click();
  await search.fill(`${PREFIX}Layla`);
  await expect(
    page.getByText(`${PREFIX}the order arrived late again`).first(),
  ).toBeVisible({ timeout: 20_000 });
});

test("the Flagged inbox preset finds the thread — even once it is CLOSED", async ({
  page,
}) => {
  // Establish the precondition explicitly rather than inheriting whatever the
  // previous test left behind — in a serial suite that coupling silently
  // inverts the moment a test is added or reordered.
  const existing = await db().messageFlag.findFirstOrThrow({
    where: { workspaceId, messageId: targetMessageId, definitionId: complaintId },
    select: { id: true },
  });
  await db().messageFlag.update({
    where: { id: existing.id },
    data: { status: "open", resolvedAt: null, resolvedById: null },
  });

  // Every other working preset excludes closed threads. Flagged deliberately
  // does not: an unresolved complaint on a thread someone closed is exactly
  // what must not fall off the radar.
  await db().conversation.update({
    where: { id: conversationId },
    data: { status: "closed", openFlagCount: 1 },
  });

  await page.goto("/inbox");
  await page.getByRole("button", { name: /^Flagged/ }).click();
  await expect(page.getByText(`${PREFIX}Layla`).first()).toBeVisible({
    timeout: 60_000,
  });

  // And the counterpart: a thread with NO open flag must not appear here.
  await db().messageFlag.updateMany({
    where: { workspaceId, conversationId },
    data: { status: "resolved" },
  });
  await db().conversation.update({
    where: { id: conversationId },
    data: { openFlagCount: 0 },
  });
  await page.reload();
  await page.getByRole("button", { name: /^Flagged/ }).click();
  await expect(page.getByText(`${PREFIX}Layla`)).toBeHidden({ timeout: 15_000 });
});
