import { test, expect } from "@playwright/test";

import { appAdmin, db } from "../_helpers/db";

/**
 * Per-org member cap (2026-06-11): every org defaults to 2 active members;
 * only a superAdmin can change it (platform org-detail page →
 * PATCH /api/admin/workspaces/:id/max-members). Enforced at invite-create (soft)
 * and invite-accept (authoritative, row-locked). superAdmins don't count as
 * org seats. Covers the endpoint, authz, and the real enforcement.
 */

const SUPER = "tests/e2e/.auth/superadmin.json";
const APP = "tests/e2e/.auth/app-admin.json";
const TEST_EMAIL = "e2e-cap-test@loadless.test";

test.describe("org member limit", () => {
  test("superAdmin sets, validates, and reads back an org's member cap", async ({
    playwright,
    baseURL,
  }) => {
    const { workspaceId } = await appAdmin();
    const su = await playwright.request.newContext({ baseURL, storageState: SUPER });
    try {
      const set5 = await su.patch(`/api/admin/workspaces/${workspaceId}/max-members`, {
        data: { maxMembers: 5 },
      });
      expect(set5.status()).toBe(200);
      const body = await set5.json();
      expect(body.maxMembers).toBe(5);
      expect(typeof body.activeMembers).toBe("number");
      expect(body.activeMembers).toBeGreaterThanOrEqual(1);

      // Validation: out-of-range values rejected.
      expect(
        (await su.patch(`/api/admin/workspaces/${workspaceId}/max-members`, { data: { maxMembers: 0 } })).status(),
      ).toBe(400);
      expect(
        (await su.patch(`/api/admin/workspaces/${workspaceId}/max-members`, { data: { maxMembers: 5000 } })).status(),
      ).toBe(400);
      // Unknown team → 404.
      expect(
        (await su.patch(`/api/admin/workspaces/does-not-exist/max-members`, { data: { maxMembers: 3 } })).status(),
      ).toBe(404);
    } finally {
      await su
        .patch(`/api/admin/workspaces/${workspaceId}/max-members`, { data: { maxMembers: 2 } })
        .catch(() => undefined);
      await su.dispose();
    }
  });

  test("a non-superAdmin cannot change a member cap", async ({ request }) => {
    // Default project storageState is the app-admin (role: admin, not superAdmin).
    const res = await request.patch("/api/admin/workspaces/any-id/max-members", {
      data: { maxMembers: 9 },
    });
    expect([401, 403]).toContain(res.status());
  });

  test("cap blocks an invite at the limit; raising it lets the invite through", async ({
    playwright,
    baseURL,
  }) => {
    const { workspaceId } = await appAdmin();
    const su = await playwright.request.newContext({ baseURL, storageState: SUPER });
    const admin = await playwright.request.newContext({ baseURL, storageState: APP });
    try {
      // Cap the org at 1. The seeded org has ≥1 member, so it's now at/over the
      // limit and a new invite must be refused.
      expect(
        (await su.patch(`/api/admin/workspaces/${workspaceId}/max-members`, { data: { maxMembers: 1 } })).status(),
      ).toBe(200);
      const blocked = await admin.post("/api/invites", {
        data: { email: TEST_EMAIL, role: "agent" },
      });
      expect(blocked.status()).toBe(409);
      expect((await blocked.json()).error).toBe("member_limit_reached");

      // Raise the cap → the same invite now succeeds.
      expect(
        (await su.patch(`/api/admin/workspaces/${workspaceId}/max-members`, { data: { maxMembers: 5 } })).status(),
      ).toBe(200);
      const allowed = await admin.post("/api/invites", {
        data: { email: TEST_EMAIL, role: "agent" },
      });
      expect(allowed.status(), "invite allowed under a raised cap").toBeLessThan(300);
    } finally {
      // Clean up the test invite + restore the default cap so other specs are
      // unaffected.
      await db()
        .invite.deleteMany({ where: { email: TEST_EMAIL } })
        .catch(() => undefined);
      await su
        .patch(`/api/admin/workspaces/${workspaceId}/max-members`, { data: { maxMembers: 2 } })
        .catch(() => undefined);
      await su.dispose();
      await admin.dispose();
    }
  });
});
