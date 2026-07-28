import { Controller, Get } from "@nestjs/common";

import { getPlatformAnalytics } from "@/lib/queries";

import { RequireRole } from "../auth/role.guard";
import { DbService } from "../db/db.service";
import { buildOpsSnapshot } from "../health/ops-snapshot";

/**
 * Platform analytics for the super-admin Overview page.
 *
 *   GET /api/admin/analytics     — cross-team aggregates (org counts by status,
 *                                  platform totals, signup momentum, pending queue)
 *   GET /api/admin/analytics/ops — operational snapshot: degraded[] thresholds,
 *                                  DURABLE per-queue failed/waiting counts from
 *                                  Redis (the restart-proof truth the in-process
 *                                  /health counters can't give), outbox lag, and
 *                                  whether ops alerts are configured.
 *
 * Separate base path from AdminTeamsController so `/analytics` never collides
 * with the `/api/admin/teams/:id` param route. superAdmin-only.
 */
@Controller("api/admin/analytics")
@RequireRole("superAdmin")
export class AdminAnalyticsController {
  constructor(private readonly db: DbService) {}

  @Get()
  async get() {
    return getPlatformAnalytics();
  }

  @Get("ops")
  async ops() {
    return buildOpsSnapshot(this.db);
  }
}
