/**
 * /v1 parity build, phase 1 — outbound-webhook management, audience groups
 * and snippets.
 *
 * These three domains were UI-only, and the webhook one was the biggest
 * self-serve onboarding blocker in the whole API: an integration could not
 * receive a single event until a human clicked through Settings. There is no
 * point exposing them if the scope gates are wrong, so this spec pins the
 * two things that actually matter for an external surface:
 *
 *   1. The HAPPY PATH works end to end (create → read back → update → delete),
 *      through the SAME services the settings UI calls.
 *   2. The SCOPE GATE bites. A webhook is a standing data-egress grant, so a
 *      key without `admin:settings` must be refused — including on the READS,
 *      which is the part that is easy to get wrong and impossible to notice.
 *
 * The signing secret is asserted to come back exactly once (on create and on
 * rotate) and never from a list — same contract as an API key.
 */
import { test, expect } from "@playwright/test";

import { generateApiKey } from "../../../apps/api/src/auth/api-key";
import { db, appAdmin, wipeTestData } from "../_helpers/db";

const API = process.env.E2E_API_URL ?? "http://localhost:4000";

let workspaceId: string;
let userId: string;
let adminToken: string;
let weakToken: string;

async function mintKey(name: string, scopes: string[]): Promise<string> {
  const key = generateApiKey();
  await db().workspaceApiKey.create({
    data: {
      workspaceId,
      name,
      tokenHash: key.tokenHash,
      tokenPrefix: key.tokenPrefix,
      // WorkspaceApiKey.createdById is required (unlike OutboundWebhook's,
      // which this build made nullable) — keys are minted by a person.
      createdById: userId,
      scopes,
    },
  });
  return key.token;
}

test.beforeAll(async () => {
  await wipeTestData();
  const su = await appAdmin();
  workspaceId = su.workspaceId;
  userId = su.userId;

  adminToken = await mintKey("E2E parity admin key", ["*"]);
  // Deliberately broad EXCEPT admin:settings — proves the gate is the scope,
  // not merely "has some key".
  weakToken = await mintKey("E2E parity weak key", [
    "read:catalog",
    "write:catalog",
    "read:contacts",
    "read:broadcasts",
  ]);
});

test.afterAll(async () => {
  await db().outboundWebhook.deleteMany({ where: { workspaceId } });
  await db().audienceGroup.deleteMany({ where: { workspaceId } });
  await db().snippet.deleteMany({ where: { workspaceId } });
});

test.describe("/v1 outbound-webhook management", () => {
  test("register → read back → rotate → delete, with the secret shown exactly once", async ({
    request,
  }) => {
    const created = await request.post(`${API}/api/external/v1/outbound-webhooks`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: {
        name: "E2E receiver",
        url: "https://example.com/hooks/e2e",
        eventTypes: ["message.received"],
      },
    });
    expect(created.status()).toBe(201);
    const createdBody = await created.json();
    const webhookId: string = createdBody.webhook?.id ?? createdBody.id;
    expect(webhookId).toBeTruthy();
    // The secret is returned ONCE. Store-it-now is the documented contract.
    const secret: string | undefined = createdBody.secret ?? createdBody.webhook?.secret;
    expect(secret, "create must return the signing secret once").toBeTruthy();

    // An API key is not a person — the creator column is null, which is the
    // whole reason it was made nullable for this build.
    const row = await db().outboundWebhook.findUnique({ where: { id: webhookId } });
    expect(row?.createdById).toBeNull();

    const list = await request.get(`${API}/api/external/v1/outbound-webhooks`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(list.ok()).toBeTruthy();
    const listed = (await list.json()).webhooks as { id: string; secret?: string }[];
    expect(listed.some((w) => w.id === webhookId)).toBe(true);
    // …and NEVER again from a list read.
    expect(listed.every((w) => !w.secret)).toBe(true);

    const rotated = await request.post(
      `${API}/api/external/v1/outbound-webhooks/${webhookId}/rotate-secret`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(rotated.ok()).toBeTruthy();
    const newSecret = (await rotated.json()).secret as string;
    expect(newSecret).toBeTruthy();
    expect(newSecret).not.toBe(secret);

    const deliveries = await request.get(
      `${API}/api/external/v1/outbound-webhooks/${webhookId}/deliveries`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(deliveries.ok()).toBeTruthy();

    const removed = await request.delete(
      `${API}/api/external/v1/outbound-webhooks/${webhookId}`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(removed.ok()).toBeTruthy();
    expect(await db().outboundWebhook.findUnique({ where: { id: webhookId } })).toBeNull();
  });

  test("a key without admin:settings is refused — on the READS too", async ({ request }) => {
    // The read gate is the one that matters: a webhook list exposes every
    // endpoint the workspace ships data to.
    const read = await request.get(`${API}/api/external/v1/outbound-webhooks`, {
      headers: { Authorization: `Bearer ${weakToken}` },
    });
    expect(read.status()).toBe(403);
    expect((await read.json()).error).toBe("insufficient_scope");

    const write = await request.post(`${API}/api/external/v1/outbound-webhooks`, {
      headers: { Authorization: `Bearer ${weakToken}` },
      data: {
        name: "E2E nope",
        url: "https://example.com/nope",
        eventTypes: ["message.received"],
      },
    });
    expect(write.status()).toBe(403);
  });
});

test.describe("/v1 audience groups + snippets", () => {
  test("audience group create → read → update → delete", async ({ request }) => {
    const created = await request.post(`${API}/api/external/v1/audience-groups`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { name: "E2E lapsed customers" },
    });
    expect(created.status()).toBe(201);
    const id: string = (await created.json()).group.id;

    const got = await request.get(`${API}/api/external/v1/audience-groups/${id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(got.ok()).toBeTruthy();
    expect((await got.json()).group.name).toBe("E2E lapsed customers");

    const patched = await request.patch(`${API}/api/external/v1/audience-groups/${id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { name: "E2E lapsed — Q3" },
    });
    expect(patched.ok()).toBeTruthy();
    expect((await patched.json()).group.name).toBe("E2E lapsed — Q3");

    const removed = await request.delete(`${API}/api/external/v1/audience-groups/${id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(removed.ok()).toBeTruthy();
  });

  test("snippet create → list → update → delete", async ({ request }) => {
    const created = await request.post(`${API}/api/external/v1/snippets`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: {
        name: "e2e_shipping",
        label: "E2E shipping",
        body: "Orders ship within 2 business days.",
      },
    });
    expect(created.status()).toBe(201);
    const id: string = (await created.json()).id;

    const list = await request.get(`${API}/api/external/v1/snippets`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(list.ok()).toBeTruthy();
    expect(((await list.json()).snippets as { id: string }[]).some((x) => x.id === id)).toBe(
      true,
    );

    const patched = await request.patch(`${API}/api/external/v1/snippets/${id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { body: "Orders ship next business day." },
    });
    expect(patched.ok()).toBeTruthy();

    const removed = await request.delete(`${API}/api/external/v1/snippets/${id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(removed.ok()).toBeTruthy();
  });

  test("catalog writes still need write:catalog, not just any key", async ({ request }) => {
    const readOnly = await mintKey("E2E read-only key", ["read:catalog"]);
    const res = await request.post(`${API}/api/external/v1/snippets`, {
      headers: { Authorization: `Bearer ${readOnly}` },
      data: { name: "e2e_nope", label: "nope", body: "nope" },
    });
    expect(res.status()).toBe(403);
  });
});
