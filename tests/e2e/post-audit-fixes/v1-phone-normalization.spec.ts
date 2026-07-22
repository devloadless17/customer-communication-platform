/**
 * Phone trunk-0 normalization (2026-06-19 go-live audit fix). normalizePhoneE164
 * now runs the number through libphonenumber-js, so a number typed/pasted in
 * national format (with the trunk-prefix 0) is stored as a deliverable E.164
 * wa_id instead of an undeliverable one — and converges with the trunk-0-less
 * wa_id Meta delivers inbound (preserving the dedupe invariant). The trunk 0 is
 * KEPT where it's significant (Italy +39). Exercised via the /v1 create path,
 * which normalizes server-side.
 */
import { test, expect } from "@playwright/test";

import { generateApiKey } from "../../../apps/api/src/auth/api-key";
import { db, superadminTeam, wipeTestData } from "../_helpers/db";

let apiToken: string;

async function createContact(
  request: import("@playwright/test").APIRequestContext,
  phoneNumber: string,
) {
  return request.post("/api/external/v1/contacts", {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    data: { phoneNumber },
  });
}

test.beforeAll(async () => {
  await wipeTestData();
  const su = await superadminTeam();
  const key = generateApiKey();
  await db().workspaceApiKey.create({
    data: {
      workspaceId: su.workspaceId,
      name: "E2E /v1 phone-norm key",
      tokenHash: key.tokenHash,
      tokenPrefix: key.tokenPrefix,
      createdById: su.userId,
      scopes: ["*"],
    },
  });
  apiToken = key.token;
});

test.afterAll(async () => {
  await wipeTestData();
  await db().$disconnect();
});

test.describe("phone normalization via /v1 create", () => {
  test("a national trunk-0 number is stored as the deliverable E.164 (0 stripped)", async ({
    request,
  }) => {
    const resp = await createContact(request, "+4407911123456"); // UK, leading 0
    expect(resp.status(), await resp.text()).toBe(201);
    expect((await resp.json()).contact.phoneNumber).toBe("447911123456");
  });

  test("the trunk-0 and clean forms converge → second create is a duplicate", async ({
    request,
  }) => {
    // Same logical number without the trunk 0 — must normalize to the SAME
    // stored wa_id and therefore collide with the contact created above.
    const resp = await createContact(request, "+447911123456");
    expect(resp.status()).toBe(409);
    expect((await resp.json()).error).toBe("duplicate_phone");
  });

  test("a trunk-0 that is SIGNIFICANT (Italy +39) is kept", async ({
    request,
  }) => {
    const resp = await createContact(request, "+390612345678"); // Rome landline
    expect(resp.status(), await resp.text()).toBe(201);
    expect((await resp.json()).contact.phoneNumber).toBe("390612345678");
  });
});
