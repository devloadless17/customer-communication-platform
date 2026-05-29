/**
 * Attachment liveness probe (2026-05-29):
 *
 * When a UploadThing file 404s, the user's "Open" click used to navigate
 * to the provider's branded 404 page. The fix adds:
 *
 *   - `GET /api/media/:messageId?probe=1` → returns `{ available: bool }`
 *     instead of redirecting. Falls back to `{ available: false, reason }`
 *     when the upstream HEAD fails.
 *   - `GET /api/media/probe?url=<rawUrl>` → generic probe for raw provider
 *     URLs (team-chat embeds raw ufs.sh URLs in its message payloads).
 *     Rejects any URL that isn't from the active blob provider.
 *
 * Client helper `openAttachment()` calls the probe first, opens a tab only
 * when available, otherwise surfaces an in-app toast.
 *
 * This spec hits the probe endpoints directly. We don't need to seed a real
 * media-bearing message — the host-allowlist + missing-row branches give us
 * deterministic answers without UploadThing in the loop.
 */
import { test, expect } from "@playwright/test";
import { db, superadminTeam, wipeTestData } from "../_helpers/db";

let teamId: string;

test.beforeAll(async () => {
  await wipeTestData();
  const su = await superadminTeam();
  teamId = su.teamId;
});

test.afterAll(async () => {
  await wipeTestData();
  await db().$disconnect();
});

test.describe("Attachment liveness probe endpoint", () => {
  test("GET /api/media/probe rejects non-provider URLs with available=false", async ({
    request,
  }) => {
    const resp = await request.get(
      "/api/media/probe?url=" + encodeURIComponent("https://attacker.example.com/file.pdf"),
    );
    expect(resp.status(), "probe always returns 200").toBe(200);
    const body = await resp.json();
    expect(body.available, "non-provider URL").toBe(false);
    expect(body.reason).toBe("missing");
  });

  test("GET /api/media/probe with empty url returns available=false", async ({ request }) => {
    const resp = await request.get("/api/media/probe");
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.available).toBe(false);
  });

  test("GET /api/media/probe with a UploadThing-shaped URL probes the upstream", async ({
    request,
  }) => {
    // A clearly-bogus key on the right host should be allowed past the
    // host gate and HEAD'd against the upstream — which 404s, surfacing
    // `available: false, reason: upstream_missing`.
    //
    // This relies on the test env's UPLOADTHING_TOKEN having appId
    // `fd5mlafelh`. If a future deploy rotates the token, the host gate
    // would short-circuit to `reason: missing` instead — both responses
    // are acceptable per the probe contract (the file is unreachable).
    const bogus = "https://fd5mlafelh.ufs.sh/f/this-key-definitely-does-not-exist";
    const resp = await request.get(
      "/api/media/probe?url=" + encodeURIComponent(bogus),
    );
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.available).toBe(false);
    expect(
      ["upstream_missing", "missing"].includes(body.reason),
      `unexpected reason: ${body.reason}`,
    ).toBe(true);
  });

  test("GET /api/media/:messageId?probe=1 returns available=false for missing rows", async ({
    request,
  }) => {
    // Bogus messageId (not in DB) — must surface available=false rather
    // than redirecting (302) or 404-ing. The client treats anything-not-200
    // as a probe failure → opens the tab → upstream 404 → bad UX. The probe
    // endpoint is specifically the don't-do-that response.
    const resp = await request.get(
      "/api/media/cmnonexistentmsgid?probe=1",
    );
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.available).toBe(false);
    expect(body.reason).toBe("missing");
  });

  test("GET /api/media/:messageId without probe still redirects (302) for real rows", async ({
    request,
  }) => {
    // Seed a contact + conversation + message with a fake mediaUrl pointing
    // at the UT app subdomain. The route should 302 to the URL (not 200).
    // We disable redirect-follow to inspect the Location header.
    const contact = await db().contact.create({
      data: {
        teamId,
        phoneNumber: "+15554440001",
        identityChannel: "whatsapp",
        name: "Probe redirect test",
        source: "manual",
      },
    });
    const conv = await db().conversation.create({
      data: {
        teamId,
        contactId: contact.id,
        channel: "whatsapp",
        status: "open",
      },
    });
    const fakeUrl = "https://fd5mlafelh.ufs.sh/f/some-fake-key";
    const msg = await db().message.create({
      data: {
        // Prisma 7 requires explicit relation connects for required FKs —
        // `teamId: …` alone no longer satisfies the model.
        team: { connect: { id: teamId } },
        conversation: { connect: { id: conv.id } },
        externalId: `e2e-fake-${Date.now()}`,
        direction: "out",
        channel: "whatsapp",
        // body is required (not nullable). Empty string is fine for a
        // media-only message — the caption (if any) would live here.
        body: "",
        status: "sent",
        rawPayload: {} as never,
        mediaKind: "document",
        mediaMimeType: "application/pdf",
        mediaUrl: fakeUrl,
        mediaSizeBytes: 1024,
      },
    });

    const resp = await request.get(`/api/media/${msg.id}`, {
      maxRedirects: 0,
    });
    expect(resp.status(), "should 302 redirect to the upstream URL").toBe(302);
    expect(resp.headers()["location"]).toBe(fakeUrl);
  });
});
