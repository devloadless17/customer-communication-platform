/**
 * POST /v1/contacts/:id/stage — the dedicated, discoverable lifecycle-stage
 * endpoint for the Organization API (2026-06-18). Previously a stage could only
 * be changed via PATCH /contacts/:id (buried), with no sibling to assign/status.
 *
 * Asserts FULL UI PARITY: it changes the stage AND fires
 * `contact.lifecycle_changed` (proven by the `stage_changed` pill the audit
 * subscriber writes into the contact's conversation timeline), validates the
 * target (400 `stage_not_found` for an unknown id), and is auth-gated.
 *
 * The /v1 surface is plain HTTP (no Meta wire), so this runs end-to-end against
 * the dev stack with a real seeded API key.
 */
import { test, expect } from "@playwright/test";

import { generateApiKey } from "../../../apps/api/src/auth/api-key";
import { db, superadminTeam, wipeTestData } from "../_helpers/db";

let teamId: string;
let userId: string;
let apiToken: string;
let contactId: string;
let conversationId: string;
let leadStageId: string;
let customerStageId: string;

test.beforeAll(async () => {
  await wipeTestData();
  const su = await superadminTeam();
  teamId = su.teamId;
  userId = su.userId;

  // wipeTestData intentionally KEEPS ContactStage seeded, so clear our own
  // fixtures by name before recreating (FK: the contact must go first).
  await db().contact.deleteMany({
    where: { teamId, phoneNumber: "+15557778888" },
  });
  await db().contactStage.deleteMany({
    where: { teamId, name: { in: ["E2E Lead", "E2E Customer"] } },
  });

  const key = generateApiKey();
  await db().teamApiKey.create({
    data: {
      teamId,
      name: "E2E /v1 stage key",
      tokenHash: key.tokenHash,
      tokenPrefix: key.tokenPrefix,
      createdById: userId,
      scopes: ["*"],
    },
  });
  apiToken = key.token;

  // Non-default stages — the team already owns its sole isDefault row, and a
  // partial unique index (ContactStage_teamId_isDefault_key) forbids a second.
  const lead = await db().contactStage.create({
    data: { teamId, name: "E2E Lead", position: 90 },
  });
  const customer = await db().contactStage.create({
    data: { teamId, name: "E2E Customer", position: 91 },
  });
  leadStageId = lead.id;
  customerStageId = customer.id;

  const contact = await db().contact.create({
    data: {
      teamId,
      phoneNumber: "+15557778888",
      identityChannel: "whatsapp",
      name: "Stage API Test",
      source: "manual",
      stageId: leadStageId,
    },
  });
  contactId = contact.id;
  const conv = await db().conversation.create({
    data: { teamId, contactId: contact.id, channel: "whatsapp", status: "open" },
  });
  conversationId = conv.id;
});

test.afterAll(async () => {
  await wipeTestData();
  await db().$disconnect();
});

test.describe("POST /v1/contacts/:id/stage", () => {
  test("changes the stage AND fires the lifecycle pill (UI parity)", async ({
    request,
  }) => {
    const resp = await request.post(
      `/api/external/v1/contacts/${contactId}/stage`,
      {
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        data: { stageId: customerStageId },
      },
    );
    // NestJS @Post returns 201 by convention (no @HttpCode override), matching
    // the sibling assign/status endpoints in this controller.
    expect(resp.status(), await resp.text()).toBe(201);
    const body = await resp.json();
    expect(body.contact, "response carries the updated contact").toBeTruthy();

    // The DB is the source of truth — stage actually moved.
    const c = await db().contact.findUnique({
      where: { id: contactId },
      select: { stageId: true },
    });
    expect(c?.stageId).toBe(customerStageId);

    // Parity with the UI's stage picker: contact.lifecycle_changed fired, so the
    // audit subscriber wrote a `stage_changed` pill into the conversation.
    await expect
      .poll(
        async () => {
          const ev = await db().conversationEvent.findFirst({
            where: { conversationId, kind: "stage_changed" },
            select: { id: true },
          });
          return ev != null;
        },
        { timeout: 6_000 },
      )
      .toBe(true);
  });

  test("unknown stageId → 400 stage_not_found", async ({ request }) => {
    const resp = await request.post(
      `/api/external/v1/contacts/${contactId}/stage`,
      {
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        data: { stageId: "stage_does_not_exist" },
      },
    );
    expect(resp.status()).toBe(400);
    expect((await resp.json()).error).toBe("stage_not_found");
  });

  test("no auth → rejected", async ({ request }) => {
    const resp = await request.post(
      `/api/external/v1/contacts/${contactId}/stage`,
      {
        headers: { "Content-Type": "application/json" },
        data: { stageId: customerStageId },
      },
    );
    expect([401, 403]).toContain(resp.status());
  });
});
