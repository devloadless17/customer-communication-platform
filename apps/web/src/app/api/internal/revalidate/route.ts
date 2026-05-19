import { NextResponse } from "next/server";
import { updateTag } from "next/cache";

/**
 * Internal cache-revalidation endpoint. Called by NestJS from its
 * `team.catalog_changed` bus subscriber after a mutation that should
 * bust the matching Next.js data-cache tag.
 *
 *   POST /api/internal/revalidate
 *   Header: x-internal-secret: <INTERNAL_BUS_SECRET>
 *   Body:   { tag: string, teamId: string }
 *
 * Without this bridge, the only freshness signal is the 60s time-based
 * revalidate on each cached read — admins would see stale labels / lists
 * for up to a minute after their own edits.
 *
 * Auth: shared secret in the `x-internal-secret` header. The endpoint is
 * NOT cookie-gated (no session); it's listed in `proxy.ts` as a public-api
 * path that does its own auth. The secret is timing-safe-compared so an
 * attacker probing the header can't learn its prefix from response time.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function POST(req: Request): Promise<Response> {
  const expected = process.env.INTERNAL_BUS_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: "internal_revalidate_unavailable" },
      { status: 503 },
    );
  }
  const got = req.headers.get("x-internal-secret") ?? "";
  if (!timingSafeEqual(got, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed =
    body && typeof body === "object" && "tag" in body && typeof (body as { tag: unknown }).tag === "string"
      ? ((body as { tag: string }).tag)
      : null;
  if (!parsed) {
    return NextResponse.json({ error: "tag_required" }, { status: 400 });
  }
  // Allowlist — only known catalog tags accept revalidation so a
  // misconfigured client can't churn arbitrary tag names through the
  // cache (each revalidateTag invalidates GLOBALLY across users).
  const allowed = new Set([
    // "team-root" intentionally omitted — getCurrentTeam() in queries.ts no
    // longer tags the response (no rename endpoint exists; nothing publishes
    // a matching catalog_changed scope). Re-add here AND in queries.ts AND
    // wire a publisher the moment a Team-update endpoint ships.
    "team-members",
    "catalog-tags",
    "catalog-snippets",
    "catalog-stages",
    "catalog-contact-fields",
  ]);
  if (!allowed.has(parsed)) {
    return NextResponse.json({ error: "tag_not_allowed" }, { status: 400 });
  }

  // Next 16: `updateTag` is the route-handler-friendly bust (no profile
  // arg, callable outside server actions). `revalidateTag` in Next 16
  // requires a CacheLifeConfig + only runs from a server action.
  //
  // Wrap in try/catch so a thrown updateTag (Next internals, edge cases on
  // version bumps) returns 500 instead of a silent 200. The NestJS-side
  // subscriber logs non-2xx loudly — without this the cache stays stale
  // until the 60s time-based revalidate, with no operator signal.
  try {
    updateTag(parsed);
  } catch (err) {
    console.error(
      `[cache-revalidate] updateTag(${parsed}) threw: ${err instanceof Error ? err.message : err}`,
    );
    return NextResponse.json({ error: "revalidate_failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
