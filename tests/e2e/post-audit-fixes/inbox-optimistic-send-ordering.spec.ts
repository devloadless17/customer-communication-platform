import { test, expect, type Page, type Route } from "@playwright/test";

import { db, superadminTeam, wipeTestData } from "../_helpers/db";

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
}

async function snapshot(page: Page): Promise<Entry[]> {
  return page.$$eval("[data-entry-kind]", (els) =>
    els.map((el) => ({
      kind: el.getAttribute("data-entry-kind"),
      id: el.getAttribute("data-entry-id"),
      pending: el.getAttribute("data-pending") === "1",
      label: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
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
  const su = await superadminTeam();
  teamId = su.teamId;
  userId = su.userId;
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
});
