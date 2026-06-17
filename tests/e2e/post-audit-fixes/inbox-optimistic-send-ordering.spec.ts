import { test, expect, type Page, type Route } from "@playwright/test";

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

let teamId: string;
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
      teamId,
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
      teamId,
      type: "message.sent",
      payload: {
        teamId,
        conversationId,
        contactId,
        message: {
          id: msg.id,
          teamId,
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
      teamId,
      type,
      payload: {
        teamId,
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
async function injectAutoClaimTrio(occurredAtIso: string): Promise<void> {
  await injectConversationEvent("conversation.ai_changed", {
    previousAiEnabled: true,
    newAiEnabled: false,
    occurredAt: occurredAtIso,
  });
  await injectConversationEvent("conversation.assigned", {
    previousAssignedUserId: null,
    newAssignedUserId: userId,
    assignedUser: {
      id: userId,
      teamId,
      name: "E2E Admin",
      email: "e2e@example.io",
      role: "admin",
      isActive: true,
    },
  });
  await injectConversationEvent("conversation.status_changed", {
    previousStatus: "pending",
    newStatus: "open",
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
      teamId,
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
      teamId,
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
      teamId,
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
  // appAdmin().teamId === superadminTeam().teamId (same seeded team), so this
  // doesn't move the team the fixtures live in.
  const admin = await appAdmin();
  teamId = admin.teamId;
  userId = admin.userId;
  await wipeTestData();
});

test.afterAll(async () => {
  // Leave AI autopilot off for other suites sharing this team.
  await db().team.update({ where: { id: teamId }, data: { aiAutopilotEnabled: false } });
  await wipeTestData();
  await db().$disconnect();
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("Inbox outbound-send ordering (2026-06-16 fix)", () => {
  test("rapid sends with OUT-OF-ORDER confirmation never reorder (symptom 2)", async ({
    page,
  }) => {
    await freshConversation();
    await db().team.update({
      where: { id: teamId },
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
    await db().team.update({
      where: { id: teamId },
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
    await db().team.update({
      where: { id: teamId },
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
    await db().team.update({
      where: { id: teamId },
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
        teamId,
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
    await db().team.update({
      where: { id: teamId },
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
    await injectAutoClaimTrio(new Date(base).toISOString());

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
    await db().team.update({
      where: { id: teamId },
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
    await injectAutoClaimTrio(new Date(base).toISOString());
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
    await injectAutoClaimTrio(new Date(base + 10000).toISOString());
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
});
