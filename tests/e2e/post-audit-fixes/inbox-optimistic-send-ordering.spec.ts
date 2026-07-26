import { test, expect, type Page, type Route } from "@playwright/test";
import { Prisma } from "@prisma/client";

import { appAdmin, db, wipeTestData } from "../_helpers/db";

/**
 * Outbound-send ordering: the two glitches reported 2026-06-16.
 *
 *   Symptom 1 — replying with AI Autopilot on: the "paused AI Autopilot" pill
 *               flashed ABOVE the just-sent bubble, then snapped below once the
 *               send reconciled (the server's auto-pause log arrives a round-trip
 *               later, unpinned, while the send is still optimistically pinned).
 *   Symptom 2 — rapid sends: an OUT-OF-ORDER message:new (send #3 confirming
 *               before #1/#2) un-pinned #3 to its server time and flashed it
 *               above the still-pending #1/#2, then snapped back.
 *
 * The fix: optimistic own-sends + the optimistic auto-pause pill carry a shared
 * monotonic `optimisticSeq`; the timeline keeps a reconciled own-send (and the
 * pill) pinned to the bottom IN SEND ORDER until every earlier-seq sibling also
 * confirms — so no row ever changes index (no jump).
 *
 * Local stack has no Meta creds, so a real POST /api/messages can't complete the
 * round-trip. We intercept it: fulfill 200 (so the optimistic paint survives) and
 * capture the client-generated `clientTempId`; then inject the matching server
 * `message.sent` OutboundEvent ourselves (drainer → message:new with that
 * clientTempId → reconcile), which lets us drive reconcile TIMING and ORDER and
 * assert no transient reorder via the same findReorder vibration detector the
 * sibling ordering spec uses.
 */

let workspaceId: string;
let userId: string;
// Set per-test by freshConversation() — each test gets an isolated thread so the
// heavy inject/drain load of one test can't slow another's initial render.
let contactId: string;
let conversationId: string;
let convSeq = 0;

interface Entry {
  kind: string | null;
  id: string | null;
  pending: boolean;
  label: string;
  ts: string | null;
}

async function snapshot(page: Page): Promise<Entry[]> {
  return page.$$eval("[data-entry-kind]", (els) =>
    els.map((el) => ({
      kind: el.getAttribute("data-entry-kind"),
      id: el.getAttribute("data-entry-id"),
      pending: el.getAttribute("data-pending") === "1",
      label: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
      ts: el.getAttribute("data-entry-ts"),
    })),
  );
}

async function sampleOver(page: Page, ms: number, intervalMs = 50): Promise<Entry[][]> {
  const samples: Entry[][] = [];
  const deadline = Date.now() + ms;
  samples.push(await snapshot(page));
  while (Date.now() < deadline) {
    await page.waitForTimeout(intervalMs);
    samples.push(await snapshot(page));
  }
  return samples;
}

/** Any existing entry that changes index between samples is a reorder/jump. */
function findReorder(samples: Entry[][]): string | null {
  const indexById = new Map<string, number>();
  for (let s = 0; s < samples.length; s++) {
    const order = samples[s]!;
    for (let i = 0; i < order.length; i++) {
      const id = order[i]!.id;
      if (!id) continue;
      const seen = indexById.get(id);
      if (seen === undefined) indexById.set(id, i);
      else if (seen !== i)
        return `entry ${id} ("${order[i]!.label}") moved ${seen}→${i} at sample ${s}`;
    }
  }
  return null;
}

async function openThread(page: Page): Promise<void> {
  await page.goto(`/inbox?c=${conversationId}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-entry-kind]").first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(600);
}

/**
 * Intercept POST /api/messages: fulfill 200 (so the optimistic bubble survives
 * instead of flipping failed on the local 409) and record body→clientTempId so
 * the test can inject the matching server confirmation later. Returns the live
 * map. The body is double-read safe: postDataJSON parses the JSON body.
 */
async function interceptSends(page: Page): Promise<Map<string, string>> {
  const byBody = new Map<string, string>();
  await page.route("**/api/messages", async (route: Route) => {
    if (route.request().method() !== "POST") return route.continue();
    let parsed: { body?: string; clientTempId?: string } = {};
    try {
      parsed = route.request().postDataJSON() ?? {};
    } catch {
      /* non-JSON (media multipart) — not used by these tests */
    }
    if (parsed.body && parsed.clientTempId) byBody.set(parsed.body, parsed.clientTempId);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
  return byBody;
}

/**
 * Inject a server-confirmed outbound message exactly like a real send's
 * `message.sent` would: a Message row + a `message.sent` OutboundEvent carrying
 * the client's `clientTempId`. The drainer republishes it → message:new with
 * that clientTempId → the open thread reconciles its optimistic bubble in place.
 * `atMs` is the server timestamp (controls final chronological order).
 */
async function injectOutboundSent(opts: {
  body: string;
  clientTempId: string;
  atMs: number;
}): Promise<void> {
  const externalId = `e2e-out-${opts.atMs}-${Math.floor(opts.atMs % 1_000_000)}`;
  const ts = new Date(opts.atMs);
  const msg = await db().message.create({
    data: {
      workspaceId,
      conversationId,
      externalId,
      direction: "out",
      channel: "whatsapp",
      status: "sent",
      body: opts.body,
      timestamp: ts,
      senderUserId: userId,
      rawPayload: {},
    },
  });
  await db().outboundEvent.create({
    data: {
      workspaceId,
      type: "message.sent",
      payload: {
        workspaceId,
        conversationId,
        contactId,
        message: {
          id: msg.id,
          workspaceId,
          conversationId,
          externalId,
          direction: "out",
          channel: "whatsapp",
          status: "sent",
          body: opts.body,
          timestamp: ts.toISOString(),
          senderUserId: userId,
          rawPayload: {},
        },
        preview: opts.body.slice(0, 200),
        senderUserId: userId,
        lastMessageAt: ts.toISOString(),
        unreadCount: 0,
        clientTempId: opts.clientTempId,
        silent: true,
        skipOutboundWebhook: true,
      },
    },
  });
}

/**
 * Inject the authoritative conversation activity event the server's
 * autoAssignOnAgentSend writes on a human reply (assigned / status_changed) — an
 * OutboundEvent the real drainer publishes, so the AUDIT subscriber writes the
 * ConversationEvent row AND the fanout emits the conversation:assigned/status
 * frame. That frame makes the open thread run GET /events and reconcile its
 * optimistic pill IN PLACE (mergeAuthoritativeEvents pairs stub→row by semantic
 * signature, carries the stub's optimisticSeq onto the settled row). Inject
 * `assigned` BEFORE `status_changed` so the audit-row `at` lands assigned <
 * reopened — the OPPOSITE of the optimistic send-order seq (reopen < assign),
 * i.e. the exact racy clock order that pre-fix made the two pills SWAP (vibrate)
 * the instant they un-pinned. `silent`/`skipOutboundWebhook` keep workflow +
 * outbound-webhook subscribers out; audit + realtime fanout ignore those flags
 * and still run (per the bus tiering).
 */
async function injectConversationEvent(
  type:
    | "conversation.assigned"
    | "conversation.status_changed"
    | "conversation.ai_changed",
  extra: Record<string, unknown>,
): Promise<void> {
  await db().outboundEvent.create({
    data: {
      workspaceId,
      type,
      payload: {
        workspaceId,
        conversationId,
        changedByUserId: userId,
        silent: true,
        skipOutboundWebhook: true,
        ...extra,
      },
    },
  });
}

/**
 * Inject the FULL auto-claim trio's authoritative audit rows the way
 * autoAssignOnAgentSend writes them on a human reply into an unassigned + non-open
 * + AI-on chat: ai_paused, then assigned, then status_changed (reopened). The
 * inject ORDER controls the audit `at` ordering — assigned before status_changed
 * is the real server order (messages.service.ts:461 then 478), which lands
 * assigned.at < reopened.at, i.e. the racy order that pre-fix swapped the pills.
 * ai_changed carries occurredAt so its `at` is action-time (matches the server).
 */
async function injectAutoClaimTrio(): Promise<void> {
  // Mirror the FIXED server (autoAssignOnAgentSend): ai_paused / reopened /
  // self-assigned get ORDERED occurredAt = now + 1/2/3. Anchored to `now` (the
  // optimistic stub's real clock) so the reconcile pairs within the tight
  // stub-match window regardless of how slow the suite runs; the [ai, reopen,
  // assign] order + the dock-under-the-reply behaviour come from the anchor /
  // the message timestamp, not these absolute values.
  const base = Date.now();
  await injectConversationEvent("conversation.ai_changed", {
    previousAiEnabled: true,
    newAiEnabled: false,
    occurredAt: new Date(base + 1).toISOString(),
  });
  await injectConversationEvent("conversation.status_changed", {
    previousStatus: "pending",
    newStatus: "open",
    occurredAt: new Date(base + 2).toISOString(),
  });
  await injectConversationEvent("conversation.assigned", {
    previousAssignedUserId: null,
    newAssignedUserId: userId,
    assignedUser: {
      id: userId,
      workspaceId,
      name: "E2E Admin",
      email: "e2e@example.io",
      role: "admin",
      isActive: true,
    },
    occurredAt: new Date(base + 3).toISOString(),
  });
}

/**
 * Seed a server-authoritative ConversationEvent row directly (no optimistic
 * stub) — i.e. exactly what a REFRESHED page loads. Used to assert the
 * post-refresh order comes out right purely from the server `at` values the
 * fixed autoAssignOnAgentSend writes (message-ts + 1/2/3).
 */
async function seedConversationEvent(
  kind: "ai_paused" | "status_changed" | "assigned",
  atMs: number,
  after: Prisma.InputJsonObject,
): Promise<void> {
  await db().conversationEvent.create({
    data: { workspaceId, conversationId, userId, kind, after, at: new Date(atMs) },
  });
}

async function sendText(page: Page, text: string): Promise<void> {
  const box = page.getByPlaceholder(/Reply on WhatsApp/i);
  await expect(box).toBeVisible({ timeout: 8_000 });
  await box.click();
  await box.fill(text);
  await box.press("Enter");
}

/**
 * The rendered bubble label includes sender avatar initials, name, and time
 * around the body (e.g. "EAE2E Adminmsg one6:00 PM"), so match by the body
 * token and return the order of message bubbles as ["one","two","three"].
 */
function msgOrder(entries: Entry[]): string[] {
  const order: string[] = [];
  for (const e of entries) {
    if (e.kind !== "message") continue;
    const m = e.label.match(/msg (one|two|three)/);
    if (m) order.push(m[1]!);
  }
  return order;
}

async function waitForClientTempId(
  byBody: Map<string, string>,
  body: string,
): Promise<string> {
  await expect.poll(() => byBody.get(body) ?? null, { timeout: 8_000 }).not.toBeNull();
  return byBody.get(body)!;
}

// ── fixtures ────────────────────────────────────────────────────────────────

/** Fresh isolated contact + conversation + one seeded inbound, per test. */
async function freshConversation(): Promise<void> {
  convSeq += 1;
  const now = Date.now();
  const contact = await db().contact.create({
    data: {
      workspaceId,
      phoneNumber: `+1555765${String(1000 + convSeq).slice(-4)}`,
      identityChannel: "whatsapp",
      name: `Optimistic Order Contact ${convSeq}`,
      source: "manual",
      lastInboundAt: new Date(now), // 24h window OPEN → reply box enabled
    },
  });
  contactId = contact.id;

  const conv = await db().conversation.create({
    data: {
      workspaceId,
      contactId: contact.id,
      channel: "whatsapp",
      status: "open",
      aiEnabled: true,
      lastMessageAt: new Date(now),
      lastMessagePreview: "hello",
    },
  });
  conversationId = conv.id;

  await db().message.create({
    data: {
      workspaceId,
      conversationId,
      externalId: `seed-${now}-${convSeq}`,
      direction: "in",
      channel: "whatsapp",
      status: "delivered",
      body: "Hi, I need help",
      timestamp: new Date(now - 5000),
      rawPayload: {},
    },
  });
}

test.beforeAll(async () => {
  // The browser logs in via the app-admin storageState, so the ACTING user is
  // the app-admin — not the platform super-admin. Optimistic own-action pills
  // are authored as `currentUser` (the app-admin), so any reconcile that pairs a
  // stub to a server audit row (symptom 4) needs the injected actor to match.
  // Fixtures are keyed by the dedicated e2e workspace (`e2e-app-ws`) the
  // app-admin lives in, so actor and tenant always agree.
  const admin = await appAdmin();
  workspaceId = admin.workspaceId;
  userId = admin.userId;
  await wipeTestData();
});

test.afterAll(async () => {
  // Leave AI autopilot off for other suites sharing this team.
  await db().workspace.update({ where: { id: workspaceId }, data: { aiAutopilotEnabled: false } });
  await wipeTestData();
  await db().$disconnect();
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("Inbox outbound-send ordering (2026-06-16 fix)", () => {
  test("rapid sends with OUT-OF-ORDER confirmation never reorder (symptom 2)", async ({
    page,
  }) => {
    await freshConversation();
    await db().workspace.update({
      where: { id: workspaceId },
      data: { aiAutopilotEnabled: false }, // no pause pills — isolate the message ordering
    });
    // Pre-assign so the send doesn't trigger the optimistic auto-assign pill
    // (a human reply self-assigns an UNASSIGNED chat — see reply-box.tsx). Like
    // the aiAutopilot-off above, this isolates the MESSAGE-ordering invariant
    // from the orthogonal takeover pills (which have their own coverage below).
    await db().conversation.update({
      where: { id: conversationId },
      data: { assignedUserId: userId },
    });
    const byBody = await interceptSends(page);
    await openThread(page);

    // Three quick sends → three optimistic pending bubbles, pinned in send order.
    await sendText(page, "msg one");
    await sendText(page, "msg two");
    await sendText(page, "msg three");

    // All three painted, in order, pending, no reorder during the optimistic phase.
    await expect
      .poll(
        async () =>
          (await snapshot(page)).filter(
            (e) => e.kind === "message" && /msg (one|two|three)/.test(e.label),
          ).length,
        { timeout: 8_000 },
      )
      .toBe(3);
    {
      const snap = await snapshot(page);
      expect(msgOrder(snap)).toEqual(["one", "two", "three"]);
      expect(
        snap
          .filter((e) => e.kind === "message" && /msg (one|two|three)/.test(e.label))
          .every((e) => e.pending),
      ).toBe(true);
    }

    const t1 = await waitForClientTempId(byBody, "msg one");
    const t2 = await waitForClientTempId(byBody, "msg two");
    const t3 = await waitForClientTempId(byBody, "msg three");

    // Confirm OUT OF ORDER: #3 first (the exact trigger). Server timestamps still
    // ascending 1<2<3 so the final chronological order is one/two/three.
    const base = Date.now();
    const sampling = sampleOver(page, 3500, 50);
    await injectOutboundSent({ body: "msg three", clientTempId: t3, atMs: base + 3000 });
    await page.waitForTimeout(500);
    await injectOutboundSent({ body: "msg one", clientTempId: t1, atMs: base + 1000 });
    await page.waitForTimeout(300);
    await injectOutboundSent({ body: "msg two", clientTempId: t2, atMs: base + 2000 });

    const samples = await sampling;
    // The core invariant: nothing ever jumped index across the whole reconcile.
    expect(findReorder(samples)).toBeNull();

    // And everything settled to send order, all confirmed (no pending left).
    const finalSnap = await snapshot(page);
    expect(msgOrder(finalSnap)).toEqual(["one", "two", "three"]);
    expect(
      finalSnap
        .filter((e) => e.kind === "message" && /msg (one|two|three)/.test(e.label))
        .some((e) => e.pending),
    ).toBe(false);
  });

  test("auto-pause pill lands BELOW the reply, never above (symptom 1)", async ({
    page,
  }) => {
    await freshConversation();
    await db().workspace.update({
      where: { id: workspaceId },
      data: { aiAutopilotEnabled: true }, // enables the optimistic auto-pause pill
    });
    const byBody = await interceptSends(page);
    await openThread(page);

    await sendText(page, "let me check that for you");

    // The optimistic ai-pause pill appears, and from the FIRST paint it is the
    // last row — below the just-sent reply, never above it.
    await expect
      .poll(
        async () => {
          const o = await snapshot(page);
          return o.some(
            (e) => e.kind === "activity" && /autopilot|paused|ai/i.test(e.label),
          );
        },
        { timeout: 8_000 },
      )
      .toBe(true);

    const reply = (s: Entry[]) =>
      s.findIndex((e) => e.kind === "message" && e.label.includes("let me check"));
    const pill = (s: Entry[]) =>
      s.findIndex((e) => e.kind === "activity" && /autopilot|paused|ai/i.test(e.label));

    // Reconcile the send mid-stream; the pill must stay below the reply throughout.
    const sampling = sampleOver(page, 2500, 50);
    await page.waitForTimeout(300);
    const tid = await waitForClientTempId(byBody, "let me check that for you");
    await injectOutboundSent({
      body: "let me check that for you",
      clientTempId: tid,
      atMs: Date.now() + 1000,
    });

    const samples = await sampling;
    expect(findReorder(samples)).toBeNull();
    for (const s of samples) {
      const r = reply(s);
      const p = pill(s);
      if (r === -1 || p === -1) continue;
      expect(p, "pill below the reply").toBeGreaterThan(r);
    }
  });

  // Symptom 3 (2026-06-17) — the reported "three logs flash above then snap
  // below the send" glitch: replying into an UNASSIGNED + AI-on + non-open chat
  // makes the server write ai_paused + assigned + reopened logs. Pre-fix those
  // arrived a round-trip late, server-clocked + unpinned, floating ABOVE the
  // still-pending send before snapping below. reply-box now mirrors all three
  // optimistically in send-order seq (next to the AI-pause), so every pill is
  // BELOW the reply from the first paint and never jumps.
  test("takeover pills (ai-pause + self-assign + reopen) land BELOW the send, no flash (symptom 3)", async ({
    page,
  }) => {
    await freshConversation();
    // Unassigned + closed + AI on → the send triggers all three takeover logs.
    await db().workspace.update({
      where: { id: workspaceId },
      data: { aiAutopilotEnabled: true },
    });
    await db().conversation.update({
      where: { id: conversationId },
      data: { assignedUserId: null, status: "closed" },
    });
    const byBody = await interceptSends(page);
    await openThread(page);

    await sendText(page, "on it now");

    // All three optimistic pills paint (kinds: ai_paused / assigned / status_changed).
    await expect
      .poll(async () => {
        const o = await snapshot(page);
        return o.filter((e) => e.kind === "activity").length;
      }, { timeout: 8_000 })
      .toBeGreaterThanOrEqual(3);

    const replyIdx = (s: Entry[]) =>
      s.findIndex((e) => e.kind === "message" && e.label.includes("on it now"));

    // Reconcile the send mid-stream; every activity pill must stay BELOW the
    // reply across the whole window (never index-above it, even for one frame).
    const sampling = sampleOver(page, 2500, 50);
    await page.waitForTimeout(300);
    const tid = await waitForClientTempId(byBody, "on it now");
    await injectOutboundSent({
      body: "on it now",
      clientTempId: tid,
      atMs: Date.now() + 1000,
    });
    const samples = await sampling;

    expect(findReorder(samples)).toBeNull();
    for (const s of samples) {
      const r = replyIdx(s);
      if (r === -1) continue;
      const pillsAbove = s
        .slice(0, r)
        .filter((e) => e.kind === "activity");
      expect(pillsAbove, "no takeover pill above the reply").toEqual([]);
    }
  });

  // Symptom 4 (2026-06-17) — the upper-thread "vibration" the user still felt on
  // an auto-claim into a PENDING + UNASSIGNED chat. Symptom 3 proved the pills
  // paint BELOW the send OPTIMISTICALLY; it never reconciles them, so it can't
  // catch this: the lag happens LATER, when the optimistic pills settle to the
  // real server audit rows AND the send confirms (un-pinning them).
  //
  // The DECISIVE axis (and why the owner saw it as "the reopened log" + cache-
  // dependent): the MESSAGE's server timestamp races the reopen pill's audit `at`,
  // which come from two different clocks (worker `receivedAt` vs Postgres now()).
  // We inject the message timestamp AFTER the audit rows (`base + 30000`) — the
  // real-world "late ack / clock skew" condition. Pre-fix the un-pinned reopen
  // pill then sorted by its own audit `at`, which is EARLIER than the message, so
  // it floated ABOVE the reply (the "reopened" log jumping up). The fix anchors
  // the pills to their MESSAGE's slot by a shared optimisticGroupId, so they sit
  // in send order directly under the reply no matter how the timestamps fall —
  // clock-independent, which is why it cures the "cached-vs-fresh" flakiness too.
  // It also keeps same-send own-action pills (the only rows carrying a group id)
  // sorted by their send-order seq even AFTER they un-pin — so they never swap.
  //
  // AI is off here to isolate the assign↔reopen pair, which is the swap the user
  // described ("self assigned coming before reopened then after"). The AI-pause
  // pill is orthogonal: it sorts first by its own occurredAt and has its own
  // coverage (symptom 1); adding it back doesn't change this pair's behaviour.
  test("auto-claim pills (self-assign + reopen) don't vibrate on reconcile+confirm (symptom 4)", async ({
    page,
  }) => {
    await freshConversation();
    await db().workspace.update({
      where: { id: workspaceId },
      data: { aiAutopilotEnabled: false }, // isolate assign↔reopen (no AI pill)
    });
    // The exact reported trigger: unassigned + pending (non-open) → a human reply
    // self-assigns AND reopens, emitting both takeover pills.
    await db().conversation.update({
      where: { id: conversationId },
      data: { assignedUserId: null, status: "pending", aiEnabled: false },
    });
    const byBody = await interceptSends(page);
    await openThread(page);

    const base = Date.now();
    await sendText(page, "on it now");

    // Both optimistic takeover pills paint, pending (pinned in send order).
    await expect
      .poll(async () => {
        const o = await snapshot(page);
        return o.filter((e) => e.kind === "activity" && e.pending).length;
      }, { timeout: 8_000 })
      .toBe(2);

    const sig = (s: Entry[]) => ({
      reopen: s.findIndex((e) => e.kind === "activity" && /reopen/i.test(e.label)),
      assign: s.findIndex((e) => e.kind === "activity" && /self-assign|assigned/i.test(e.label)),
      reply: s.findIndex((e) => e.kind === "message" && e.label.includes("on it now")),
    });
    {
      const i = sig(await snapshot(page));
      expect(i.reopen, "reopen pill present").toBeGreaterThanOrEqual(0);
      expect(i.assign, "self-assign pill present").toBeGreaterThanOrEqual(0);
      // Optimistic settled order is reply → reopened → self-assigned from paint 1.
      expect(i.reply).toBeLessThan(i.reopen);
      expect(i.reopen).toBeLessThan(i.assign);
    }

    const tid = await waitForClientTempId(byBody, "on it now");

    // Sample across the WHOLE reconcile+confirm transition. The pills keep their
    // stub id through reconcile, so any index change of any tracked entry = a jump.
    const sampling = sampleOver(page, 4000, 40);

    // Reconcile: write the real audit rows + fanout. assigned FIRST so its audit
    // `at` is EARLIER than reopened's — the worst-case clock order that pre-fix
    // made the pills swap the moment they un-pinned.
    await injectConversationEvent("conversation.assigned", {
      previousAssignedUserId: null,
      newAssignedUserId: userId,
      assignedUser: {
        id: userId,
        workspaceId,
        name: "E2E Admin",
        email: "e2e@example.io",
        role: "admin",
        isActive: true,
      },
    });
    await page.waitForTimeout(250);
    await injectConversationEvent("conversation.status_changed", {
      previousStatus: "pending",
      newStatus: "open",
    });

    // Wait for both pills to SETTLE (shed optimisticPending → data-pending absent)
    // via the trailing /events GET, WHILE the send is still pending (so they stay
    // pinned by seq — the un-pin, and any swap, happens only on confirm below).
    await expect
      .poll(async () => {
        const o = await snapshot(page);
        const acts = o.filter((e) => e.kind === "activity");
        return acts.length === 2 && acts.every((e) => !e.pending);
      }, { timeout: 8_000 })
      .toBe(true);

    // Confirm the send → un-pin the (already-reconciled) pills. The message `at`
    // lands AFTER the audit rows (`base + 30000` — the late-ack / clock-skew case
    // that exposed the real bug). Pre-fix the reopen pill, sorting by its earlier
    // audit `at`, floated ABOVE this reply; the message-anchor fix keeps it below.
    await injectOutboundSent({ body: "on it now", clientTempId: tid, atMs: base + 30000 });

    const samples = await sampling;
    expect(findReorder(samples)).toBeNull();

    // Final settled state: still reply → reopened → self-assigned, both confirmed.
    const finalSnap = await snapshot(page);
    const fi = sig(finalSnap);
    expect(fi.reply).toBeLessThan(fi.reopen);
    expect(
      fi.reopen,
      "reopened stays above self-assigned after un-pin (no swap)",
    ).toBeLessThan(fi.assign);
    expect(
      finalSnap.filter((e) => e.kind === "activity").every((e) => !e.pending),
      "both pills settled",
    ).toBe(true);
  });

  // Symptom 5 (2026-06-17) — the EXACT reported scenario: UNASSIGNED + AI ON +
  // PENDING, send a message → the server fans out the FULL trio (ai_paused +
  // reopened + self-assigned). All three must reconcile, stay docked UNDER the
  // reply in send order, with the message timestamp landing AFTER the audit rows
  // (late ack / clock skew), and there must be exactly three pills (no
  // duplicates). symptom 4 only covered AI-off (2 pills); this is the 3-pill case.
  test("full trio (ai-pause + reopen + self-assign) anchors under the reply, no scramble (symptom 5)", async ({
    page,
  }) => {
    await freshConversation();
    await db().workspace.update({
      where: { id: workspaceId },
      data: { aiAutopilotEnabled: true },
    });
    await db().conversation.update({
      where: { id: conversationId },
      data: { assignedUserId: null, status: "pending", aiEnabled: true },
    });
    const byBody = await interceptSends(page);
    await openThread(page);

    const base = Date.now();
    await sendText(page, "hello there");

    // Three optimistic pills paint, pending.
    await expect
      .poll(
        async () =>
          (await snapshot(page)).filter((e) => e.kind === "activity" && e.pending)
            .length,
        { timeout: 8_000 },
      )
      .toBe(3);

    const tid = await waitForClientTempId(byBody, "hello there");
    const sampling = sampleOver(page, 4500, 40);

    // Reconcile the full trio (ai_paused, assigned, reopened).
    await injectAutoClaimTrio();

    // All three settle while the send is still pending.
    await expect
      .poll(
        async () => {
          const acts = (await snapshot(page)).filter((e) => e.kind === "activity");
          return acts.length === 3 && acts.every((e) => !e.pending);
        },
        { timeout: 8_000 },
      )
      .toBe(true);

    // Confirm with the message ts AFTER the audit rows.
    await injectOutboundSent({
      body: "hello there",
      clientTempId: tid,
      atMs: base + 30000,
    });
    const samples = await sampling;

    expect(findReorder(samples)).toBeNull();

    const finalSnap = await snapshot(page);
    const acts = finalSnap.filter((e) => e.kind === "activity");
    expect(acts.length, "exactly three pills, no duplicates").toBe(3);
    const idx = (re: RegExp) =>
      finalSnap.findIndex((e) => e.kind === "activity" && re.test(e.label));
    const reply = finalSnap.findIndex(
      (e) => e.kind === "message" && e.label.includes("hello there"),
    );
    const ai = idx(/paused ai|paused.*autopilot/i);
    const reopen = idx(/reopen/i);
    const assign = idx(/self-assign/i);
    expect(reply, "reply painted").toBeGreaterThanOrEqual(0);
    expect(reply, "reply above all pills").toBeLessThan(ai);
    expect(ai, "ai-pause above reopen").toBeLessThan(reopen);
    expect(reopen, "reopen above self-assign").toBeLessThan(assign);
    expect(acts.every((e) => !e.pending), "all settled").toBe(true);
  });

  // Symptom 6 (2026-06-17) — REPEATED sends, the "too many duplicate logs + the
  // upper inbox vibrates, fixed by refresh" report. Send into unassigned+pending+
  // AI-on, RESET (resume AI + pending + unassign), send again. Each send is its
  // own group; a groupless "resumed AI" pill sits between two trios. The first
  // fix's per-PAIR seq/at tiebreak is NON-TRANSITIVE in this shape (a groupless
  // row whose `at` falls between two groups), so JS sort produced an undefined,
  // flickering order that cleared only on refresh. The message-anchored SINGLE
  // sort key is transitive, so the two cycles stay separated with no duplicates.
  test("repeated sends + AI-resume between them: no duplicate or scrambled logs (symptom 6)", async ({
    page,
  }) => {
    await freshConversation();
    await db().workspace.update({
      where: { id: workspaceId },
      data: { aiAutopilotEnabled: true },
    });
    const resetPendingUnassigned = () =>
      db().conversation.update({
        where: { id: conversationId },
        data: { assignedUserId: null, status: "pending", aiEnabled: true },
      });
    await resetPendingUnassigned();
    const byBody = await interceptSends(page);
    await openThread(page);

    const base = Date.now();

    // ---- cycle 1 ----
    await sendText(page, "first");
    await expect
      .poll(
        async () =>
          (await snapshot(page)).filter((e) => e.kind === "activity" && e.pending)
            .length,
        { timeout: 8_000 },
      )
      .toBe(3);
    const t1 = await waitForClientTempId(byBody, "first");
    await injectAutoClaimTrio();
    await expect
      .poll(
        async () => {
          const acts = (await snapshot(page)).filter((e) => e.kind === "activity");
          return acts.length === 3 && acts.every((e) => !e.pending);
        },
        { timeout: 8_000 },
      )
      .toBe(true);
    await injectOutboundSent({ body: "first", clientTempId: t1, atMs: base + 1000 });

    // ---- reset: resume AI + back to pending + unassign ----
    // Reset the DB AND drive the client state back via authoritative frames (the
    // UI does this through the dropdowns/toggle). The frames flip the client props
    // (assignedUserId→null, status→pending, aiEnabled→true), which is what resets
    // reply-box's once-per-stretch *EmittedRef guards so cycle 2 re-emits its
    // trio. Each also writes one reset pill (unassigned / marked-pending / resumed
    // AI) — groupless, so they sort between the two send groups by `at`.
    await resetPendingUnassigned();
    await injectConversationEvent("conversation.assigned", {
      previousAssignedUserId: userId,
      newAssignedUserId: null,
      assignedUser: null,
    });
    await injectConversationEvent("conversation.status_changed", {
      previousStatus: "open",
      newStatus: "pending",
    });
    await injectConversationEvent("conversation.ai_changed", {
      previousAiEnabled: false,
      newAiEnabled: true,
      occurredAt: new Date(base + 5000).toISOString(),
    });
    await expect
      .poll(
        async () =>
          (await snapshot(page)).filter((e) => e.kind === "activity").length,
        { timeout: 8_000 },
      )
      .toBe(6); // 3 trio + 3 reset (unassigned / pending / resumed)

    // ---- cycle 2 (sampled — this is where the scramble showed) ----
    const sampling = sampleOver(page, 5000, 40);
    await sendText(page, "second");
    await expect
      .poll(
        async () =>
          (await snapshot(page)).filter((e) => e.kind === "activity" && e.pending)
            .length,
        { timeout: 8_000 },
      )
      .toBe(3);
    const t2 = await waitForClientTempId(byBody, "second");
    await injectAutoClaimTrio();
    await expect
      .poll(
        async () => {
          const acts = (await snapshot(page)).filter((e) => e.kind === "activity");
          return acts.length === 9 && acts.every((e) => !e.pending);
        },
        { timeout: 8_000 },
      )
      .toBe(true);
    await injectOutboundSent({ body: "second", clientTempId: t2, atMs: base + 30000 });
    const samples = await sampling;

    expect(findReorder(samples), "no reorder across cycle 2").toBeNull();

    const finalSnap = await snapshot(page);
    const acts = finalSnap.filter((e) => e.kind === "activity");
    expect(acts.length, "9 pills total, no duplicates").toBe(9);
    const count = (re: RegExp) => acts.filter((e) => re.test(e.label)).length;
    expect(count(/paused ai|paused.*autopilot/i), "2 paused").toBe(2);
    expect(count(/reopen/i), "2 reopened").toBe(2);
    expect(count(/self-assign/i), "2 self-assigned").toBe(2);
    expect(count(/resumed ai|resumed.*autopilot/i), "1 resumed").toBe(1);
    expect(count(/unassigned the conversation/i), "1 unassigned").toBe(1);
    expect(count(/marked the conversation pending|marked.*pending/i), "1 pending").toBe(1);
    // Order: cycle-1 block (under "first") < resume < cycle-2 block (under "second").
    const firstMsg = finalSnap.findIndex(
      (e) => e.kind === "message" && e.label.includes("first"),
    );
    const secondMsg = finalSnap.findIndex(
      (e) => e.kind === "message" && e.label.includes("second"),
    );
    const resumeIdx = finalSnap.findIndex(
      (e) => e.kind === "activity" && /resumed/i.test(e.label),
    );
    expect(firstMsg, "first send above resume").toBeLessThan(resumeIdx);
    expect(resumeIdx, "resume above second send").toBeLessThan(secondMsg);
  });

  // Symptom 7 (2026-06-17) — the AFTER-REFRESH case, the one that stayed broken
  // ("perfect without refresh; refresh + reset + send → message above logs, and
  // only SOMETIMES"). On a reloaded page there is NO optimistic group to anchor
  // the auto-claim pills, so the order is decided purely by the server audit
  // `at`, which used to RACE the message timestamp (hence "sometimes"). The
  // server fix stamps ai_paused/reopened/self-assigned at message-ts + 1/2/3, so
  // they sort directly UNDER the reply in a fixed order, identically on every
  // load. This seeds the server rows exactly as the fixed server writes them and
  // asserts the order is correct AND stable across a real page.reload().
  test("after refresh: auto-claim pills sort UNDER the reply, stable, no vibration (symptom 7)", async ({
    page,
  }) => {
    await freshConversation();
    // Post-claim resting state (what the conversation looks like after a reply
    // auto-claimed it): assigned + open + AI paused.
    await db().conversation.update({
      where: { id: conversationId },
      data: { assignedUserId: userId, status: "open", aiEnabled: false },
    });
    const T = Date.now();
    // The triggering reply (server row) at T, then the trio at T+1/2/3 — exactly
    // what the fixed autoAssignOnAgentSend persists.
    await db().message.create({
      data: {
        workspaceId,
        conversationId,
        externalId: `e2e-refresh-${T}`,
        direction: "out",
        channel: "whatsapp",
        status: "sent",
        body: "on it now",
        timestamp: new Date(T),
        senderUserId: userId,
        rawPayload: {},
      },
    });
    await seedConversationEvent("ai_paused", T + 1, { aiEnabled: false });
    await seedConversationEvent("status_changed", T + 2, { status: "open" });
    await seedConversationEvent("assigned", T + 3, { assignedUserId: userId });

    await openThread(page);

    const verify = async (label: string) => {
      // Sample over a window (forces several renders) → catch any flicker.
      const samples = await sampleOver(page, 1500, 60);
      expect(findReorder(samples), `${label}: no vibration`).toBeNull();
      const snap = samples[samples.length - 1]!;
      const acts = snap.filter((e) => e.kind === "activity");
      expect(acts.length, `${label}: exactly 3 pills, no duplicates`).toBe(3);
      const idx = (re: RegExp) =>
        snap.findIndex((e) => e.kind === "activity" && re.test(e.label));
      const reply = snap.findIndex(
        (e) => e.kind === "message" && e.label.includes("on it now"),
      );
      const ai = idx(/paused ai|paused.*autopilot/i);
      const reopen = idx(/reopen/i);
      const assign = idx(/self-assign/i);
      expect(reply, `${label}: reply present`).toBeGreaterThanOrEqual(0);
      expect(ai, `${label}: ai pill present`).toBeGreaterThanOrEqual(0);
      expect(reply, `${label}: reply ABOVE the pills`).toBeLessThan(ai);
      expect(ai, `${label}: ai above reopen`).toBeLessThan(reopen);
      expect(reopen, `${label}: reopen above self-assign`).toBeLessThan(assign);
    };

    await verify("first load");
    // A real refresh — the exact action the user said re-broke it.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-entry-kind]").first()).toBeVisible({
      timeout: 15_000,
    });
    await page.waitForTimeout(600);
    await verify("after reload");
  });

  // Symptom 8 (2026-06-17) — the residual "a 5:50 log shows at the bottom then
  // settles" flicker on REPEATED sends. ai_paused/ai_resumed carry NO value in
  // activitySignature, so every past pause is identical. When the agent sends
  // again, the new send's optimistic pause pill reconciles via the LEADING
  // /events GET — which can fire BEFORE the new pause audit row is written — and
  // (pre-fix, 120s window) pairs with an OLD pause row up to 2min back, which
  // then adopts the new send's group and jumps to the new message before the
  // trailing GET corrects it. We reproduce that race DETERMINISTICALLY: seed a
  // prior send's pause row, then on the new send inject reopen+assign (which
  // triggers the GET) while the new pause row is still absent. The OLD pause row
  // must NEVER move. Frames captured at 25ms so any one-frame jump is caught.
  test("repeated send doesn't transiently mis-place an OLD ai-pause log (symptom 8)", async ({
    page,
  }) => {
    await freshConversation();
    await db().workspace.update({
      where: { id: workspaceId },
      data: { aiAutopilotEnabled: true },
    });
    const T = Date.now();
    // A prior send only 5s ago — INSIDE the 8s match window on purpose, so this
    // exercises the back-tolerance (reject rows older than the stub), not just
    // the window. The 8s window alone would still mis-pair a 5s-old row.
    const OLD = T - 5_000;
    await db().message.create({
      data: {
        workspaceId,
        conversationId,
        externalId: `e2e-old-${OLD}`,
        direction: "out",
        channel: "whatsapp",
        status: "sent",
        body: "oldsend",
        timestamp: new Date(OLD),
        senderUserId: userId,
        rawPayload: {},
      },
    });
    // The prior send's settled trio (server rows, no group).
    await seedConversationEvent("ai_paused", OLD + 1, { aiEnabled: false });
    await seedConversationEvent("status_changed", OLD + 2, { status: "open" });
    await seedConversationEvent("assigned", OLD + 3, { assignedUserId: userId });
    // Reset to pending + unassigned (the agent re-testing) so the new send
    // re-triggers the full trio.
    await db().conversation.update({
      where: { id: conversationId },
      data: { assignedUserId: null, status: "pending", aiEnabled: true },
    });
    const byBody = await interceptSends(page);
    await openThread(page);

    // The OLD pause row's index at rest — it must hold this all the way through.
    const oldPauseIndex = (snap: Entry[]) =>
      snap.findIndex(
        (e) =>
          e.kind === "activity" &&
          /paused ai|paused.*autopilot/i.test(e.label) &&
          e.ts != null &&
          Math.abs(new Date(e.ts).getTime() - (OLD + 1)) < 1500,
      );

    await sendText(page, "newsend");
    await expect
      .poll(
        async () =>
          (await snapshot(page)).filter((e) => e.kind === "activity" && e.pending)
            .length,
        { timeout: 8_000 },
      )
      .toBe(3);

    const tid = await waitForClientTempId(byBody, "newsend");
    const sampling = sampleOver(page, 4000, 25); // 25ms = ~160 frames

    // Trigger the reconcile GET via reopen+assign WHILE the new pause row is
    // still absent — the exact window the old pause row could be mis-paired in.
    const now = Date.now();
    await injectConversationEvent("conversation.status_changed", {
      previousStatus: "pending",
      newStatus: "open",
      occurredAt: new Date(now + 2).toISOString(),
    });
    await injectConversationEvent("conversation.assigned", {
      previousAssignedUserId: null,
      newAssignedUserId: userId,
      assignedUser: {
        id: userId,
        workspaceId,
        name: "E2E Admin",
        email: "e2e@example.io",
        role: "admin",
        isActive: true,
      },
      occurredAt: new Date(now + 3).toISOString(),
    });
    await page.waitForTimeout(500); // let the leading GET fire + (pre-fix) mis-pair
    // Now the new pause row lands.
    await injectConversationEvent("conversation.ai_changed", {
      previousAiEnabled: true,
      newAiEnabled: false,
      occurredAt: new Date(now + 1).toISOString(),
    });
    await page.waitForTimeout(400);
    await injectOutboundSent({ body: "newsend", clientTempId: tid, atMs: now });

    const frames = await sampling;

    // The OLD pause row must stay put across EVERY frame (never jump to the new
    // message). Track it by its now-5s-old timestamp.
    const oldMsgIdx = (snap: Entry[]) =>
      snap.findIndex((e) => e.kind === "message" && e.label.includes("oldsend"));
    let worst: string | null = null;
    for (let s = 0; s < frames.length; s++) {
      const snap = frames[s]!;
      const oi = oldPauseIndex(snap);
      const omi = oldMsgIdx(snap);
      if (oi === -1 || omi === -1) continue;
      // The old pause log sits just under the OLD message — never below the
      // newsend reply (which is much further down).
      const newReply = snap.findIndex(
        (e) => e.kind === "message" && e.label.includes("newsend"),
      );
      if (newReply !== -1 && oi > newReply) {
        worst = `frame ${s}: old pause log (idx ${oi}) jumped BELOW the new reply (idx ${newReply})`;
        break;
      }
    }
    expect(worst, "old ai-pause log never mis-places").toBeNull();
    // And no global reorder of any tracked id either.
    expect(findReorder(frames)).toBeNull();
  });

  // Symptom 9 (2026-06-17) — the DENSE same-second case (the "everything at
  // 6:00 PM, two different orders" screenshots): 2 send+reset cycles packed into
  // ONE second. With the fixed server every row has a distinct, ordered `at`
  // (auto-claim = message-ts + 1/2/3; the reset dropdowns are sequential ms
  // apart), so even at second-display-precision the timeline is chronological and
  // STABLE — no tiebreak lottery. Frames at 25ms catch any transient scramble.
  test("dense same-second: 2 send+reset cycles stay chronological + stable (symptom 9)", async ({
    page,
  }) => {
    await freshConversation();
    await db().workspace.update({
      where: { id: workspaceId },
      data: { aiAutopilotEnabled: true },
    });
    const reset = () =>
      db().conversation.update({
        where: { id: conversationId },
        data: { assignedUserId: null, status: "pending", aiEnabled: true },
      });
    await reset();
    const byBody = await interceptSends(page);
    await openThread(page);

    const T = Date.now();
    const settled3 = (n: number) =>
      expect
        .poll(
          async () => {
            const a = (await snapshot(page)).filter((e) => e.kind === "activity");
            return a.length === n && a.every((e) => !e.pending);
          },
          { timeout: 8_000 },
        )
        .toBe(true);
    const pending3 = () =>
      expect
        .poll(
          async () =>
            (await snapshot(page)).filter((e) => e.kind === "activity" && e.pending)
              .length,
          { timeout: 8_000 },
        )
        .toBe(3);

    const sampling = sampleOver(page, 7000, 25); // dense capture over the WHOLE flow

    // ---- cycle 1 (message @T, trio @T+1/2/3) ----
    await sendText(page, "first");
    await pending3();
    const t1 = await waitForClientTempId(byBody, "first");
    await injectAutoClaimTrio();
    await injectOutboundSent({ body: "first", clientTempId: t1, atMs: T });
    await settled3(3);

    // ---- reset (resumed @T+10, pending @T+11, unassigned @T+12) ----
    await reset();
    await injectConversationEvent("conversation.ai_changed", {
      previousAiEnabled: false,
      newAiEnabled: true,
      occurredAt: new Date(T + 10).toISOString(),
    });
    await injectConversationEvent("conversation.status_changed", {
      previousStatus: "open",
      newStatus: "pending",
      occurredAt: new Date(T + 11).toISOString(),
    });
    await injectConversationEvent("conversation.assigned", {
      previousAssignedUserId: userId,
      newAssignedUserId: null,
      assignedUser: null,
      occurredAt: new Date(T + 12).toISOString(),
    });
    await expect
      .poll(
        async () =>
          (await snapshot(page)).filter((e) => e.kind === "activity").length,
        { timeout: 8_000 },
      )
      .toBe(6);

    // ---- cycle 2 (message @T+20, trio @T+21/22/23) ----
    await sendText(page, "second");
    await pending3();
    const t2 = await waitForClientTempId(byBody, "second");
    await injectAutoClaimTrio();
    await injectOutboundSent({ body: "second", clientTempId: t2, atMs: T + 20 });
    await settled3(9);

    const frames = await sampling;

    // (1) No reorder anywhere across the whole dense flow.
    expect(findReorder(frames), "no reorder across the dense same-second flow").toBeNull();

    // (2) Final order is EXACTLY the action order.
    const token = (e: Entry): string | null => {
      if (e.kind === "message") {
        if (e.label.includes("first")) return "msg:first";
        if (e.label.includes("second")) return "msg:second";
        return null; // seeded inbound — ignore
      }
      if (e.kind !== "activity") return null;
      if (/paused ai|paused.*autopilot/i.test(e.label)) return "act:paused";
      if (/resumed ai|resumed.*autopilot/i.test(e.label)) return "act:resumed";
      if (/reopen/i.test(e.label)) return "act:reopened";
      if (/unassigned the conversation/i.test(e.label)) return "act:unassigned";
      if (/self-assign/i.test(e.label)) return "act:self-assigned";
      if (/marked.*pending|pending/i.test(e.label)) return "act:pending";
      return null;
    };
    const finalTokens = frames[frames.length - 1]!
      .map(token)
      .filter((t): t is string => t != null);
    expect(finalTokens).toEqual([
      "msg:first",
      "act:paused",
      "act:reopened",
      "act:self-assigned",
      "act:resumed",
      "act:pending",
      "act:unassigned",
      "msg:second",
      "act:paused",
      "act:reopened",
      "act:self-assigned",
    ]);
  });

  // Symptom 10 (2026-06-17) — the user's EXACT minimal repro: a conversation that
  // is UNASSIGNED + AI OFF + CLOSED/PENDING, REFRESH the page, then SEND. After
  // the refresh the page holds only server rows (no optimistic group), and the
  // PRIOR claim cycle's self-assigned + reopened rows sit in history. The new
  // send's optimistic self-assign + reopen pills (AI off → no pause pill) must
  // pair with their OWN fresh rows — never the older identical-signature ones.
  // The back-tolerance (reject a row OLDER than the stub) is what guarantees it.
  test("after refresh into unassigned+AI-off+closed, a send never mis-places the OLD claim logs (symptom 10)", async ({
    page,
  }) => {
    await freshConversation();
    await db().workspace.update({
      where: { id: workspaceId },
      data: { aiAutopilotEnabled: false },
    });
    const T = Date.now();
    const OLD = T - 5_000; // a prior claim cycle, only 5s ago (inside the window)
    await db().message.create({
      data: {
        workspaceId,
        conversationId,
        externalId: `e2e-old10-${OLD}`,
        direction: "out",
        channel: "whatsapp",
        status: "sent",
        body: "oldsend",
        timestamp: new Date(OLD),
        senderUserId: userId,
        rawPayload: {},
      },
    });
    // Prior cycle: reopened + self-assigned, then reset back to unassigned+closed.
    await seedConversationEvent("status_changed", OLD + 1, { status: "open" });
    await seedConversationEvent("assigned", OLD + 2, { assignedUserId: userId });
    await seedConversationEvent("assigned", OLD + 3, { assignedUserId: null });
    await seedConversationEvent("status_changed", OLD + 4, { status: "pending" });
    // Current resting state (the exact trigger conditions).
    await db().conversation.update({
      where: { id: conversationId },
      data: { assignedUserId: null, status: "pending", aiEnabled: false },
    });
    const byBody = await interceptSends(page);
    await openThread(page); // = the user's refresh

    const oldSelfAssign = (s: Entry[]) =>
      s.findIndex(
        (e) =>
          e.kind === "activity" &&
          /self-assign/i.test(e.label) &&
          e.ts != null &&
          Math.abs(new Date(e.ts).getTime() - (OLD + 2)) < 1500,
      );
    const oldReopen = (s: Entry[]) =>
      s.findIndex(
        (e) =>
          e.kind === "activity" &&
          /reopen/i.test(e.label) &&
          e.ts != null &&
          Math.abs(new Date(e.ts).getTime() - (OLD + 1)) < 1500,
      );

    await sendText(page, "newsend");
    // AI off → only self-assign + reopen pills (no pause).
    await expect
      .poll(
        async () =>
          (await snapshot(page)).filter((e) => e.kind === "activity" && e.pending)
            .length,
        { timeout: 8_000 },
      )
      .toBe(2);
    const tid = await waitForClientTempId(byBody, "newsend");
    const sampling = sampleOver(page, 4500, 25);
    const now = Date.now();
    // Reopen FIRST — its fanout triggers the reconcile GET while the new
    // self-assign row is still ABSENT. That's the leading-GET race: the new
    // self-assign STUB looks for an "assigned:E2E Admin" row and the only one
    // present is the 5s-OLD claim. Pre-fix it pairs with that old row (gap 5s <
    // 8s window) and drags it down to the new message; the back-tolerance rejects
    // it (the row is older than the stub).
    await injectConversationEvent("conversation.status_changed", {
      previousStatus: "pending",
      newStatus: "open",
      occurredAt: new Date(now + 2).toISOString(),
    });
    await page.waitForTimeout(450); // race window — old self-assign is the only candidate
    await injectConversationEvent("conversation.assigned", {
      previousAssignedUserId: null,
      newAssignedUserId: userId,
      assignedUser: {
        id: userId,
        workspaceId,
        name: "E2E Admin",
        email: "e2e@example.io",
        role: "admin",
        isActive: true,
      },
      occurredAt: new Date(now + 3).toISOString(),
    });
    await page.waitForTimeout(400);
    await injectOutboundSent({ body: "newsend", clientTempId: tid, atMs: now });
    const frames = await sampling;

    expect(findReorder(frames), "no reorder").toBeNull();
    const newReply = (s: Entry[]) =>
      s.findIndex((e) => e.kind === "message" && e.label.includes("newsend"));
    let worst: string | null = null;
    for (let i = 0; i < frames.length; i++) {
      const s = frames[i]!;
      const nr = newReply(s);
      if (nr === -1) continue;
      const osa = oldSelfAssign(s);
      const ore = oldReopen(s);
      if (osa !== -1 && osa > nr) {
        worst = `frame ${i}: OLD self-assign (idx ${osa}) jumped BELOW the new reply (idx ${nr})`;
        break;
      }
      if (ore !== -1 && ore > nr) {
        worst = `frame ${i}: OLD reopen (idx ${ore}) jumped BELOW the new reply (idx ${nr})`;
        break;
      }
    }
    expect(worst, "old claim logs never mis-place below the new send").toBeNull();
  });

  // ── Composer send-concurrency (2026-07-06 freeze fix) ────────────────────
  // The blanket in-flight lock was replaced by a same-content dedupe + an
  // in-flight COUNTER, so a quick text can send while a media upload is still
  // going. These two tests pin the safety envelope: a double-fire of the SAME
  // content must NOT double-deliver (irreversible on Meta), while two DISTINCT
  // sends must BOTH go through.
  test("double-Enter of the same text sends it only ONCE (no double-delivery)", async ({
    page,
  }) => {
    await freshConversation();
    let posts = 0;
    await page.route("**/api/messages", async (route: Route) => {
      if (route.request().method() === "POST") posts += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });
    await openThread(page);
    const box = page.getByPlaceholder(/Reply on WhatsApp/i);
    // Send, then re-type the SAME text and Enter again within the ~800ms dedupe
    // window — the accidental double-fire the composer must swallow.
    await box.fill("dedupe me");
    await box.press("Enter");
    await box.fill("dedupe me");
    await box.press("Enter");
    await page.waitForTimeout(1200);
    expect(posts, "identical rapid resend must fire exactly one POST").toBe(1);
  });

  test("two DIFFERENT rapid sends both go through (concurrency, no blanket lock)", async ({
    page,
  }) => {
    await freshConversation();
    let posts = 0;
    await page.route("**/api/messages", async (route: Route) => {
      if (route.request().method() === "POST") posts += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });
    await openThread(page);
    const box = page.getByPlaceholder(/Reply on WhatsApp/i);
    // The old lock blocked the second send until the first's round-trip
    // finished; distinct messages now send concurrently.
    await box.fill("first message");
    await box.press("Enter");
    await box.fill("second message");
    await box.press("Enter");
    await page.waitForTimeout(1200);
    expect(posts, "two distinct sends must each fire a POST").toBe(2);
  });
});
