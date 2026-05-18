import { Controller, Get } from "@nestjs/common";

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
 *   - Docker compose healthcheck
 *   - Caddy upstream availability check
 *   - Manual smoke during deploys
 *
 * Probes BOTH Postgres and Redis so a half-down dependency surfaces
 * immediately instead of waiting for a real request to fail.
 */
@Controller("health")
export class HealthController {
  constructor(private readonly db: DbService) {}

  @Get()
  async check(): Promise<HealthReport> {
    const [dbOk, redisOk] = await Promise.all([this.pingDb(), this.pingRedis()]);
    return {
      ok: dbOk && redisOk,
      db: dbOk,
      redis: redisOk,
      uptimeSec: Math.floor(process.uptime()),
    };
  }

  private async pingDb(): Promise<boolean> {
    try {
      await this.db.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  private async pingRedis(): Promise<boolean> {
    try {
      const reply = await getRedisConnection().ping();
      return reply === "PONG";
    } catch {
      return false;
    }
  }
}
