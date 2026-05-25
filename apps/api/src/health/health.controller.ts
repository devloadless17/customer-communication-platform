import {
  Controller,
  Get,
  ServiceUnavailableException,
} from "@nestjs/common";

import { DbService } from "../db/db.service";
import { getRedisConnection } from "../lib/workflows/queue";

interface HealthReport {
  ok: boolean;
  db: boolean;
  redis: boolean;
  uptimeSec: number;
}

/**
 * Public health endpoint — no auth. Used by:
 *   - Docker compose + Dockerfile healthcheck (`wget … || exit 1` — exits
 *     non-zero on a 5xx, so a down dependency flips the container unhealthy)
 *   - Caddy upstream availability check
 *   - Manual smoke during deploys (greps the body for `"ok":true`)
 *
 * Probes BOTH Postgres and Redis so a half-down dependency surfaces
 * immediately instead of waiting for a real request to fail.
 *
 * Returns HTTP 200 when healthy, **503 when DB or Redis is down** — the body
 * is identical either way (full report) so the deploy smoke can still read
 * which dependency failed, but the status code lets the Docker/Caddy probes
 * react to a wedged data plane instead of seeing a permanent 200. The
 * healthcheck's `retries: 3` × `interval: 30s` means a transient blip needs
 * ~90s of sustained failure to flip unhealthy, so this can't flap.
 */
@Controller("health")
export class HealthController {
  constructor(private readonly db: DbService) {}

  @Get()
  async check(): Promise<HealthReport> {
    const [dbOk, redisOk] = await Promise.all([this.pingDb(), this.pingRedis()]);
    const report: HealthReport = {
      ok: dbOk && redisOk,
      db: dbOk,
      redis: redisOk,
      uptimeSec: Math.floor(process.uptime()),
    };
    if (!report.ok) {
      // 503 with the report as the body. ServiceUnavailableException
      // serializes its payload as the JSON response, so `"ok":false` + the
      // per-dependency flags are still visible to operators + the smoke grep.
      throw new ServiceUnavailableException(report);
    }
    return report;
  }

  // Bound each probe so /health always responds fast and reports the down
  // dependency as `false` — without this, a FROZEN (not refused) dependency
  // would hang on ioredis's 30s commandTimeout / the pg socket, and /health
  // would block well past the 3s container-healthcheck timeout. 2s is
  // comfortably under that probe timeout while tolerating a slow-but-alive DB.
  private static readonly PROBE_TIMEOUT_MS = 2_000;

  private async withTimeout(probe: Promise<boolean>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(
        () => resolve(false),
        HealthController.PROBE_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([probe, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async pingDb(): Promise<boolean> {
    return this.withTimeout(
      (async () => {
        try {
          await this.db.$queryRaw`SELECT 1`;
          return true;
        } catch {
          return false;
        }
      })(),
    );
  }

  private async pingRedis(): Promise<boolean> {
    return this.withTimeout(
      (async () => {
        try {
          const reply = await getRedisConnection().ping();
          return reply === "PONG";
        } catch {
          return false;
        }
      })(),
    );
  }
}
