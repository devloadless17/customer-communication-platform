import { Controller, Get, Inject } from "@nestjs/common";
import type { Redis } from "ioredis";

import { BULLMQ_REDIS } from "../bullmq/bullmq.module";
import { PrismaService } from "../prisma/prisma.service";

interface HealthReport {
  ok: boolean;
  db: boolean;
  redis: boolean;
  uptimeSec: number;
}

/**
 * Public health endpoint — no auth. Used by:
 *   - Docker compose healthcheck (Phase 1 wires this in next pass)
 *   - Caddy upstream availability check
 *   - Manual smoke during deploys
 *
 * Probes BOTH Postgres and Redis so a half-down dependency surfaces
 * immediately instead of waiting for a real request to fail.
 */
@Controller("health")
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(BULLMQ_REDIS) private readonly redis: Redis,
  ) {}

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
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  private async pingRedis(): Promise<boolean> {
    try {
      const reply = await this.redis.ping();
      return reply === "PONG";
    } catch {
      return false;
    }
  }
}
