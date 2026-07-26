/**
 * R2 media end-to-end (2026-07-01 migration). Verifies the same-origin
 * STREAMING PROXY that replaced UploadThing's presigned redirects:
 *
 *   upload → object lands in R2 → GET streams it back (200 + right type)
 *   → Range request returns 206 (video/audio seeking) → ?probe=1 existence
 *   → inbox inline-by-default vs ?download=1 forces attachment.
 *
 * Covers EVERY file kind (image / video / audio / document) via the team-chat
 * media endpoint, which uploads to R2 without needing Meta. Creates only its
 * own rows (no wipeTestData) so a live manual test session is undisturbed.
 */
import { test, expect } from "@playwright/test";

import { db, appAdmin } from "../_helpers/db";

// --- tiny valid fixtures (pass the magic-byte sniff in mime-guard.ts) --------
// 1×1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
// Minimal ISO-BMFF `ftyp` box → sniffs as video/mp4.
const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from("ftyp"),
  Buffer.from("mp42"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from("mp42isom"),
]);
// MP3 frame header (0xFF 0xFB…) — not in the sniff table, so the claimed
// audio/mpeg stands (exactly how real mp3s without ID3 pass).
const MP3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(64, 0x11)]);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n", "utf8");

const FIXTURES = [
  { kind: "image", mime: "image/png", name: "pic.png", buf: PNG },
  { kind: "video", mime: "video/mp4", name: "clip.mp4", buf: MP4 },
  { kind: "audio", mime: "audio/mpeg", name: "voice.mp3", buf: MP3 },
  { kind: "document", mime: "application/pdf", name: "report.pdf", buf: PDF },
] as const;

let workspaceId: string;
let channelId: string;

test.beforeAll(async ({ request }) => {
  workspaceId = (await appAdmin()).workspaceId;
  const r = await request.get("/api/team-chat/channels/default");
  expect(r.ok(), `default channel lookup failed: ${r.status()}`).toBeTruthy();
  channelId = (await r.json()).channel.id;
});

test.afterAll(async () => {
  // Remove the media messages this file uploaded into #general. Without this
  // they accumulate across runs, and once the R2 blob is gone every later
  // /team render fires media 404s — which failed predeploy's "no console
  // errors" gate with errors that look nothing like an R2 problem.
  await db().teamChannelMessage.deleteMany({
    where: { workspaceId, clientTempId: { startsWith: "e2e-r2-" } },
  });
  await db().message.deleteMany({
    where: { workspaceId, externalId: { startsWith: "e2e-r2-" } },
  });
  await db().$disconnect();
});

test.describe("R2 media serving — streaming proxy, all kinds", () => {
  for (const f of FIXTURES) {
    test(`${f.kind}: upload → stream (200 + type) → range (206) → probe`, async ({
      request,
    }) => {
      const up = await request.post(`/api/team-chat/channels/${channelId}/media`, {
        multipart: {
          file: { name: f.name, mimeType: f.mime, buffer: f.buf },
          clientTempId: `e2e-r2-${f.kind}-${Date.now()}`,
        },
      });
      expect(up.status(), `upload failed: ${await up.text()}`).toBeLessThan(300);
      const { messageId } = await up.json();
      const url = `/api/team-chat/channels/${channelId}/messages/${messageId}/media`;

      // Full stream — 200, correct Content-Type, Range-capable.
      const g = await request.get(url);
      expect(g.status()).toBe(200);
      expect(g.headers()["content-type"]).toContain(f.mime);
      expect(g.headers()["accept-ranges"]).toBe("bytes");

      // Range → 206 partial (what <video>/<audio> seeking relies on).
      const rg = await request.get(url, { headers: { Range: "bytes=0-3" } });
      expect(rg.status()).toBe(206);
      expect(rg.headers()["content-range"]).toMatch(/^bytes 0-3\//);

      // Probe → available.
      const pb = await request.get(`${url}?probe=1`);
      expect(pb.status()).toBe(200);
      expect((await pb.json()).available).toBe(true);
    });
  }

  test("avatar: upload → serve inline PNG via /api/users/:id/avatar", async ({
    request,
  }) => {
    const up = await request.post("/api/users/me/avatar", {
      multipart: { file: { name: "me.png", mimeType: "image/png", buffer: PNG } },
    });
    expect(up.status(), `avatar upload failed: ${await up.text()}`).toBeLessThan(300);
    const { url } = await up.json(); // /api/users/:id/avatar?v=…
    expect(url).toMatch(/^\/api\/users\/[^/]+\/avatar\?v=\d+$/);

    const g = await request.get(url);
    expect(g.status()).toBe(200);
    expect(g.headers()["content-type"]).toContain("image/png");
    expect(g.headers()["accept-ranges"]).toBe("bytes");
  });

  test("missing message → probe available:false, GET 404", async ({ request }) => {
    const id = "cmzzzzzzzz0000000000000000";
    const pb = await request.get(`/api/media/${id}?probe=1`);
    expect((await pb.json()).available).toBe(false);
    const g = await request.get(`/api/media/${id}`);
    expect(g.status()).toBe(404);
  });

  test("inbox /api/media: inline by default, ?download=1 forces attachment", async ({
    request,
  }) => {
    // Upload once to get a real R2 object + key, then seed an inbox Message that
    // reuses it — exercises the /api/media/:id path (the WhatsApp inbox surface).
    const up = await request.post(`/api/team-chat/channels/${channelId}/media`, {
      multipart: {
        file: { name: "seed.pdf", mimeType: "application/pdf", buffer: PDF },
        clientTempId: `e2e-r2-seed-${Date.now()}`,
      },
    });
    const { messageId: tcmId } = await up.json();
    const tcm = await db().teamChannelMessage.findUnique({
      where: { id: tcmId },
      select: { mediaKey: true, mediaUrl: true },
    });
    expect(tcm?.mediaKey).toBeTruthy();

    const contact = await db().contact.create({
      data: {
        workspaceId,
        phoneNumber: `+1555${String(Date.now()).slice(-7)}`,
        identityChannel: "whatsapp",
        name: "R2 e2e",
        source: "manual",
      },
    });
    const conv = await db().conversation.create({
      data: { workspaceId, contactId: contact.id, channel: "whatsapp", status: "open" },
    });
    const msg = await db().message.create({
      data: {
        workspace: { connect: { id: workspaceId } },
        conversation: { connect: { id: conv.id } },
        externalId: `e2e-r2-${Date.now()}`,
        direction: "out",
        channel: "whatsapp",
        body: "",
        status: "sent",
        rawPayload: {} as never,
        mediaKind: "document",
        mediaMimeType: "application/pdf",
        mediaKey: tcm!.mediaKey,
        mediaUrl: tcm!.mediaUrl,
        mediaFilename: "report.pdf",
        mediaSizeBytes: PDF.length,
      },
    });

    try {
      // Default → inline (PDF opens in the browser viewer, not a download).
      const inline = await request.get(`/api/media/${msg.id}`);
      expect(inline.status()).toBe(200);
      expect(inline.headers()["content-type"]).toContain("application/pdf");
      expect(inline.headers()["content-disposition"] ?? "").not.toContain("attachment");

      // ?download=1 → attachment with the original filename.
      const dl = await request.get(`/api/media/${msg.id}?download=1`);
      expect(dl.status()).toBe(200);
      expect(dl.headers()["content-disposition"]).toContain('attachment; filename="report.pdf"');

      // Friendly fallback: a row with NO filename downloads as `<kind>.<ext>`
      // (image.png here), never the opaque message id.
      const noName = await db().message.create({
        data: {
          workspace: { connect: { id: workspaceId } },
          conversation: { connect: { id: conv.id } },
          externalId: `e2e-r2-noname-${Date.now()}`,
          direction: "out",
          channel: "whatsapp",
          body: "",
          status: "sent",
          rawPayload: {} as never,
          mediaKind: "image",
          mediaMimeType: "image/png",
          mediaKey: tcm!.mediaKey,
          mediaUrl: tcm!.mediaUrl,
          mediaSizeBytes: PDF.length,
        },
      });
      try {
        const dl2 = await request.get(`/api/media/${noName.id}?download=1`);
        expect(dl2.headers()["content-disposition"]).toContain('filename="image.png"');
        expect(dl2.headers()["content-disposition"]).not.toContain(noName.id);
      } finally {
        await db().message.delete({ where: { id: noName.id } }).catch(() => {});
      }
    } finally {
      await db().message.delete({ where: { id: msg.id } }).catch(() => {});
      await db().conversation.delete({ where: { id: conv.id } }).catch(() => {});
      await db().contact.delete({ where: { id: contact.id } }).catch(() => {});
    }
  });
});
