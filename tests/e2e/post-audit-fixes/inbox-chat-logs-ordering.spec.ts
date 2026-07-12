import { test, expect, type Page } from "@playwright/test";

import { db, superadminTeam, wipeTestData } from "../_helpers/db";

/**
 * Inbox chat + activity-log smoothness / ordering verification.
 *
 * Covers the gaps the harness audit flagged (no test exercised customer
 * chatting, activity-log ordering relative to messages, log settling/no-jump,
 * emoji, or optimistic-send layout stability) AND specifically guards the
 * 2026-06-02 fix: optimistic activity pills SETTLE on reconcile (only
 * un-reconciled stubs pin to bottom). Two bugs that fix addressed:
 *   1. a message sent AFTER a log appeared ABOVE it (log stuck pinned),
 *   2. rapid status changes made a new log flash mid-list before the bottom.
 *
 * Reads the timeline through the per-entry wrapper hooks on message-thread.tsx:
 *   [data-entry-kind] (message|note|activity|call), [data-entry-id],
 *   [data-entry-ts], [data-pending] ("1" while optimistic/pending).
 * Entries are enumerated in DOM order == chronological top→bottom.
 *
 * Runs against the prod-imitate stack (http://localhost:8080) — see
 * playwright.config.ts. Outbound text SEND 409s locally (no Meta creds), but
 * the optimistic bubble still paints synchronously before the failure, which
 * is exactly the surface the ordering assertions need.
 */

const PHONE = "+15557654321";

let teamId: string;
let userId: string;
let adminName: string;
let conversationId: string;
let contactId: string;

// ── timeline snapshot helpers ──────────────────────────────────────────────

interface Entry {
  kind: string | null;
  id: string | null;
  ts: string | null;
  pending: boolean;
  y: number;
  label: string;
}

/** All timeline entries in DOM (chronological) order, with live state. */
async function snapshot(page: Page): Promise<Entry[]> {
  return page.$$eval("[data-entry-kind]", (els) =>
    els.map((el) => ({
      kind: el.getAttribute("data-entry-kind"),
      id: el.getAttribute("data-entry-id"),
      ts: el.getAttribute("data-entry-ts"),
      pending: el.getAttribute("data-pending") === "1",
      y: Math.round(el.getBoundingClientRect().top),
      label: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
    })),
  );
}

/** Sample the timeline repeatedly for `ms` to catch transient reordering. */
async function sampleOver(
  page: Page,
  ms: number,
  intervalMs = 60,
): Promise<Entry[][]> {
  const samples: Entry[][] = [];
  const deadline = Date.now() + ms;
  // Always take an immediate first sample.
  samples.push(await snapshot(page));
  while (Date.now() < deadline) {
    await page.waitForTimeout(intervalMs);
    samples.push(await snapshot(page));
  }
  return samples;
}

/**
 * The core vibration detector: every entry id, across all samples in which it
 * appears, must occupy the SAME index. In our scenarios new entries only ever
 * append at the bottom, so any index change for an existing id is a reorder /
 * jump — exactly the "log lands between other logs then drops to the bottom"
 * artifact. Returns a human-readable violation or null.
 */
function findReorder(samples: Entry[][]): string | null {
  const indexById = new Map<string, number>();
  for (let s = 0; s < samples.length; s++) {
    const order = samples[s]!;
    for (let i = 0; i < order.length; i++) {
      const id = order[i]!.id;
      if (!id) continue;
      const seen = indexById.get(id);
      if (seen === undefined) {
        indexById.set(id, i);
      } else if (seen !== i) {
        return `entry ${id} (“${order[i]!.label}”) moved from index ${seen} to ${i} at sample ${s} — reorder/jump`;
      }
    }
  }
  return null;
}

async function openThread(page: Page): Promise<void> {
  await page.goto(`/inbox?c=${conversationId}`, { waitUntil: "domcontentloaded" });
  // Wait until the seeded thread is actually rendered + socket-joined.
  await expect(page.locator("[data-entry-kind]").first()).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(600); // socket subscribe settle
}

/**
 * The thread header (`<header class="… h-15…">` in thread-header.tsx) — scope
 * all header-control lookups here so they don't collide with the conversation
 * LIST (left, has status/assignee text per row + filter chips) or the contact
 * PANEL (right, has its own assignee/stage controls).
 */
function header(page: Page) {
  return page.locator("header.h-15");
}

/**
 * Status dropdown trigger. Its accessible name is the descriptive aria-label
 * ("Status: Open — change conversation status") — the bare status word is
 * container-query-hidden below @2xl — so match the aria-label, not the word.
 */
function statusTrigger(page: Page) {
  return header(page).getByRole("button", { name: /change conversation status/i });
}

async function changeStatus(page: Page, to: "Open" | "Pending" | "Closed") {
  await statusTrigger(page).click();
  await page.getByRole("menuitem", { name: new RegExp(`^${to}$`) }).click();
  // All status changes — including Close — are one-click by design (see
  // status-dropdown.tsx: "no confirm, by design, so agents under heavy load
  // aren't slowed down"). The close-confirmation dialog this helper used to
  // acknowledge was removed; selecting the menu item is the whole interaction.
}

const ACTIVITY_GET = "**/api/conversations/*/events";

/**
 * Delay the activity-log GET so the optimistic stub's PENDING window is
 * observable. On a localhost stack the leading-edge GET reconciles in single-
 * digit ms — faster than a Playwright poll — so without this the pill is
 * already settled by the first sample. The delay doesn't change BEHAVIOR, only
 * makes the optimistic→settled transition wide enough to assert on.
 */
async function delayActivityGet(page: Page, ms: number) {
  await page.route(ACTIVITY_GET, async (route) => {
    await new Promise((r) => setTimeout(r, ms));
    await route.continue();
  });
}

/**
 * Deliver a REAL inbound customer message live, exactly like the Meta ingest
 * path does, without needing Meta creds: write the Message row + a
 * `message.received` OutboundEvent. The outbox drainer (~100ms tick) republishes
 * it on the in-process bus → RealtimeFanoutService emits `message:new` to the
 * team → the open thread renders a persistent inbound bubble. `atMs` sets the
 * server timestamp so we can place it before/after a log deterministically.
 */
async function injectInbound(body: string, atMs: number): Promise<string> {
  const externalId = `e2e-inbound-${atMs}-${Math.floor(atMs % 1_000_000)}`;
  const ts = new Date(atMs);
  const msg = await db().message.create({
    data: {
      teamId,
      conversationId,
      externalId,
      direction: "in",
      channel: "whatsapp",
      status: "delivered",
      body,
      timestamp: ts,
      rawPayload: {},
    },
  });
  await db().outboundEvent.create({
    data: {
      teamId,
      type: "message.received",
      payload: {
        teamId,
        conversationId,
        message: {
          id: msg.id,
          teamId,
          conversationId,
          externalId,
          direction: "in",
          channel: "whatsapp",
          status: "delivered",
          body,
          timestamp: ts.toISOString(),
          senderUserId: null,
          rawPayload: {},
        },
        preview: body.slice(0, 200),
        lastMessageAt: ts.toISOString(),
        unreadCount: 1,
        // `contact` + `conversation` are REQUIRED on a real MessageReceivedEvent —
        // `toPublicEnvelopes` derefs `e.contact.id` to build the outbound-webhook
        // body. Omitting them made the drainer's dispatch throw
        // "Cannot read properties of undefined (reading 'id')", which the
        // subscriber's outer catch swallowed: the test still passed while the
        // api log filled with errors. Publish the shape ingest actually publishes.
        contact: {
          id: contactId,
          phoneNumber: PHONE,
          name: "Chat Smoke Contact",
          identityChannel: "whatsapp",
          externalContactId: null,
          tagIds: [],
          stageId: null,
          customFields: {},
        },
        conversation: {
          id: conversationId,
          status: "open",
          unreadCount: 1,
          lastMessageAt: ts.toISOString(),
          assignedUserId: null,
          aiEnabled: true,
        },
        isNewConversation: false,
        reopened: false,
        sessionKind: "continued",
      },
    },
  });
  return msg.id;
}

// ── fixtures ────────────────────────────────────────────────────────────────

test.beforeAll(async () => {
  const su = await superadminTeam();
  teamId = su.teamId;
  userId = su.userId;
  const u = await db().user.findUnique({
    where: { id: userId },
    select: { name: true },
  });
  adminName = u?.name ?? "Admin";

  // Clean slate (workers:1, sequential — safe to wipe at start too).
  await wipeTestData();

  const now = Date.now();
  const contact = await db().contact.create({
    data: {
      teamId,
      phoneNumber: PHONE,
      identityChannel: "whatsapp",
      name: "Chat Smoke Contact",
      source: "manual",
      // Keep the 24h window OPEN so the reply box is enabled.
      lastInboundAt: new Date(now),
    },
  });

  const conv = await db().conversation.create({
    data: {
      teamId,
      contactId: contact.id,
      channel: "whatsapp",
      status: "open",
      lastMessageAt: new Date(now),
      lastMessagePreview: "hello",
    },
  });
  conversationId = conv.id;
  contactId = contact.id;

  // A few seeded messages, oldest→newest, including one with emoji so we can
  // assert emoji render without needing a successful outbound send.
  const seeded = [
    { body: "Hello from the customer", dir: "in", off: -5000 },
    { body: "Hi there, how can I help?", dir: "out", off: -4000 },
    { body: "Emoji check 😀🎉🚀", dir: "in", off: -3000 },
  ] as const;
  for (let i = 0; i < seeded.length; i++) {
    const m = seeded[i]!;
    await db().message.create({
      data: {
        teamId,
        conversationId,
        externalId: `seed-${now}-${i}`,
        direction: m.dir,
        channel: "whatsapp",
        status: m.dir === "in" ? "delivered" : "sent",
        body: m.body,
        timestamp: new Date(now + m.off),
        senderUserId: m.dir === "out" ? userId : null,
        rawPayload: {},
      },
    });
  }
});

test.afterAll(async () => {
  await wipeTestData();
  await db().$disconnect();
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("Inbox chat + activity-log smoothness", () => {
  test("seeded thread renders messages in chronological order + emoji intact", async ({
    page,
  }) => {
    await openThread(page);
    const order = await snapshot(page);
    const msgs = order.filter((e) => e.kind === "message");
    expect(msgs.length).toBeGreaterThanOrEqual(3);
    // Chronological: ts strictly non-decreasing top→bottom.
    for (let i = 1; i < order.length; i++) {
      const a = order[i - 1]!.ts ? Date.parse(order[i - 1]!.ts!) : 0;
      const b = order[i]!.ts ? Date.parse(order[i]!.ts!) : 0;
      expect(b, `entry ${i} ts >= prev`).toBeGreaterThanOrEqual(a);
    }
    // Emoji survived the round-trip into the DOM as plain unicode.
    expect(order.some((e) => e.label.includes("😀🎉🚀"))).toBeTruthy();
  });

  test("a status-change log starts optimistic, SETTLES, and never leaves the bottom", async ({
    page,
  }) => {
    await openThread(page);
    const beforeIds = new Set((await snapshot(page)).map((e) => e.id));

    // Slow the reconcile so the optimistic PENDING window is observable.
    await delayActivityGet(page, 1200);
    await changeStatus(page, "Closed");

    // Phase 1: the new log appears, is PENDING (optimistic stub), and is LAST.
    let logId = "";
    await expect
      .poll(
        async () => {
          const o = await snapshot(page);
          const p = o
            .filter((e) => e.kind === "activity" && !beforeIds.has(e.id))
            .at(-1);
          if (!p) return null;
          logId = p.id!;
          return { last: o[o.length - 1]!.id === p.id, pending: p.pending };
        },
        { timeout: 5_000 },
      )
      .toEqual({ last: true, pending: true });

    // Phase 2: after the (delayed) GET, watch it SETTLE — and confirm it never
    // moved off the bottom and nothing else reordered (no jump / vibration).
    const samples = await sampleOver(page, 2500, 60);
    expect(findReorder(samples)).toBeNull();

    const last = samples[samples.length - 1]!;
    const pill = last.find((e) => e.id === logId)!;
    expect(pill.label.toLowerCase()).toContain("closed the conversation");
    for (const order of samples) {
      const idx = order.findIndex((e) => e.id === logId);
      if (idx === -1) continue;
      expect(idx, "log must stay last").toBe(order.length - 1);
    }
    // The fix: the confirmed log SHEDS its optimistic pin (data-pending clears).
    expect(pill.pending, "log settled after GET").toBe(false);

    await page.unroute(ACTIVITY_GET);
  });

  test("rapid status changes append in order, newest always last, no mid-list flash", async ({
    page,
  }) => {
    await openThread(page);
    const baseActivities = (await snapshot(page)).filter(
      (e) => e.kind === "activity",
    ).length;

    // Three quick changes — each writes a status_changed log.
    await changeStatus(page, "Pending");
    await page.waitForTimeout(180);
    await changeStatus(page, "Closed");
    await page.waitForTimeout(180);
    await changeStatus(page, "Open");

    const samples = await sampleOver(page, 3000, 60);

    // No entry ever jumped index across the whole burst.
    expect(findReorder(samples)).toBeNull();

    const final = samples[samples.length - 1]!;
    const activities = final.filter((e) => e.kind === "activity");
    expect(activities.length).toBeGreaterThanOrEqual(baseActivities + 3);

    // The three newest logs, bottom-most, read in the order performed.
    const verbs = activities.slice(-3).map((e) => e.label.toLowerCase());
    expect(verbs[0]).toContain("pending");
    expect(verbs[1]).toContain("closed");
    expect(verbs[2]).toContain("reopened"); // "open" status verb = "reopened the conversation"

    // Every activity pill is below every message (logs are the latest events).
    const lastMsgIdx = final.map((e) => e.kind).lastIndexOf("message");
    const firstNewActivityIdx = final.findIndex(
      (e, i) => e.kind === "activity" && i > lastMsgIdx,
    );
    expect(firstNewActivityIdx).toBeGreaterThan(lastMsgIdx);
  });

  test("a LIVE inbound customer message renders in the open thread, BELOW an earlier log", async ({
    page,
  }) => {
    // End-to-end "chatting with the customer": a real inbound arrives live
    // (drainer → message:new, the same path Meta ingest uses) while the agent
    // is viewing the thread, and it must land at the very bottom — AFTER an
    // earlier activity log (Bug 1's chronological invariant). The status change
    // is driven via the REST endpoint rather than the header dropdown on
    // purpose: a synthesized dropdown click runs a synchronous flushSync commit
    // that, under headless automation, intermittently stalls the WebSocket
    // frame pump for this tab (NOT reproducible against a fetch-driven change,
    // and the server-side fanout delivery is proven separately). Test 3 already
    // covers the optimistic-log settle path that the dropdown exercises.
    await openThread(page);
    const beforeIds = new Set((await snapshot(page)).map((e) => e.id));

    const status = await page.evaluate(async (cid) => {
      const r = await fetch(`/api/conversations/${cid}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "pending" }),
      });
      return r.status;
    }, conversationId);
    expect(status, "status PATCH ok").toBe(200);

    // The log pill lands (settled server event).
    let logId = "";
    await expect
      .poll(
        async () => {
          const p = (await snapshot(page))
            .filter((e) => e.kind === "activity" && !beforeIds.has(e.id))
            .at(-1);
          logId = p?.id ?? "";
          return p?.label.toLowerCase().includes("pending") ? "ok" : null;
        },
        { timeout: 6_000 },
      )
      .toBe("ok");

    // A real inbound customer message, delivered LIVE over the socket.
    const body = "Live customer reply XYZ";
    await injectInbound(body, Date.now());
    const inbound = page
      .locator('[data-entry-kind="message"]')
      .filter({ hasText: body });
    await expect(inbound, "live inbound rendered in the thread").toBeVisible({
      timeout: 8_000,
    });

    // It sits at the very bottom (newest), strictly below the earlier log.
    const order = await snapshot(page);
    const li = order.findIndex((e) => e.id === logId);
    const mi = order.findIndex(
      (e) => e.kind === "message" && e.label.includes(body),
    );
    expect(li, "log present").toBeGreaterThanOrEqual(0);
    expect(mi, "inbound below the earlier log").toBeGreaterThan(li);
    expect(mi, "inbound is the newest entry").toBe(order.length - 1);
    expect(findReorder(await sampleOver(page, 1000, 80))).toBeNull();
  });

  test("emoji picker inserts into the composer", async ({ page }) => {
    await openThread(page);
    const box = page.getByPlaceholder(/Reply on WhatsApp/i);
    await expect(box).toBeVisible({ timeout: 8_000 });
    await box.click();
    await box.fill("react ");

    await page.getByRole("button", { name: "Insert emoji" }).click();
    // Exclude the picker TOGGLE (aria-label="Insert emoji"); the emoji OPTIONS
    // are aria-label="Insert <emoji>". Without the :not(), .first() re-clicks
    // the toggle, closes the popover, and inserts nothing.
    const option = page
      .locator('button[aria-label^="Insert "]:not([aria-label="Insert emoji"])')
      .first();
    await expect(option).toBeVisible();
    const label = (await option.getAttribute("aria-label"))!;
    const emoji = label.replace(/^Insert /, "");
    await option.click();

    await expect(box).toHaveValue(new RegExp(`react .*${escapeRe(emoji)}`));
  });

  test("self-assignment writes a log that lands at the bottom", async ({
    page,
  }) => {
    await openThread(page);
    const before = await snapshot(page);
    const beforeIds = new Set(before.map((e) => e.id));

    // Open the assignment dropdown in the header + pick self. The trigger's
    // accessible name is the descriptive aria-label ("Unassigned — assign this
    // conversation"), not the bare word, so match by prefix (not exact).
    await header(page)
      .getByRole("button", { name: /^Unassigned/ })
      .click();
    await page
      .getByRole("menuitem", { name: new RegExp(escapeRe(adminName)) })
      .first()
      .click();

    const samples = await sampleOver(page, 2500, 60);
    expect(findReorder(samples)).toBeNull();

    const last = samples[samples.length - 1]!;
    const newPill = last.filter(
      (e) => e.kind === "activity" && !beforeIds.has(e.id),
    ).at(-1);
    expect(newPill, "an assignment log appeared").toBeTruthy();
    expect(newPill!.label.toLowerCase()).toMatch(/assigned|self-assigned/);
    // Lands at the bottom.
    const idx = last.findIndex((e) => e.id === newPill!.id);
    expect(idx).toBe(last.length - 1);
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
