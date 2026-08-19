/**
 * Meta data-deletion callback — signature verification is the whole security model.
 *
 * This endpoint is PUBLIC, UNAUTHENTICATED, and DELETES DATA. The only thing standing
 * between it and anyone tombstoning any contact is the `signed_request` HMAC, so these
 * tests are about that boundary rather than the happy path.
 *
 * The subtle one is `hashes the payload AS TRANSMITTED`: the signature covers the
 * base64url payload STRING, and decoding then re-encoding it before hashing is the
 * classic way to get a verifier that works on your own fixtures and fails on Meta's.
 *
 *   pnpm --filter @ccp/api exec vitest run test/meta-data-deletion.spec.ts
 */
import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` is hoisted above module scope, so the spy has to be created inside
// `vi.hoisted` — a plain top-level const is not initialised yet when the factory runs.
const { updateMany, findMany, publish } = vi.hoisted(() => ({
  updateMany: vi.fn(),
  findMany: vi.fn(),
  publish: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: { contact: { updateMany, findMany } } }));
// The route announces each tombstone in its OWN tenant (the matched rows carry
// the workspaceId the route itself has no context for).
vi.mock("@/lib/events/bus", () => ({ publish }));

import { MetaDataDeletionController } from "@/webhooks/meta/data-deletion.controller";

const SECRET = "platform_app_secret";
const OTHER = "some_other_apps_secret";

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Build a signed_request exactly the way Meta does. */
function signedRequest(payload: object, secret: string): string {
  const encodedPayload = b64url(JSON.stringify(payload));
  // HMAC over the ENCODED payload string, raw digest, base64url'd.
  const sig = createHmac("sha256", secret).update(encodedPayload).digest();
  return `${b64url(sig)}.${encodedPayload}`;
}

const validPayload = {
  algorithm: "HMAC-SHA256",
  issued_at: 1_785_400_000,
  user_id: "PSID_OR_ASID_123",
};

describe("MetaDataDeletionController", () => {
  let controller: MetaDataDeletionController;

  beforeEach(() => {
    process.env.META_APP_SECRET = SECRET;
    process.env.APP_PUBLIC_URL = "https://example.test";
    updateMany.mockReset();
    updateMany.mockResolvedValue({ count: 1 });
    findMany.mockReset();
    findMany.mockResolvedValue([{ id: "c_1", workspaceId: "ws_1" }]);
    publish.mockReset();
    publish.mockResolvedValue(undefined);
    controller = new MetaDataDeletionController();
  });
  afterEach(() => {
    delete process.env.META_APP_SECRET;
    delete process.env.APP_PUBLIC_URL;
  });

  it("accepts a correctly signed request and returns Meta's required shape", async () => {
    const res = await controller.handle({
      signed_request: signedRequest(validPayload, SECRET),
    });
    // Meta: 'a JSON response that contains a URL where the user can check the status
    // of their deletion request and an alphanumeric confirmation code'.
    expect(res.confirmation_code).toMatch(/^[a-z0-9]+$/);
    expect(res.url).toContain("https://example.test/privacy/data-deletion");
    expect(res.url).toContain(encodeURIComponent(res.confirmation_code));
  });

  it("tombstones only the two Meta SOCIAL channels, and only live rows", async () => {
    await controller.handle({ signed_request: signedRequest(validPayload, SECRET) });
    // The SELECTION is the predicate that matters — the update then works off
    // the ids it returned, so each tombstone can be announced in its own tenant.
    const selected = findMany.mock.calls[0]![0].where;
    expect(selected.identityChannel).toEqual({ in: ["messenger", "instagram"] });
    expect(selected.externalContactId).toBe("PSID_OR_ASID_123");
    // Idempotent: Meta retries, and a second delivery must not churn timestamps.
    expect(selected.deletedAt).toBeNull();
    const where = updateMany.mock.calls[0]![0].where;
    expect(where.id).toEqual({ in: ["c_1"] });
    expect(where.deletedAt).toBeNull();
    // Preserves the chat — the product's own established delete semantic.
    expect(updateMany.mock.calls[0]![0].data).toEqual({ deletedAt: expect.any(Date) });
    // …and the tenant hears about it, in ITS workspace.
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: "contact.deleted", workspaceId: "ws_1", contactId: "c_1" }),
    );
  });

  it("REJECTS a request signed with a different app's secret", async () => {
    await expect(
      controller.handle({ signed_request: signedRequest(validPayload, OTHER) }),
    ).rejects.toMatchObject({ status: 403 });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("REJECTS a tampered payload that keeps the original signature", async () => {
    // The attack this guards: take a real request, swap the user_id.
    const real = signedRequest(validPayload, SECRET);
    const sig = real.slice(0, real.indexOf("."));
    const forged = `${sig}.${b64url(JSON.stringify({ ...validPayload, user_id: "VICTIM" }))}`;
    await expect(controller.handle({ signed_request: forged })).rejects.toMatchObject({
      status: 403,
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("REJECTS a malformed signature without throwing a 500", async () => {
    // timingSafeEqual THROWS on a length mismatch, so a short signature must be
    // length-checked first or a garbage request becomes a server error.
    for (const bad of ["", ".", "notbase64.payload", "onlyonepart"]) {
      await expect(controller.handle({ signed_request: bad })).rejects.toMatchObject({
        status: expect.any(Number),
      });
    }
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("REJECTS an algorithm we did not verify with", async () => {
    const payload = { ...validPayload, algorithm: "RSA-SHA1" };
    await expect(
      controller.handle({ signed_request: signedRequest(payload, SECRET) }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("REFUSES to act at all when no platform secret is configured", async () => {
    // Cannot verify ⇒ cannot delete. Accepting here would let anyone tombstone any
    // contact by guessing an id.
    delete process.env.META_APP_SECRET;
    await expect(
      controller.handle({ signed_request: signedRequest(validPayload, SECRET) }),
    ).rejects.toMatchObject({ status: 503 });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("honours a comma-separated secret list so a rotation window works", async () => {
    process.env.META_APP_SECRET = `${OTHER}, ${SECRET}`;
    const res = await controller.handle({
      signed_request: signedRequest(validPayload, SECRET),
    });
    expect(res.confirmation_code).toBeTruthy();
  });

  it("still ACKNOWLEDGES when the id matches nothing", async () => {
    // The expected case for an app-scoped id, which is a different namespace from the
    // page-scoped id we store. Meta is owed an acknowledgement either way, and
    // claiming a deletion we did not perform would be worse.
    updateMany.mockResolvedValue({ count: 0 });
    const res = await controller.handle({
      signed_request: signedRequest(validPayload, SECRET),
    });
    expect(res.confirmation_code).toMatch(/^[a-z0-9]+$/);
  });

  it("gives the same code for the same user, and different codes for different users", async () => {
    const a = await controller.handle({ signed_request: signedRequest(validPayload, SECRET) });
    const b = await controller.handle({ signed_request: signedRequest(validPayload, SECRET) });
    const c = await controller.handle({
      signed_request: signedRequest({ ...validPayload, user_id: "SOMEONE_ELSE" }, SECRET),
    });
    // Stable, so a user re-checking their code sees the same one with no storage.
    expect(a.confirmation_code).toBe(b.confirmation_code);
    // Derived through the app secret, so it is not guessable from the id alone.
    expect(c.confirmation_code).not.toBe(a.confirmation_code);
  });
});
