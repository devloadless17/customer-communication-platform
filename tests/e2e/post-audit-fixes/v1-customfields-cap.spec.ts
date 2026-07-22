/**
 * customFields total-key cap (2026-06-19 deferred-backlog fix). mergeCustomFields
 * caps the ACCUMULATED bag at MAX_TOTAL_FIELDS (100) across many PATCHes — the
 * per-request Zod cap (50) bounded one request but the merged result was
 * unbounded, so repeated PATCHes of fresh one-off keys grew Contact.customFields
 * without limit. The cap counts the POST-merge size, so removal/edit-only
 * PATCHes on an already-large bag still succeed.
 *
 * Exercised against /v1 (API-key authed, plain HTTP — no Meta wire).
 */
import { test, expect } from "@playwright/test";

import { generateApiKey } from "../../../apps/api/src/auth/api-key";
import { db, superadminTeam, wipeTestData } from "../_helpers/db";

let workspaceId: string;
let apiToken: string;
let contactId: string;

function fields(prefix: string, n: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < n; i++) out[`${prefix}_${i}`] = "x";
  return out;
}

async function patchFields(
  request: import("@playwright/test").APIRequestContext,
  customFields: Record<string, string | null>,
) {
  return request.patch(`/api/external/v1/contacts/${contactId}`, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    data: { customFields },
  });
}

test.beforeAll(async () => {
  await wipeTestData();
  const su = await superadminTeam();
  workspaceId = su.workspaceId;

  const key = generateApiKey();
  await db().workspaceApiKey.create({
    data: {
      workspaceId,
      name: "E2E /v1 customfields-cap key",
      tokenHash: key.tokenHash,
      tokenPrefix: key.tokenPrefix,
      createdById: su.userId,
      scopes: ["*"],
    },
  });
  apiToken = key.token;

  const contact = await db().contact.create({
    data: {
      workspaceId,
      phoneNumber: "+15553334444",
      identityChannel: "whatsapp",
      name: "CF Cap Test",
      source: "manual",
    },
  });
  contactId = contact.id;
});

test.afterAll(async () => {
  await wipeTestData();
  await db().$disconnect();
});

test.describe("PATCH /v1/contacts/:id customFields total cap", () => {
  test("accumulated keys past MAX_TOTAL_FIELDS (100) are rejected; removal still works", async ({
    request,
  }) => {
    // 40 + 40 = 80 keys: both succeed (each request ≤ 50/request cap, total < 100).
    expect((await patchFields(request, fields("a", 40))).status()).toBe(200);
    expect((await patchFields(request, fields("b", 40))).status()).toBe(200);

    // +40 → 120 total > 100 → 400 too_many_custom_fields.
    const over = await patchFields(request, fields("c", 40));
    expect(over.status(), await over.text()).toBe(400);
    expect((await over.json()).error).toBe("too_many_custom_fields");

    // DB confirms the over-limit PATCH did NOT partially write (tx rolled back).
    const c1 = await db().contact.findUnique({
      where: { id: contactId },
      select: { customFields: true },
    });
    expect(Object.keys(c1?.customFields as object).length).toBe(80);

    // A removal-only PATCH on the (still-large) bag succeeds — the cap counts
    // the post-merge size, so shrinking is always allowed.
    const removals: Record<string, null> = {};
    for (let i = 0; i < 40; i++) removals[`a_${i}`] = null;
    expect((await patchFields(request, removals)).status()).toBe(200);
    const c2 = await db().contact.findUnique({
      where: { id: contactId },
      select: { customFields: true },
    });
    expect(Object.keys(c2?.customFields as object).length).toBe(40);
  });

  test("a normal small PATCH is unaffected", async ({ request }) => {
    const resp = await patchFields(request, { company: "Acme" });
    expect(resp.status()).toBe(200);
  });

  test("an already-over-cap bag stays editable + shrinkable (net-growth-only cap)", async ({
    request,
  }) => {
    // Seed a contact ALREADY over the cap — reachable via pre-cap data or the
    // admin-configured workflow update-field step (HTTP create is Zod-capped
    // at 50, so this only happens off the HTTP path).
    const big: Record<string, string> = {};
    for (let i = 0; i < 110; i++) big[`big_${i}`] = "v";
    const over = await db().contact.create({
      data: {
        workspaceId,
        phoneNumber: "+15556667777",
        identityChannel: "whatsapp",
        name: "Over Cap",
        source: "manual",
        customFields: big,
      },
    });
    const url = `/api/external/v1/contacts/${over.id}`;
    const headers = {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    };

    // Edit-only (re-set an existing key) — allowed despite 110 > 100 (no growth).
    const edit = await request.patch(url, {
      headers,
      data: { customFields: { big_0: "updated" } },
    });
    expect(edit.status(), await edit.text()).toBe(200);

    // A net-new key (would grow 110 → 111) — still rejected.
    const grow = await request.patch(url, {
      headers,
      data: { customFields: { brand_new: "x" } },
    });
    expect(grow.status()).toBe(400);
    expect((await grow.json()).error).toBe("too_many_custom_fields");

    // Removal — allowed (shrinks the bag).
    const shrink = await request.patch(url, {
      headers,
      data: { customFields: { big_1: null } },
    });
    expect(shrink.status()).toBe(200);
  });
});
