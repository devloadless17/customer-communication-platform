import { createHmac, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { ingestEvents } from "@/lib/providers/ingest";
import { metaProvider } from "@/lib/providers/meta";

/**
 * Meta WhatsApp Cloud API webhook.
 *
 *   GET  → one-time verification challenge from the dashboard
 *   POST → real events; auth via X-Hub-Signature-256 HMAC of the raw body
 *
 * Meta retries on non-200, so we only return errors when ingest blows up;
 * malformed/unexpected payloads still 200 to keep the queue moving.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  const expected = process.env.META_VERIFY_TOKEN;
  if (!expected) {
    console.error("[meta-webhook] META_VERIFY_TOKEN not set; refusing verify.");
    return new NextResponse("server misconfigured", { status: 500 });
  }

  if (mode === "subscribe" && token === expected && challenge) {
    // Meta requires plain-text echo of the challenge value.
    return new NextResponse(challenge, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }
  return new NextResponse("forbidden", { status: 403 });
}

export async function POST(req: Request) {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    console.error("[meta-webhook] META_APP_SECRET not set; refusing.");
    return new NextResponse("server misconfigured", { status: 500 });
  }

  // Signature verification needs the EXACT bytes Meta signed. Reading json()
  // re-serializes and would invalidate the HMAC.
  const rawBody = await req.text();
  const sigHeader = req.headers.get("x-hub-signature-256");
  if (!verifySignature(rawBody, sigHeader, appSecret)) {
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

  try {
    await ingestEvents("meta_cloud", events);
  } catch (err) {
    console.error("[meta-webhook] ingest failed", err);
    return new NextResponse("ingest failed", { status: 500 });
  }

  return NextResponse.json({ ok: true, ingested: events.length });
}

function verifySignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
