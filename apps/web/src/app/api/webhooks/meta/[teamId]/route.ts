import { NextResponse } from "next/server";

/**
 * Legacy Meta webhook URL — keeps working for any subscription that still
 * points at the pre-migration path. Forwards bytes verbatim to the NestJS
 * api so HMAC verification (computed over the raw body) still passes.
 *
 *   Old URL (this file):   /api/webhooks/meta/{teamId}  → handled by Next.js
 *   New URL (canonical):   /webhooks/meta/{teamId}      → handled by NestJS
 *
 * Meta's webhook client does NOT follow 3xx redirects on POST in practice,
 * so a 308 would surface as a delivery failure even though the new endpoint
 * is reachable. A server-side proxy is the only shape that keeps existing
 * subscriptions functional during the cutover window.
 *
 * Operators SHOULD flip the URL in the Meta App Dashboard to the canonical
 * path before deploying — this proxy is insurance, not a permanent design.
 * Delete this file once every subscription has been updated.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INTERNAL_API_URL = process.env.INTERNAL_API_URL ?? "http://127.0.0.1:4000";

// Header allow-list — strip hop-by-hop headers per RFC 7230 §6.1 plus the
// Host header (the upstream sets its own). Everything else (notably
// X-Hub-Signature-256, content-type, content-length) is forwarded as-is.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

function buildForwardHeaders(incoming: Headers): Headers {
  const out = new Headers();
  incoming.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out.set(key, value);
  });
  return out;
}

async function forward(
  req: Request,
  teamId: string,
  method: "GET" | "POST",
): Promise<Response> {
  const target = new URL(`/webhooks/meta/${encodeURIComponent(teamId)}`, INTERNAL_API_URL);
  const incoming = new URL(req.url);
  incoming.searchParams.forEach((value, key) => target.searchParams.append(key, value));

  // For POST, read the raw bytes and pass them through unchanged so the
  // HMAC computed by NestJS over `req.rawBody` still matches Meta's
  // X-Hub-Signature-256. Any JSON re-stringification here would corrupt
  // the signature.
  const body = method === "POST" ? await req.arrayBuffer() : undefined;

  try {
    const upstream = await fetch(target, {
      method,
      headers: buildForwardHeaders(req.headers),
      body: body ? Buffer.from(body) : undefined,
      // The upstream redirects (if any) shouldn't be followed at the proxy
      // layer; the verification handler is the terminal endpoint.
      redirect: "manual",
      cache: "no-store",
    });

    // Stream the upstream response back verbatim — status, headers, body.
    return new NextResponse(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "upstream unavailable", detail: message },
      { status: 502 },
    );
  }
}

interface RouteContext {
  params: Promise<{ teamId: string }>;
}

export async function GET(req: Request, ctx: RouteContext): Promise<Response> {
  const { teamId } = await ctx.params;
  return forward(req, teamId, "GET");
}

export async function POST(req: Request, ctx: RouteContext): Promise<Response> {
  const { teamId } = await ctx.params;
  return forward(req, teamId, "POST");
}
