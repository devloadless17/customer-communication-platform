import { expect, test } from "@playwright/test";

import { E2E_APP_ORG_ID, E2E_APP_WS_ID, appAdmin, db } from "../_helpers/db";

/**
 * The ticket THREAD, driven through the real stack.
 *
 * The unit specs call `lib/tickets/thread.ts` directly, so they prove the domain
 * rules but never touch the guard, the multipart pipe, the controller envelope,
 * the socket frame or a single line of the rebuilt detail page — and that page
 * had ~400 lines of JSX moved in this change. This spec covers exactly that gap:
 * raise a ticket over HTTP, open it in a browser, and hold a conversation in it.
 *
 *   pnpm exec playwright test tests/e2e/post-audit-fixes/ticket-thread-2026-07-31.spec.ts
 */

test.describe("ticket thread", () => {
  test("renders as the page's main pane, and a reply round-trips", async ({ page, request }) => {
    // A conversation to hang the ticket on. Reuses whatever the dev DB already
    // holds rather than seeding a contact — this spec is about the thread, and
    // a fixture that creates customers pollutes the shared dev workspace.
    const convRes = await page.request.get("/api/conversations?limit=1");
    expect(convRes.ok(), "conversations list").toBeTruthy();
    // `{ items: [{ conversation, contact }] }` — the inbox list ships the pair,
    // not a bare conversation.
    const convBody = (await convRes.json()) as {
      items?: Array<{ conversation: { id: string } }>;
    };
    const conversationId = convBody.items?.[0]?.conversation.id;
    test.skip(!conversationId, "dev DB has no conversation to raise a ticket on");

    const created = await page.request.post("/api/tickets", {
      data: {
        conversationId,
        subject: `Thread check ${Date.now()}`,
        description: "Raised by the thread verification spec.",
        priority: "normal",
      },
    });
    expect(created.ok(), `raise ticket: ${created.status()}`).toBeTruthy();
    const { ticket } = (await created.json()) as { ticket: { id: string; number: number } };

    // ---- the envelope carries the thread ---------------------------------
    const detail = await page.request.get(`/api/tickets/${ticket.id}`);
    expect(detail.ok()).toBeTruthy();
    const body = (await detail.json()) as Record<string, unknown>;
    // The four keys the rebuilt page seeds from. A missing one renders an
    // empty thread with no error, which is exactly the failure a typecheck
    // cannot see.
    expect(Object.keys(body)).toEqual(
      expect.arrayContaining(["ticket", "events", "thread", "threadUnreadSinceMessageId"]),
    );
    expect(body.thread).toEqual([]);

    // ---- the page ---------------------------------------------------------
    await page.goto(`/tickets/${ticket.id}`);
    const thread = page.getByRole("heading", { name: "Thread", exact: true });
    await expect(thread).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("No replies yet")).toBeVisible();
    // History is a secondary now — present, but collapsed, so the conversation
    // is what you land on.
    const history = page.locator("details:has(summary:text-is('History'))");
    await expect(history).toBeVisible();
    await expect(history).not.toHaveAttribute("open", /.*/);

    // ---- send, the way a person does --------------------------------------
    const composer = page.getByRole("textbox", { name: "Reply on this ticket" });
    await expect(composer).toBeVisible();
    const said = `Refund approved — 3-5 business days. ${Date.now()}`;
    await composer.fill(said);
    await composer.press("Enter");

    // Optimistic row first, then the server's — either way the text is on
    // screen, and it must SURVIVE the swap rather than flicker out.
    await expect(page.getByText(said)).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1500);
    await expect(page.getByText(said)).toHaveCount(1);

    // ---- it persisted, and stayed OUT of the audit log ---------------------
    const after = (await (await page.request.get(`/api/tickets/${ticket.id}`)).json()) as {
      thread: Array<{ body: string; authorName: string | null }>;
      events: Array<{ body?: string | null }>;
    };
    expect(after.thread).toHaveLength(1);
    expect(after.thread[0]?.body).toBe(said);
    expect(after.thread[0]?.authorName).toBeTruthy();
    // The whole point of the split: the reply is not a log line.
    expect(after.events.some((e) => e.body === said)).toBe(false);

    await page.reload();
    await expect(page.getByText(said)).toBeVisible({ timeout: 30_000 });

    // A reply moves no ticket state — no version bump, so a colleague's open
    // editor cannot 409 because someone answered a question.
    const finalTicket = (await (await page.request.get(`/api/tickets/${ticket.id}`)).json()) as {
      ticket: { version: number };
    };
    expect(finalTicket.ticket.version).toBe(0);

    // ---- an internal note is a NOTE, not a log line -----------------------
    const noted = `Private: do not quote this ${Date.now()}`;
    await page.getByRole("textbox", { name: "Internal note" }).fill(noted);
    await page.getByRole("button", { name: "Add note" }).click();
    // It appears in its own panel, under its own heading...
    const notesPanel = page.locator("section:has(h2:has-text('Internal notes'))");
    await expect(notesPanel.getByText(noted)).toBeVisible({ timeout: 15_000 });
    // ...and nowhere in the audit log, which is what made it unfindable.
    const withLog = (await (await page.request.get(`/api/tickets/${ticket.id}`)).json()) as {
      notes: Array<{ body?: string | null }>;
      events: Array<{ body?: string | null; kind: string }>;
    };
    expect(withLog.notes.some((n) => n.body === noted)).toBe(true);
    expect(withLog.events.some((e) => e.kind === "note")).toBe(false);

    // Leave the shared dev workspace as we found it.
    await page.request.delete(`/api/tickets/${ticket.id}`).catch(() => undefined);
    void request;
  });

  /**
   * The guest side, through the HTTP surface.
   *
   * The vitest specs call `lib/tickets/thread.ts` directly, so they prove the
   * access rule but never cross the session guard or `assertVisible` — the two
   * layers that 404'd escalated-in tickets before. This drives the real routes
   * as a real session, switching the active workspace the way the app does.
   */
  test("a guest workspace reads and answers the same thread over HTTP", async ({ page }) => {
    const stamp = Date.now();
    const api = page.request;

    const convBody = (await (await api.get("/api/conversations?limit=1")).json()) as {
      items?: Array<{ conversation: { id: string } }>;
    };
    const conversationId = convBody.items?.[0]?.conversation.id;
    test.skip(!conversationId, "dev DB has no conversation to raise a ticket on");

    // A sibling department in the SAME organization — escalation is org-scoped.
    // Seeded at the DB rather than over `POST /api/workspaces`, because that
    // route (correctly, per §18) needs ORG authority and the e2e admin only
    // administers a workspace. The `e2e-` id prefix keeps it in the isolation
    // namespace the canary watches.
    const { userId } = await appAdmin();
    const guestWorkspaceId = `e2e-tt-${stamp}`;
    await db().workspace.create({
      data: { id: guestWorkspaceId, name: `TT Guest ${stamp}`, organizationId: E2E_APP_ORG_ID },
    });
    await db().workspaceMember.create({
      data: { userId, workspaceId: guestWorkspaceId, role: "admin" },
    });
    const workspace = { id: guestWorkspaceId };

    let ticketId = "";
    try {
      const created = await api.post("/api/tickets", {
        data: { conversationId, subject: `Escalated thread ${stamp}` },
      });
      expect(created.ok(), `raise ticket: ${created.status()}`).toBeTruthy();
      ticketId = ((await created.json()) as { ticket: { id: string } }).ticket.id;

      const escalated = await api.post(`/api/tickets/${ticketId}/escalate`, {
        data: { targetWorkspaceId: workspace.id, cause: `Needs billing sign-off ${stamp}` },
      });
      expect(escalated.ok(), `escalate: ${escalated.status()}`).toBeTruthy();

      // The owner speaks first.
      const asked = `Can you approve this? ${stamp}`;
      const posted = await api.post(`/api/tickets/${ticketId}/thread`, {
        multipart: { body: asked },
      });
      expect(posted.ok(), `owner post: ${posted.status()}`).toBeTruthy();

      // ---- become the guest department --------------------------------
      const switched = await api.post("/api/workspaces/active", {
        data: { workspaceId: workspace.id },
      });
      expect(switched.ok(), `switch: ${switched.status()}`).toBeTruthy();

      // The guest reads the SAME ticket — one row, one thread. This is the
      // read that used to 404 when a caller hand-wrote `{ id, workspaceId }`
      // instead of composing the access gate.
      const guestDetail = await api.get(`/api/tickets/${ticketId}`);
      expect(guestDetail.ok(), `guest read: ${guestDetail.status()}`).toBeTruthy();
      const guestBody = (await guestDetail.json()) as {
        ticket: { sharing?: { role: string } };
        thread: Array<{ body: string; authorWorkspaceName: string | null }>;
      };
      expect(guestBody.ticket.sharing?.role).toBe("guest");
      expect(guestBody.thread.map((m) => m.body)).toContain(asked);
      // Author identity resolved ACROSS the boundary — the guest's own roster
      // has never seen this person, so a client-side lookup would render blank.
      expect(guestBody.thread[0]?.authorWorkspaceName).toBeTruthy();

      // ...and answers in it.
      const answered = `Approved ${stamp}`;
      const guestPost = await api.post(`/api/tickets/${ticketId}/thread`, {
        multipart: { body: answered },
      });
      expect(guestPost.ok(), `guest post: ${guestPost.status()}`).toBeTruthy();

      // A note the OWNER wrote must not reach the guest's detail read — the
      // composer promises exactly that, and the read that leaked it was the
      // ticket detail envelope.
      const ownerNote = `owner private ${stamp}`;
      const backForNote = await api.post("/api/workspaces/active", {
        data: { workspaceId: E2E_APP_WS_ID },
      });
      expect(backForNote.ok()).toBeTruthy();
      expect(
        (await api.post(`/api/tickets/${ticketId}/notes`, { data: { body: ownerNote } })).ok(),
      ).toBeTruthy();
      expect(
        (await api.post("/api/workspaces/active", { data: { workspaceId: workspace.id } })).ok(),
      ).toBeTruthy();
      const guestSees = (await (await api.get(`/api/tickets/${ticketId}`)).json()) as {
        notes: Array<{ body?: string | null }>;
        events: Array<{ body?: string | null }>;
      };
      expect(guestSees.notes.some((n) => n.body === ownerNote)).toBe(false);
      expect(guestSees.events.some((e) => e.body === ownerNote)).toBe(false);

      // The DELETE affordance must not be offered to a guest. `deleteTicket` is
      // deliberately owner-only (§18), so a Delete button here can only ever
      // error with the ticket still sitting there — which is exactly what an
      // admin in the receiving workspace hit.
      await page.goto(`/tickets/${ticketId}`);
      await expect(page.getByRole("heading", { name: "Thread", exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);
      // ...and the API refuses it even if someone calls it directly.
      expect((await api.delete(`/api/tickets/${ticketId}`)).status()).toBe(404);

      // Marking read is per-user and must not 404 for a guest either.
      expect((await api.post(`/api/tickets/${ticketId}/thread/read`)).ok()).toBeTruthy();

      // Back on the owner's side: one thread, both voices, no log pollution.
      const back = await api.post("/api/workspaces/active", {
        data: { workspaceId: E2E_APP_WS_ID },
      });
      expect(back.ok()).toBeTruthy();
      const ownerBody = (await (await api.get(`/api/tickets/${ticketId}`)).json()) as {
        thread: Array<{ body: string }>;
        events: Array<{ body?: string | null }>;
      };
      expect(ownerBody.thread.map((m) => m.body)).toEqual([asked, answered]);
      expect(ownerBody.events.some((e) => e.body === answered)).toBe(false);
    } finally {
      // Always land back on the real workspace, then take the fixture with us —
      // this DB is shared with the maintainer's dev app.
      await api
        .post("/api/workspaces/active", { data: { workspaceId: E2E_APP_WS_ID } })
        .catch(() => undefined);
      if (ticketId) await api.delete(`/api/tickets/${ticketId}`).catch(() => undefined);
      // Scoped to the id we just made — never a bare deleteMany (this DB is the
      // maintainer's dev app; see scripts/check-test-isolation.mjs).
      await db()
        .workspace.delete({ where: { id: guestWorkspaceId } })
        .catch(() => undefined);
    }
  });
});
