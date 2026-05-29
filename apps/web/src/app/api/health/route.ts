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

async function probeApi(): Promise<{ ok: boolean; err?: string }> {
  // INTERNAL_API_URL is the docker-compose service name path (e.g.
  // `http://api:4000`); on host dev it falls back to localhost. NestJS
  // exposes /health (NOT /api/health — different mount).
  const base = process.env.INTERNAL_API_URL ?? "http://api:4000";
  const url = `${base.replace(/\/$/, "")}/health`;
  try {
    const res = await withTimeout(
      fetch(url, { cache: "no-store" }),
      PROBE_TIMEOUT_MS,
      "api",
    );
    if (!res.ok) return { ok: false, err: `HTTP ${res.status}` };
    return { ok: true };
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
      timestamp: new Date().toISOString(),
    },
    {
      status: ok ? 200 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}
