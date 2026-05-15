import { createHmac, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { blobStorage } from "@/lib/blob-storage";
import { db } from "@/lib/db";
import { MEDIA_SIZE_CAPS } from "@/lib/media-storage";
import { getMetaProvider } from "@/lib/providers";
import { getMetaSendConfig, getMetaWebhookConfig } from "@/lib/providers/config";
import { ingestEvents } from "@/lib/providers/ingest";
import { emitToTeam } from "@/lib/socket/server";
import type { NormalizedEvent } from "@/lib/providers/types";

/**
 * Per-team Meta WhatsApp Cloud API webhook.
 *
 *   GET  /api/webhooks/meta/<teamId>   → one-time verification challenge
 *   POST /api/webhooks/meta/<teamId>   → real events; HMAC of the raw body
 *
 * The teamId in the URL is the routing signal (CLAUDE.md rule #6 — secrets
 * per team). We don't trust it for authority; the HMAC against the team's
 * `metaAppSecret` is the actual proof of origin.
 *
 * Meta retries on non-200, so we only return errors when ingest blows up;
 * malformed/unexpected payloads still 200 to keep the queue moving.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ teamId: string }> },
) {
  const { teamId } = await ctx.params;
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  const config = await getMetaWebhookConfig(teamId);
  if (!config) {
    // Silent 403 — leaking "team unconfigured" vs "team not found" gives
    // attackers a teamId enumeration oracle on a public endpoint.
    return new NextResponse("forbidden", { status: 403 });
  }

  if (mode === "subscribe" && token === config.verifyToken && challenge) {
    return new NextResponse(challenge, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }
  return new NextResponse("forbidden", { status: 403 });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ teamId: string }> },
) {
  const { teamId } = await ctx.params;

  const config = await getMetaWebhookConfig(teamId);
  if (!config) {
    return new NextResponse("forbidden", { status: 403 });
  }

  // Signature verification needs the EXACT bytes Meta signed. Reading json()
  // re-serializes and would invalidate the HMAC.
  const rawBody = await req.text();
  const sigHeader = req.headers.get("x-hub-signature-256");
  if (!verifySignature(rawBody, sigHeader, config.appSecret)) {
    return new NextResponse("forbidden", { status: 403 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: true, dropped: "malformed" });
  }

  const events = getMetaProvider().parseWebhook(payload);
  if (events.length === 0) {
    return NextResponse.json({ ok: true, ingested: 0 });
  }

  // Two-phase media flow for low-latency inbound:
  //
  //   Phase 1 (sync, fast):
  //     ingest immediately so the message row exists and the agent's UI gets
  //     `message:new` with `mediaPending: true` in ~50ms. Bubble paints a
  //     placeholder (📷 Photo / 🎥 Video / …).
  //
  //   Phase 2 (background, after 200 to Meta):
  //     fetch the binary from Meta + upload to our blob provider, then UPDATE
  //     the row and emit `message:media:ready` so the bubble swaps in the
  //     real file. Meta's signed URL has a ~5-min window which starts on the
  //     /<media-id> metadata GET — not on webhook receipt — so deferring the
  //     download until after we return 200 is still well inside the window.
  //
  // On a single VPS with our custom Node server, detached promises continue
  // running after the Response is sent (no serverless cold-cutoff). On
  // failure mid-download, the row stays text-only (we emit a media:ready
  // with no media payload so the placeholder clears).
  try {
    await ingestEvents(teamId, "meta_cloud", events);
  } catch (err) {
    console.error(`[meta-webhook ${teamId}] ingest failed`, err);
    return new NextResponse("ingest failed", { status: 500 });
  }

  void downloadInboundMedia(teamId, events).catch((err) =>
    console.error(`[meta-webhook ${teamId}] background media download failed`, err),
  );

  return NextResponse.json({ ok: true, ingested: events.length });
}

/**
 * Phase 2 of the inbound media flow — runs detached from the webhook
 * response. Picks up the rows ingest just inserted (mediaKind set, mediaUrl
 * still null), fetches the binary from Meta, uploads to blob storage, UPDATEs
 * the row, and emits `message:media:ready` so the bubble swaps its
 * placeholder for the real file.
 *
 * Failures (network, Meta 4xx, size cap exceeded) clear the media columns on
 * the row and emit a `message:media:ready` with no media payload — the
 * placeholder drops and the bubble renders as a regular text row (caption
 * preserved). Better than a stuck "downloading…" spinner.
 */
async function downloadInboundMedia(
  teamId: string,
  events: NormalizedEvent[],
): Promise<void> {
  const mediaEvents = events.filter(
    (e): e is Extract<NormalizedEvent, { kind: "message" }> =>
      e.kind === "message" && !!e.media && !e.media.storageKey,
  );
  if (mediaEvents.length === 0) return;

  // Look up the rows ingest just inserted. Skip rows whose mediaUrl is
  // already populated — that's a Meta retry where we previously succeeded.
  const externalIds = mediaEvents.map((e) => e.externalId);
  const rows = await db.message.findMany({
    where: { teamId, externalId: { in: externalIds } },
    select: { id: true, externalId: true, conversationId: true, mediaUrl: true },
  });
  const rowByExtId = new Map(rows.map((r) => [r.externalId, r]));
  const todo = mediaEvents.filter((e) => {
    const row = rowByExtId.get(e.externalId);
    return row && !row.mediaUrl;
  });
  if (todo.length === 0) return;

  // Send config has the access token Meta requires for both the media-meta
  // call AND the binary CDN. Webhook config (verify token + app secret) is
  // not enough — we need the bearer token from the send config.
  let sendConfig;
  try {
    sendConfig = await getMetaSendConfig(teamId);
  } catch (err) {
    console.warn(
      `[meta-webhook ${teamId}] cannot download media — send config missing`,
      err,
    );
    await Promise.all(todo.map((e) => clearMediaOnRow(teamId, rowByExtId.get(e.externalId)!.id, rowByExtId.get(e.externalId)!.conversationId)));
    return;
  }

  // Team name is only used to build a human-readable filename in the blob
  // provider's dashboard — we read it once per webhook batch instead of
  // per-event.
  const team = await db.team.findUnique({
    where: { id: teamId },
    select: { name: true },
  });

  // Concurrency cap. A 20-image webhook batch fans out 20 parallel Meta
  // CDN fetches + 20 UploadThing uploads — both peg the heap (each fetch
  // buffers the binary in RAM) and risk 429s on UploadThing. 4 in-flight
  // is enough to overlap network latency without piling up.
  await runWithConcurrency(todo, 4, async (evt) => {
    if (!evt.media) return;
    const row = rowByExtId.get(evt.externalId);
    if (!row) return;
    try {
      const fetched = await getMetaProvider().fetchMedia!(
        evt.media.externalMediaId,
        sendConfig,
      );
      const cap = MEDIA_SIZE_CAPS[evt.media.kind];
      if (fetched.bytes.length > cap) {
        console.warn(
          `[meta-webhook ${teamId}] dropping ${evt.media.kind} over cap (${fetched.bytes.length} > ${cap})`,
        );
        await clearMediaOnRow(teamId, row.id, row.conversationId);
        return;
      }
      const saved = await blobStorage.upload({
        bytes: fetched.bytes,
        mimeType: fetched.mimeType,
        kind: evt.media.kind,
        context: {
          teamId,
          teamSlug: team?.name,
          direction: "in",
          contactPhone: evt.contactPhone,
          contactName: evt.contactName ?? undefined,
          externalId: evt.externalId,
          originalFilename: evt.media.filename ?? null,
        },
      });

      // Meta's metadata sometimes refines the mime type vs what was on the
      // webhook (e.g. image/jpeg vs image/jpg). Trust the metadata call.
      await db.message.update({
        where: { id: row.id },
        data: {
          mediaKey: saved.key,
          mediaUrl: saved.url,
          mediaSizeBytes: saved.sizeBytes,
          mediaMimeType: fetched.mimeType,
        },
      });

      emitToTeam(teamId, "message:media:ready", {
        teamId,
        conversationId: row.conversationId,
        messageId: row.id,
        media: {
          kind: evt.media.kind,
          url: `/api/media/${row.id}`,
          mimeType: fetched.mimeType,
          sizeBytes: saved.sizeBytes,
          ...(evt.body ? { caption: evt.body } : {}),
          ...(evt.media.filename ? { filename: evt.media.filename } : {}),
          ...(evt.media.durationMs != null ? { durationMs: evt.media.durationMs } : {}),
        },
      });
    } catch (err) {
      console.error(
        `[meta-webhook ${teamId}] media download failed for ${evt.externalId}`,
        err,
      );
      await clearMediaOnRow(teamId, row.id, row.conversationId);
    }
  });
}

/**
 * Tiny dependency-free p-limit. Walks `items` and runs at most `concurrency`
 * `worker(item)` invocations in parallel. Resolves once all are done.
 * Rejections are swallowed at the worker level (caller wraps each item in
 * try/catch) so one bad item never blocks the rest.
 */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const queue = [...items];
  const lanes = Math.min(concurrency, queue.length);
  const runners = Array.from({ length: lanes }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) return;
      await worker(next);
    }
  });
  await Promise.all(runners);
}

/**
 * Strip a row's media columns and tell the room — the placeholder drops and
 * the bubble renders as a text-only row (caption stays in `body`). Used when
 * the binary download fails or the file exceeds the per-kind cap.
 */
async function clearMediaOnRow(
  teamId: string,
  messageId: string,
  conversationId: string,
): Promise<void> {
  try {
    await db.message.update({
      where: { id: messageId },
      data: {
        mediaKind: null,
        mediaMimeType: null,
        mediaCaption: null,
        mediaFilename: null,
        mediaDurationMs: null,
        mediaKey: null,
        mediaUrl: null,
        mediaSizeBytes: null,
      },
    });
  } catch (err) {
    console.error(`[meta-webhook ${teamId}] clearMediaOnRow failed for ${messageId}`, err);
  }
  emitToTeam(teamId, "message:media:ready", {
    teamId,
    conversationId,
    messageId,
    // No media → client drops the placeholder.
  });
}

function verifySignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
