import { NextResponse } from "next/server";

import { db } from "@/lib/db";

/**
 * Health endpoint for legacy probes that hit Next.js at /api/health.
 *
 *   GET /api/health
 *     200 — Postgres + NestJS api both reachable
 *     503 — either dependency unreachable
 *
 * Post-monorepo: this endpoint is what the docker-compose `web` service's
 * healthcheck consults (see docker-compose.yml). It MUST cover every
 * downstream the customer chat path requires — not just our local DB.
 * Without the api probe, an api or Redis outage left `docker compose ps`
 * reporting `web: healthy` while chat was completely broken, masking the
 * outage for operators. Probes both in parallel; status is OK only when
 * both pass.
 *
 * Intentionally unauthenticated — no privileged info in the response.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROBE_TIMEOUT_MS = 2_000;

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

async function probeApi(): Promise<{ ok: boolean; err?: string; degraded?: number }> {
  // INTERNAL_API_URL is the docker-compose service name path (e.g.
  // `http://api:4000`, always set in compose); on host dev it's unset and
  // falls back to localhost — matching api-client.ts / session-invalidation.ts
  // so the probe actually resolves. NestJS exposes /health (NOT /api/health —
  // different mount).
  const base = process.env.INTERNAL_API_URL ?? "http://127.0.0.1:4000";
  const url = `${base.replace(/\/$/, "")}/health`;
  try {
    const res = await withTimeout(
      fetch(url, { cache: "no-store" }),
      PROBE_TIMEOUT_MS,
      "api",
    );
    if (!res.ok) return { ok: false, err: `HTTP ${res.status}` };
    // Status-code alone is NOT enough: the api's /health deliberately returns
    // 200 with `ok:false` when Redis is down (it 503s only on Postgres, to
    // keep Postgres-only webhook ingest in Caddy's rotation). A 200 there hides
    // a wedged Redis — sends, workflows, broadcasts, and webhook delivery are
    // all dark while every container still shows healthy. Parse the body and
    // propagate `ok:false` so THIS endpoint 503s, flipping the web container
    // healthcheck red and giving `docker ps` a true data-plane signal — which
    // is exactly what this file's header comment promises.
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; redis?: boolean; db?: boolean; degraded?: string[] }
      | null;
    // Forward the COUNT of breached thresholds, never the strings. The api's
    // /health is not routed publicly (Caddy sends /api/health here, and only
    // this endpoint is reachable from the internet), so without this an
    // external uptime monitor can see hard-down only — every soft degradation
    // the api tracks (wedged outbox, saturated pool, queue burning retries)
    // is invisible from outside the box. A count is enough to alarm on;
    // the strings stay internal because they describe our capacity and load
    // to anyone who asks, including someone probing whether a flood is working.
    // Operators read the detail from the api logs (HEALTH DEGRADED) or the
    // internal endpoint.
    const degraded = Array.isArray(body?.degraded) ? body.degraded.length : undefined;
    if (body && body.ok === false) {
      const down: string[] = [];
      if (body.db === false) down.push("db");
      if (body.redis === false) down.push("redis");
      return {
        ok: false,
        err: `api reports ok:false${down.length ? ` (${down.join(", ")} down)` : ""}`,
        ...(degraded !== undefined ? { degraded } : {}),
      };
    }
    return { ok: true, ...(degraded !== undefined ? { degraded } : {}) };
  } catch (err) {
    return { ok: false, err: err instanceof Error ? err.message : String(err) };
  }
}

async function probeDb(): Promise<{ ok: boolean; err?: string }> {
  try {
    await withTimeout(db.$queryRaw`SELECT 1`, PROBE_TIMEOUT_MS, "db");
    return { ok: true };
  } catch (err) {
    return { ok: false, err: err instanceof Error ? err.message : String(err) };
  }
}

export async function GET() {
  const [dbResult, apiResult] = await Promise.all([probeDb(), probeApi()]);
  const ok = dbResult.ok && apiResult.ok;

  return NextResponse.json(
    {
      status: ok ? "ok" : "down",
      components: {
        db: { status: dbResult.ok ? "ok" : "fail", ...(dbResult.err ? { detail: dbResult.err } : {}) },
        api: { status: apiResult.ok ? "ok" : "fail", ...(apiResult.err ? { detail: apiResult.err } : {}) },
      },
      uptimeSeconds: Math.round(process.uptime()),
      // How many soft thresholds the api currently reports as breached. 0 (or
      // absent, if the api didn't answer) means nothing is degraded.
      //
      // ALERT ON THIS being > 0. It deliberately does NOT affect the status
      // code: this endpoint is the web container's healthcheck, and flipping
      // it 503 over a busy connection pool would restart-loop the container
      // during exactly the load spike that caused it — turning a slow minute
      // into an outage. Degradation is a page for a human, not a restart.
      degradedCount: apiResult.degraded ?? 0,
      timestamp: new Date().toISOString(),
    },
    {
      status: ok ? 200 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}
