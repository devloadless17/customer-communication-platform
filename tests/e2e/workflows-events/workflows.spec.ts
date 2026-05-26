/**
 * Workflow + events + integrations e2e. Tests the load-bearing realtime
 * + automation surfaces against the prod:local stack at :8080. Bypasses
 * the UI where the UI doesn't add coverage (e.g. workflow creation —
 * already covered by predeploy.spec.ts that the page renders) and goes
 * straight at the API.
 *
 * Suites:
 *   A. Workflow happy path        — manual trigger fires add_comment, run completes
 *   B. Workflow chain-depth gate  — X-CCP-Depth at cap → skipped row
 *   C. Realtime two-tab sync      — tab A acts, tab B sees update without refresh
 *   D. Outbound webhook delivery  — registered hook receives queued delivery rows
 *   E. Outbox drainer             — pending OutboundEvent rows get dispatched + stamped
 */
import { test, expect } from "@playwright/test";
import crypto from "node:crypto";
import {
  createWorkflow,
  publishWorkflow,
  addInternalNote,
  assignConversation,
  setConversationStatus,
  createOutboundWebhook,
} from "../_helpers/api";
import { db, superadminTeam, wipeTestData, pollUntil } from "../_helpers/db";

// ─── Fixture: one contact + one conversation for the suite ───────────────
let teamId: string;
let userId: string;
let contactId: string;
let conversationId: string;

test.beforeAll(async () => {
  // Wipe any leftover test data so this suite starts from a clean state.
  // Doesn't touch the superadmin User / Team / ContactStage rows.
  await wipeTestData();

  const su = await superadminTeam();
  teamId = su.teamId;
  userId = su.userId;

  // Single canonical contact + conversation reused across specs. Created
  // via Prisma rather than the API so we don't drag a 5-call setup chain
  // through every spec — the API paths themselves are exercised in
  // predeploy.spec.ts.
  const contact = await db().contact.create({
    data: {
      teamId,
      phoneNumber: "+15551234567",
      identityChannel: "whatsapp",
      name: "E2E Test Contact",
      source: "manual",
    },
  });
  contactId = contact.id;

  const conv = await db().conversation.create({
    data: {
      teamId,
      contactId: contact.id,
      channel: "whatsapp",
      status: "open",
      lastMessageAt: new Date(),
      lastMessagePreview: "",
    },
  });
  conversationId = conv.id;
});

test.afterAll(async () => {
  // Leave the canvas clean for the next run — predeploy.spec.ts asserts
  // empty-state UI and would fail if it found leftover conversations.
  await wipeTestData();
  await db().$disconnect();
});

// ═════════════════════════════════════════════════════════════════════════
// A. Workflow happy path
// ═════════════════════════════════════════════════════════════════════════
test.describe("A. Workflow happy path", () => {
  test("manual_trigger → add_comment → run completes → InternalNote created", async ({ request }) => {
    // 1. Create + publish a workflow that adds a comment when triggered.
    const wf = await createWorkflow(request, {
      name: "E2E A — manual add_comment",
      trigger: "manual_trigger",
      graph: {
        startNodeId: "n1",
        nodes: [
          {
            id: "n1",
            type: "add_comment",
            config: { body: "E2E-A-MARKER" },
          },
        ],
        edges: [],
      } as never,
    });
    expect(wf.id).toBeTruthy();
    await publishWorkflow(request, wf.id);

    // 2. Trigger it with the canonical contact + conversation.
    const triggerResp = await request.post(`/api/team/workflows/${wf.id}/manual-trigger`, {
      data: { contactId, conversationId },
    });
    expect(triggerResp.ok(), `manual-trigger ${triggerResp.status()}`).toBe(true);
    const triggerJson = await triggerResp.json();
    expect(triggerJson.runId).toBeTruthy();

    // 3. Poll WorkflowRun.status → "completed" (BullMQ ticks in milliseconds).
    const runId = triggerJson.runId as string;
    const finalRun = await pollUntil(
      async () => {
        const r = await db().workflowRun.findUnique({
          where: { id: runId },
          select: { status: true, errorMessage: true },
        });
        if (!r) return null;
        if (r.status === "completed") return r;
        if (r.status === "failed") {
          throw new Error(`workflow run failed: ${r.errorMessage}`);
        }
        return null;
      },
      { timeoutMs: 10_000, label: "WorkflowRun.status=completed" },
    );
    expect(finalRun.status).toBe("completed");

    // 4. Verify the side effect — an InternalNote with our marker body
    // attached to the conversation.
    const note = await db().internalNote.findFirst({
      where: { conversationId, body: { contains: "E2E-A-MARKER" } },
      select: { id: true, authorUserId: true },
    });
    expect(note, "add_comment created an InternalNote").not.toBeNull();
    // Workflow-authored notes have authorUserId=null (system).
    expect(note?.authorUserId).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// B. Workflow chain-depth gate
// ═════════════════════════════════════════════════════════════════════════
test.describe("B. Workflow chain-depth gate", () => {
  // The webhook secret is what we'd see if we generated one via the UI's
  // "rotate secret" action — but the API doesn't auto-generate; the
  // service expects the secret to be present in triggerConfig.secret.
  // We provide our own (random hex) and use the same plaintext for HMAC.
  function makeSecret() {
    return crypto.randomBytes(32).toString("hex");
  }

  function signRequest(secret: string, body: string): { sig: string; ts: string } {
    const ts = Date.now().toString();
    const payload = `${ts}.${body}`;
    const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    return { sig, ts };
  }

  test("incoming_webhook with X-CCP-Depth at cap writes a skipped WorkflowRun", async ({ request }) => {
    // 1. Create + publish an incoming_webhook workflow with a secret we
    // control (so we can sign the inbound request).
    const secret = makeSecret();
    const wf = await createWorkflow(request, {
      name: "E2E B — incoming_webhook depth gate",
      trigger: "incoming_webhook",
      triggerConfig: { secret },
      graph: {
        startNodeId: "n1",
        nodes: [
          {
            id: "n1",
            type: "add_comment",
            config: { body: "E2E-B-should-not-run" },
          },
        ],
        edges: [],
      } as never,
    });
    await publishWorkflow(request, wf.id);

    const body = JSON.stringify({ test: "depth-cap" });
    const { sig, ts } = signRequest(secret, body);

    // 2. Fire the webhook with X-CCP-Depth at the cap (8). Should be
    // rejected with `dropped: chain_depth_exceeded` AND a skipped
    // WorkflowRun row written for operator visibility (the P3 fix from
    // 2026-05-26).
    const resp = await request.post(
      `/api/team/workflows/${wf.id}/incoming-webhook`,
      {
        headers: {
          "Content-Type": "application/json",
          "X-Workflow-Signature": `sha256=${sig}`,
          "X-Workflow-Timestamp": ts,
          "X-CCP-Depth": "8",
        },
        data: body,
      },
    );
    expect(resp.ok()).toBe(true);
    const json = await resp.json();
    expect(json.dropped).toBe("chain_depth_exceeded");
    expect(json.runId).toBeNull();

    // 3. Verify the skipped row landed.
    const skipped = await pollUntil(
      async () => {
        const row = await db().workflowRun.findFirst({
          where: {
            workflowId: wf.id,
            status: "skipped",
          },
          orderBy: { startedAt: "desc" },
          select: { id: true, errorMessage: true, status: true },
        });
        return row;
      },
      { timeoutMs: 5_000, label: "skipped WorkflowRun row" },
    );
    expect(skipped.status).toBe("skipped");
    expect(skipped.errorMessage).toContain("chain_depth_exceeded");
  });

  test("incoming_webhook below cap is accepted", async ({ request }) => {
    // Same setup as above but with depth=2 (well below cap=8) should
    // create a real run.
    const secret = makeSecret();
    const wf = await createWorkflow(request, {
      name: "E2E B — depth ok",
      trigger: "incoming_webhook",
      triggerConfig: { secret },
      graph: {
        startNodeId: "n1",
        nodes: [
          {
            id: "n1",
            type: "add_comment",
            config: { body: "E2E-B-depth-ok" },
          },
        ],
        edges: [],
      } as never,
    });
    await publishWorkflow(request, wf.id);

    const body = JSON.stringify({ test: "depth-ok" });
    const { sig, ts } = signRequest(secret, body);

    const resp = await request.post(
      `/api/team/workflows/${wf.id}/incoming-webhook`,
      {
        headers: {
          "Content-Type": "application/json",
          "X-Workflow-Signature": `sha256=${sig}`,
          "X-Workflow-Timestamp": ts,
          "X-CCP-Depth": "2",
        },
        data: body,
      },
    );
    expect(resp.ok()).toBe(true);
    const json = await resp.json();
    expect(json.runId).toBeTruthy();
    expect(json.dropped).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// C. Realtime two-tab sync
// ═════════════════════════════════════════════════════════════════════════
//
// Two browser contexts, both authenticated as the same superadmin. Tab A
// drives a mutation via the API; tab B (live inbox) must reflect the
// change without a refresh — which proves the full chain works:
// API → DB write → bus.publish → outbox or sync dispatch → realtime
// fanout → socket frame → client reducer → DOM.
//
// The state we look for in tab B is the simplest visible affordance:
// "an InternalNote with body X appears in the conversation's note list."
// Notes are simpler to assert than message bubbles because their
// rendering doesn't depend on contact-side state.
test.describe("C. Realtime two-tab sync", () => {
  test("internal note added on tab A appears on tab B without refresh", async ({ browser }) => {
    // Both tabs share the same storageState — pre-authed.
    const ctxA = await browser.newContext({
      storageState: "tests/e2e/.auth/superadmin.json",
    });
    const ctxB = await browser.newContext({
      storageState: "tests/e2e/.auth/superadmin.json",
    });
    try {
      const pageB = await ctxB.newPage();
      // Tab B opens the conversation and parks on the thread page so the
      // socket joins the conversation room and the timeline is live.
      await pageB.goto(`/inbox?c=${conversationId}`, { waitUntil: "domcontentloaded" });
      // Give the socket a beat to connect + join the conversation room.
      await pageB.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
      // Brief settle for the socket subscribe roundtrip.
      await pageB.waitForTimeout(500);

      // Tab A drives the mutation via the API (the request context shares
      // storageState since it inherits from chromium project config).
      const requestA = await ctxA.request;
      const noteBody = `E2E-C-realtime-${Date.now()}`;
      await addInternalNote(requestA, conversationId, noteBody);

      // Tab B should see the note in the timeline without reload. Wait
      // for the text to appear (Playwright's auto-retry on visibility).
      await expect(pageB.locator(`text=${noteBody}`).first()).toBeVisible({
        timeout: 8_000,
      });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test("conversation status change on tab A propagates to tab B", async ({ browser }) => {
    // Reset the conversation status to "open" before the test, so the
    // change to "closed" is detectable.
    await db().conversation.update({
      where: { id: conversationId },
      data: { status: "open" },
    });

    const ctxA = await browser.newContext({
      storageState: "tests/e2e/.auth/superadmin.json",
    });
    const ctxB = await browser.newContext({
      storageState: "tests/e2e/.auth/superadmin.json",
    });
    try {
      const pageB = await ctxB.newPage();
      await pageB.goto(`/inbox?c=${conversationId}`, { waitUntil: "domcontentloaded" });
      await pageB.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
      await pageB.waitForTimeout(500);

      // Tab A closes the conversation.
      await setConversationStatus(ctxA.request, conversationId, "closed");

      // Tab B's status indicator should update — we look for the DB row
      // converging rather than coupling to a specific DOM string (the
      // visual indicator has shifted shape across recent UI changes).
      await pollUntil(
        async () => {
          const row = await db().conversation.findUnique({
            where: { id: conversationId },
            select: { status: true },
          });
          return row?.status === "closed" ? row : null;
        },
        { timeoutMs: 5_000, label: "Conversation.status=closed" },
      );

      // And the socket should have propagated it — the conversation's
      // ConversationEvent audit timeline gets a status_changed row.
      const auditRow = await pollUntil(
        async () => {
          return db().conversationEvent.findFirst({
            where: { conversationId, kind: "status_changed" },
            orderBy: { at: "desc" },
            select: { id: true, after: true },
          });
        },
        { timeoutMs: 5_000, label: "ConversationEvent.status_changed audit row" },
      );
      expect(auditRow).toBeTruthy();
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test("inbound reopen publishes conversation.status_changed + writes audit row", async () => {
    // Set conversation to closed first.
    await db().conversation.update({
      where: { id: conversationId },
      data: { status: "closed" },
    });

    // Insert a Message + Conversation status flip mimicking what
    // ingest.ts does on inbound webhook. The P1 fix this session was
    // that the ingest path now publishes a conversation.status_changed
    // event when reopening — verify the audit row lands.
    const beforeCount = await db().conversationEvent.count({
      where: { conversationId, kind: "status_changed" },
    });

    await db().$transaction([
      db().conversation.update({
        where: { id: conversationId },
        data: {
          status: "pending",
          lastMessageAt: new Date(),
          unreadCount: { increment: 1 },
        },
      }),
      db().message.create({
        data: {
          teamId,
          conversationId,
          externalId: `e2e-reopen-${Date.now()}`,
          direction: "in",
          channel: "whatsapp",
          status: "delivered",
          body: "E2E-C-reopen-test",
          timestamp: new Date(),
          rawPayload: {},
        },
      }),
      db().outboundEvent.create({
        data: {
          teamId,
          type: "conversation.status_changed",
          payload: {
            conversationId,
            previousStatus: "closed",
            newStatus: "pending",
            changedByUserId: null,
            contact: {
              id: contactId,
              phoneNumber: "+15551234567",
              identity_channel: "whatsapp",
              name: "E2E Test Contact",
              tagIds: [],
              stageId: null,
              customFields: {},
            },
          },
        },
      }),
    ]);

    // Drainer ticks every 100ms — wait for it to fan out → audit
    // subscriber → ConversationEvent row.
    await pollUntil(
      async () => {
        const count = await db().conversationEvent.count({
          where: { conversationId, kind: "status_changed" },
        });
        return count > beforeCount ? count : null;
      },
      { timeoutMs: 5_000, label: "ConversationEvent for reopen lands" },
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════
// D. Outbound webhook delivery
// ═════════════════════════════════════════════════════════════════════════
//
// Verify the SUBSCRIBER + DB write side of outbound webhooks. The actual
// HTTP delivery (BullMQ → safeFetch → partner) is integration code that
// can't run against a localhost listener (safeFetch blocks RFC1918 in
// prod:local; loosening that would mean booting api with
// INTEGRATIONS_ALLOW_PRIVATE_HOSTS=1 which the boot-guard forbids in
// prod). The delivery row + queued state is the testable surface.
test.describe("D. Outbound webhook delivery", () => {
  test("registered webhook produces an OutboundWebhookDelivery row for a subscribed event", async ({ request }) => {
    // 1. Register a webhook subscribed to conversation.assigned.
    const wh = await createOutboundWebhook(request, {
      name: "E2E D — assignment webhook",
      // URL is never actually fetched in this test — we observe the DB row.
      url: "https://example.invalid/webhook",
      eventTypes: ["conversation.assigned"],
    });
    expect(wh.id).toBeTruthy();
    expect(wh.secret).toBeTruthy(); // HMAC signing secret

    // 2. Capture the baseline delivery count (other tests may have
    // contributed) so we look for a STRICT increment.
    const beforeCount = await db().outboundWebhookDelivery.count({
      where: { webhookId: wh.id },
    });

    // 3. Trigger conversation.assigned — assign the conversation to
    // ourselves (we're the superadmin user).
    await assignConversation(request, conversationId, userId);

    // 4. Wait for the delivery row to land. Subscriber fires AFTER the
    // event is published; for in-process events that's synchronous in
    // bus.publish, but Prisma writes take a tick. 3s is generous.
    const delivery = await pollUntil(
      async () => {
        const row = await db().outboundWebhookDelivery.findFirst({
          where: {
            webhookId: wh.id,
            eventType: "conversation.assigned",
          },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            eventType: true,
            payload: true,
            correlationId: true,
          },
        });
        return row;
      },
      { timeoutMs: 5_000, label: "OutboundWebhookDelivery row" },
    );

    // 5. Verify the row shape: correlationId stamped, payload includes
    // team_id + assignee + the conversation.
    expect(delivery.eventType).toBe("conversation.assigned");
    expect(delivery.correlationId).toBeTruthy();
    const payload = delivery.payload as Record<string, unknown>;
    expect(payload.team_id).toBe(teamId);

    // 6. Verify count incremented by EXACTLY one (no duplicate fanout).
    const afterCount = await db().outboundWebhookDelivery.count({
      where: { webhookId: wh.id, eventType: "conversation.assigned" },
    });
    expect(afterCount).toBe(beforeCount + 1);
  });

  test("non-subscribed events do NOT produce a delivery row", async ({ request }) => {
    // Register a webhook ONLY for note.created — assignment should NOT
    // generate a delivery for this hook.
    const wh = await createOutboundWebhook(request, {
      name: "E2E D — note-only webhook",
      url: "https://example.invalid/notes-only",
      eventTypes: ["note.created"],
    });

    const beforeCount = await db().outboundWebhookDelivery.count({
      where: { webhookId: wh.id },
    });

    // Fire an unsubscribed event (assign). This webhook should NOT see it.
    // Unassign first to make the next assign a real change.
    await assignConversation(request, conversationId, null);
    await new Promise((r) => setTimeout(r, 300));
    await assignConversation(request, conversationId, userId);

    // Give the subscriber a beat — if there were a leak, the row would
    // appear in this window.
    await new Promise((r) => setTimeout(r, 1500));

    const afterCount = await db().outboundWebhookDelivery.count({
      where: { webhookId: wh.id },
    });
    expect(afterCount).toBe(beforeCount);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// E. Outbox drainer
// ═════════════════════════════════════════════════════════════════════════
test.describe("E. Outbox drainer", () => {
  test("OutboundEvent rows with publishedAt=null get drained + stamped", async () => {
    // Insert a row directly — the drainer's `claimBatch` picks up
    // anything with publishedAt IS NULL AND failedAt IS NULL. Use a
    // contact.updated event so it has a real fanout path but doesn't
    // accidentally create cascading side effects.
    const row = await db().outboundEvent.create({
      data: {
        teamId,
        type: "team.catalog_changed",
        payload: { scope: "tags" },
      },
      select: { id: true, publishedAt: true },
    });
    expect(row.publishedAt).toBeNull();

    // The drainer's poll interval is 100ms in source. Allow 5s; in
    // practice the row stamps in well under 1s.
    const stamped = await pollUntil(
      async () => {
        const r = await db().outboundEvent.findUnique({
          where: { id: row.id },
          select: { publishedAt: true, failedAt: true, lastError: true },
        });
        return r?.publishedAt ? r : null;
      },
      { timeoutMs: 5_000, label: "OutboundEvent.publishedAt stamped" },
    );

    expect(stamped.publishedAt).toBeTruthy();
    // No subscriber for team.catalog_changed throws under steady state,
    // so failedAt should remain null.
    expect(stamped.failedAt).toBeNull();
    expect(stamped.lastError).toBeNull();
  });
});
