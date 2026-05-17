import { NextResponse } from "next/server";

import { db } from "@/lib/db";

/**
 * Health endpoint for legacy probes that hit Next.js at /api/health.
 *
 *   GET /api/health
 *     200 — Postgres reachable
 *     503 — DB unreachable
 *
 * Post-monorepo: only checks the database (the only dependency Next.js has
 * besides Better Auth). Redis + BullMQ live in the NestJS api; probe
 * `:4000/health` for those. Caddy in front of both services aggregates.
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

export async function GET() {
  let dbOk = false;
  let dbErr: string | undefined;
  try {
    await withTimeout(db.$queryRaw`SELECT 1`, PROBE_TIMEOUT_MS, "db");
    dbOk = true;
  } catch (err) {
    dbErr = err instanceof Error ? err.message : String(err);
  }

  return NextResponse.json(
    {
      status: dbOk ? "ok" : "down",
      components: { db: { status: dbOk ? "ok" : "fail", ...(dbErr ? { detail: dbErr } : {}) } },
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    },
    {
      status: dbOk ? 200 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}
