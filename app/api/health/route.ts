import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { getRedisConnection } from "@/lib/workflows/queue";

/**
 * Health endpoint for reverse proxy + systemd liveness probes.
 *
 *   GET /api/health
 *     200 — Postgres reachable, Redis PONGs.
 *     503 — at least one dependency is unhealthy. Body says which.
 *
 * Intentionally NOT authenticated — probes (Caddy, uptime services, systemd
 * ExecStartPost) need to hit it without a session. There's no privileged
 * information in the response, only "is the boring infra alive". 5s upper
 * bound on the work so a probe storm during a slow restart doesn't pile up.
 *
 * Performance note: both checks are cheap (~1ms in healthy state). We don't
 * cache the result — that's the whole point of a healthcheck.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROBE_TIMEOUT_MS = 2_000;

type ComponentStatus = "ok" | "fail" | "degraded";

interface HealthBody {
  status: "ok" | "degraded" | "down";
  components: {
    db: { status: ComponentStatus; detail?: string };
    redis: { status: ComponentStatus; detail?: string };
  };
  uptimeSeconds: number;
  // Date.now() is wall-clock; OK here because probes don't depend on monotonic.
  timestamp: string;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

async function checkDb(): Promise<HealthBody["components"]["db"]> {
  try {
    await withTimeout(db.$queryRaw`SELECT 1`, PROBE_TIMEOUT_MS, "db");
    return { status: "ok" };
  } catch (err) {
    return {
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkRedis(): Promise<HealthBody["components"]["redis"]> {
  try {
    const conn = getRedisConnection();
    const reply = await withTimeout(conn.ping(), PROBE_TIMEOUT_MS, "redis");
    if (reply !== "PONG") {
      return { status: "fail", detail: `unexpected ping reply: ${reply}` };
    }
    return { status: "ok" };
  } catch (err) {
    return {
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function GET() {
  const [dbStatus, redisStatus] = await Promise.all([checkDb(), checkRedis()]);

  const allOk = dbStatus.status === "ok" && redisStatus.status === "ok";
  const body: HealthBody = {
    status: allOk ? "ok" : "down",
    components: { db: dbStatus, redis: redisStatus },
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  };

  return NextResponse.json(body, {
    status: allOk ? 200 : 503,
    headers: {
      // Cache-Control: no-store — every probe must hit fresh.
      "cache-control": "no-store",
    },
  });
}
