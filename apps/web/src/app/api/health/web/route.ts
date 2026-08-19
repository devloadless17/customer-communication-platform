import { NextResponse } from "next/server";

import { db } from "@/lib/db";

/**
 * SHALLOW liveness probe for the WEB process — Postgres + process only, NO api
 * dependency. This is what Caddy's web-upstream `health_uri` consults.
 *
 * Why this exists separately from /api/health:
 *   - /api/health is the DEEP probe (db + NestJS api). It's correct for the
 *     Docker HEALTHCHECK + operator "is the whole chat path up?" question.
 *   - But Caddy's web reverse-proxy used the DEEP probe as its upstream health
 *     gate, so a routine api-only restart (or its 30-100s graceful drain) made
 *     Caddy mark the WEB upstream unhealthy → 502 on /login, /register, and
 *     every marketing/RSC page — even though Next.js itself was perfectly fine
 *     and only chat (which needs api) was briefly degraded. An api blip should
 *     NOT black out the login page.
 *
 * So Caddy points at THIS shallow probe (web alive?), while the deep probe
 * stays the Docker HEALTHCHECK so `docker compose ps` and operators still see
 * the full data-plane status. The split decouples web liveness from api
 * liveness without losing the deep signal.
 *
 * Intentionally unauthenticated — no privileged info in the response.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROBE_TIMEOUT_MS = 2_000;

// Module-scoped memo, mirroring /api/health: this route is unauthenticated and
// each hit costs a DB round-trip, so an anonymous flood becomes DB fan-out.
// 2s stays fresher than Caddy's health_uri interval while capping probe passes
// at 0.5/s; concurrent hits share the one in-flight pass. Server-side only —
// the response keeps no-store so nothing downstream caches the verdict.
const SNAPSHOT_TTL_MS = 2_000;

interface HealthSnapshot {
  httpStatus: number;
  body: Record<string, unknown>;
}

let memo: { at: number; snapshot: Promise<HealthSnapshot> } | null = null;

async function computeSnapshot(): Promise<HealthSnapshot> {
  let dbOk = true;
  let dbErr: string | undefined;
  try {
    await Promise.race([
      db.$queryRaw`SELECT 1`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`db timed out after ${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    dbOk = false;
    dbErr = err instanceof Error ? err.message : String(err);
  }

  return {
    httpStatus: dbOk ? 200 : 503,
    body: {
      status: dbOk ? "ok" : "down",
      components: {
        db: { status: dbOk ? "ok" : "fail", ...(dbErr ? { detail: dbErr } : {}) },
      },
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    },
  };
}

export async function GET() {
  const now = Date.now();
  if (!memo || now - memo.at >= SNAPSHOT_TTL_MS) {
    memo = { at: now, snapshot: computeSnapshot() };
  }
  const { httpStatus, body } = await memo.snapshot;

  return NextResponse.json(body, {
    status: httpStatus,
    headers: { "cache-control": "no-store" },
  });
}
