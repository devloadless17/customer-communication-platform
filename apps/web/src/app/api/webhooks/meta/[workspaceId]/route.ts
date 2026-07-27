import { NextResponse } from "next/server";

/**
 * Legacy Meta webhook URL — keeps working for any subscription that still
 * points at the pre-migration path. Forwards bytes verbatim to the NestJS
 * api so HMAC verification (computed over the raw body) still passes.
 *
 *   Old URL (this file):   /api/webhooks/meta/{workspaceId}  → handled by Next.js
 *   New URL (canonical):   /webhooks/meta/{workspaceId}      → handled by NestJS
 *
 * Meta's webhook client does NOT follow 3xx redirects on POST in practice,
 * so a 308 would surface as a delivery failure even though the new endpoint
 * is reachable. A server-side proxy is the only shape that keeps existing
 * subscriptions functional during the cutover window.
 *
 * Operators SHOULD flip the URL in the Meta App Dashboard to the canonical
 * path before deploying — this proxy is insurance, not a permanent design.
 *
 * ---
 *
 * BROKEN 2026-07-22 → 2026-07-27, and that is EVIDENCE. The org→workspace
 * rename (f59696a9) renamed the variable inside this file — including the
 * `ctx.params` destructure — but left the DIRECTORY named `[teamId]`. In the
 * App Router the params key comes from the directory segment, so
 * `const { workspaceId } = await ctx.params` was `undefined` and every legacy
 * delivery forwarded to `/webhooks/meta/undefined`, which NestJS rejects.
 *
 * Five days of that with nobody reporting missing Meta messages is the
 * strongest signal yet that NO live subscription still points at this legacy
 * URL — which is exactly what step 1 of the checklist below is trying to
 * establish. The directory is now `[workspaceId]` so the proxy works again;
 * treat the outage as a data point for the deletion decision, not as a reason
 * to skip the log check.
 *
 * DELETION DEADLINE: 2026-08-03  (extended 2026-07-03 from 2026-06-19)
 *
 * Extension note (2026-07-03): the original 2026-06-19 deadline lapsed
 * without the deletion checklist being run — prod Caddy access logs could
 * not be confirmed clear of `/api/webhooks/meta/` hits, so this proxy is
 * kept alive rather than risk breaking any Meta subscription still pointing
 * at the legacy URL. A tracking issue is owed to chase the un-flipped
 * subscription (see policy note at the bottom of this block); do NOT extend
 * again silently.
 *
 * (Originally added during the NestJS migration cutover on 2026-05-17.
 * One pilot tenant + a 30-day window to confirm every Meta subscription
 * is on the new /webhooks/meta/{workspaceId} URL. After the deadline:
 *
 *   1. Confirm zero hits to this route in the access logs for the prior 7d
 *      (`grep '/api/webhooks/meta/' /var/log/caddy/access.log` or whatever
 *      log path the deploy is shipping).
 *   2. Delete this file.
 *   3. Delete the `/api/webhooks/meta/*` handle block in
 *      `deploy/Caddyfile.template`.
 *   4. Update CLAUDE.md to drop the "legacy Meta webhook proxy" line from
 *      the non-migrated-routes table.
 *
 * If the deadline arrives and traffic is still landing here, push the
 * date out — but ALSO open a tracking issue to chase the operator who
 * hasn't flipped their subscription, instead of silently extending.)
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INTERNAL_API_URL = process.env.INTERNAL_API_URL ?? "http://127.0.0.1:4000";

// Hard ceiling on the buffered body. Meta webhook bodies are KB-scale (they
// reference media by URL rather than embed binary), and the downstream NestJS
// bodyParser caps JSON at 10mb anyway — so anything larger is either garbage
// or an attack. Without a cap, `req.arrayBuffer()` buffers the whole body into
// the web (auth/pages) container's heap before NestJS ever verifies the HMAC;
// the endpoint is unauthenticated, so an attacker can repeatedly POST oversized
// bodies to OOM-kill the user-facing container. Reading with a byte ceiling and
// returning 413 on overflow bounds that to a fixed buffer per request.
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * Read the request body into a single Buffer, aborting with `null` the moment
 * the accumulated size exceeds `MAX_BODY_BYTES`. Streaming the chunks (rather
 * than `req.arrayBuffer()`) lets us bail BEFORE buffering an unbounded body.
 */
async function readBodyCapped(req: Request): Promise<Buffer | null> {
  const reader = req.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        // Stop pulling; let the upstream connection reset rather than keep
        // draining an attacker's oversized stream into memory.
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks);
}

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

/**
 * Mirror the request-side allowlist for the upstream response. Without this
 * a `content-encoding` or `transfer-encoding` set by upstream gets forwarded
 * to Meta while Node's `fetch` has already decoded the body — Meta then
 * sees a header/body mismatch and treats the delivery as malformed.
 */
function buildResponseHeaders(upstream: Headers): Headers {
  const out = new Headers();
  upstream.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase()) && key.toLowerCase() !== "content-encoding") {
      out.set(key, value);
    }
  });
  return out;
}

async function forward(
  req: Request,
  workspaceId: string,
  method: "GET" | "POST",
): Promise<Response> {
  const target = new URL(`/webhooks/meta/${encodeURIComponent(workspaceId)}`, INTERNAL_API_URL);
  const incoming = new URL(req.url);
  incoming.searchParams.forEach((value, key) => target.searchParams.append(key, value));

  // For POST, read the raw bytes and pass them through unchanged so the
  // HMAC computed by NestJS over `req.rawBody` still matches Meta's
  // X-Hub-Signature-256. Any JSON re-stringification here would corrupt
  // the signature. Capped at MAX_BODY_BYTES so an unauthenticated attacker
  // can't OOM this container by streaming an unbounded body — null means the
  // cap was exceeded; reject with 413 before forwarding.
  // `fetch`'s BodyInit accepts `BufferSource` = `ArrayBufferView<ArrayBuffer>`,
  // but Node's `Buffer` is `Buffer<ArrayBufferLike>` (its backing buffer may be
  // a slice of a shared pool), which the DOM lib types reject. Copy the bytes
  // into a fresh, exactly-sized `ArrayBuffer`-backed `Uint8Array` so the body
  // is an unambiguous BodyInit. The bytes pass through verbatim, so the HMAC
  // NestJS computes over the raw body still matches Meta's signature.
  let body: Uint8Array<ArrayBuffer> | undefined;
  if (method === "POST") {
    const read = await readBodyCapped(req);
    if (read === null) {
      return NextResponse.json(
        { error: "payload too large" },
        { status: 413 },
      );
    }
    const copy = new Uint8Array(read.byteLength);
    copy.set(read);
    body = copy;
  }

  try {
    const upstream = await fetch(target, {
      method,
      headers: buildForwardHeaders(req.headers),
      body,
      // The upstream redirects (if any) shouldn't be followed at the proxy
      // layer; the verification handler is the terminal endpoint.
      redirect: "manual",
      cache: "no-store",
    });

    // Stream the upstream response back. Strip hop-by-hop +
    // content-encoding from the response side so Meta doesn't see a
    // header/body encoding mismatch (Node's fetch has already decoded
    // the body by the time we pipe it back).
    return new NextResponse(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: buildResponseHeaders(upstream.headers),
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
  params: Promise<{ workspaceId: string }>;
}

export async function GET(req: Request, ctx: RouteContext): Promise<Response> {
  const { workspaceId } = await ctx.params;
  return forward(req, workspaceId, "GET");
}

export async function POST(req: Request, ctx: RouteContext): Promise<Response> {
  const { workspaceId } = await ctx.params;
  return forward(req, workspaceId, "POST");
}
