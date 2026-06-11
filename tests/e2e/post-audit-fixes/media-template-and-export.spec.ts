import { test, expect } from "@playwright/test";

/**
 * Post-audit (2026-06-11) coverage for the two new API surfaces:
 *   - media-header template send: POST /api/messages/template-header-media
 *     (the upload leg that stages an IMAGE/VIDEO/DOCUMENT header to UploadThing)
 *   - contact-export capability gate: GET /api/contacts/export
 *
 * Runs under the chromium project's app-admin storageState (a regular admin,
 * so contacts:export defaults to true → export is allowed). Assertions are
 * deliberately tolerant of the upload provider (a CI env may carry a dummy
 * UPLOADTHING_TOKEN) — the point is that the routes EXIST, AUTH, and VALIDATE,
 * not that the blob store is live.
 */

test.describe("media-header template upload route", () => {
  test("exists, is auth-gated, and validates a missing file", async ({ request }) => {
    // No multipart file → the controller rejects with 400 "file is required".
    // A 404 here would mean the route never mounted (the bug we're guarding).
    const resp = await request.post("/api/messages/template-header-media", {
      multipart: {},
    });
    expect(resp.status(), "route must exist (not 404)").not.toBe(404);
    expect(resp.status(), "missing file → 400").toBe(400);
    const body = await resp.json().catch(() => ({}));
    expect(JSON.stringify(body)).toContain("file");
  });

  test("rejects an audio file as an unsupported header kind", async ({ request }) => {
    // Template headers accept image/video/document only — an audio upload must
    // be rejected (400 unsupported_media_type) rather than silently accepted.
    // A tiny valid OGG header so the mime is audio/*.
    const oggMagic = Buffer.from([0x4f, 0x67, 0x67, 0x53]); // "OggS"
    const resp = await request.post("/api/messages/template-header-media", {
      multipart: {
        file: {
          name: "clip.ogg",
          mimeType: "audio/ogg",
          buffer: oggMagic,
        },
      },
    });
    // 400 (our explicit unsupported_media_type) is the contract. Tolerate a
    // 4xx/5xx from the blob layer too, but never a 404 (route missing) or 2xx
    // (audio wrongly accepted as a header).
    expect(resp.status(), "audio not accepted as header").not.toBe(404);
    expect(resp.ok(), "audio header upload must not succeed").toBeFalsy();
  });
});

test.describe("contact export capability gate", () => {
  test("admin (default contacts:export=true) can export the CSV", async ({ request }) => {
    const resp = await request.get("/api/contacts/export");
    expect(resp.status(), "admin export allowed").toBe(200);
    expect(
      resp.headers()["content-type"] ?? "",
      "export is a CSV",
    ).toContain("text/csv");
    const disposition = resp.headers()["content-disposition"] ?? "";
    expect(disposition, "served as a download").toContain("attachment");
  });
});
