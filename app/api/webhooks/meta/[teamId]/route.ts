import { createHmac, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { blobStorage } from "@/lib/blob-storage";
import { db } from "@/lib/db";
import { MEDIA_SIZE_CAPS } from "@/lib/media-storage";
import { getMetaSendConfig, getMetaWebhookConfig } from "@/lib/providers/config";
import { ingestEvents } from "@/lib/providers/ingest";
import { metaProvider } from "@/lib/providers/meta";
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

  const events = metaProvider.parseWebhook(payload);
  if (events.length === 0) {
    return NextResponse.json({ ok: true, ingested: 0 });
  }

  // For each event with media, download the binary from Meta NOW — the
  // signed URL Meta returns for /<media-id> expires in ~5 minutes. We can't
  // defer this to a worker on the MVP without losing media on a slow queue.
  await downloadInboundMedia(teamId, events);

  try {
    await ingestEvents(teamId, "meta_cloud", events);
  } catch (err) {
    console.error(`[meta-webhook ${teamId}] ingest failed`, err);
    return new NextResponse("ingest failed", { status: 500 });
  }

  return NextResponse.json({ ok: true, ingested: events.length });
}

async function downloadInboundMedia(
  teamId: string,
  events: NormalizedEvent[],
): Promise<void> {
  const mediaEvents = events.filter(
    (e) => e.kind === "message" && e.media && !e.media.storageKey,
  );
  if (mediaEvents.length === 0) return;

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
    return;
  }

  // Team name is only used to build a human-readable filename in the blob
  // provider's dashboard — we read it once per webhook batch instead of
  // per-event.
  const team = await db.team.findUnique({
    where: { id: teamId },
    select: { name: true },
  });

  await Promise.all(
    mediaEvents.map(async (evt) => {
      if (evt.kind !== "message" || !evt.media) return;
      try {
        const fetched = await metaProvider.fetchMedia!(
          evt.media.externalMediaId,
          sendConfig,
        );
        const cap = MEDIA_SIZE_CAPS[evt.media.kind];
        if (fetched.bytes.length > cap) {
          console.warn(
            `[meta-webhook ${teamId}] dropping ${evt.media.kind} over cap (${fetched.bytes.length} > ${cap})`,
          );
          delete evt.media; // ingest the message as text-only with empty body
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
            // conversationId isn't known yet — ingest find-or-creates it. The
            // filename still has enough scoping (team + phone + wamid) to be
            // useful in the dashboard.
            externalId: evt.externalId,
            originalFilename: evt.media.filename ?? null,
          },
        });
        evt.media.storageKey = saved.key;
        evt.media.storageUrl = saved.url;
        evt.media.sizeBytes = saved.sizeBytes;
        // Meta's metadata sometimes refines the mime type vs what was on the
        // webhook (e.g. image/jpeg vs image/jpg). Trust the metadata call.
        evt.media.mimeType = fetched.mimeType;
      } catch (err) {
        console.error(
          `[meta-webhook ${teamId}] media download failed for ${evt.externalId}`,
          err,
        );
        // Best-effort: drop the media block but keep the message so the
        // agent at least sees "Media unavailable" in the thread.
        delete evt.media;
      }
    }),
  );
}

function verifySignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
