import { Controller, Get } from "@nestjs/common";

import { getPlatformAnalytics } from "@/lib/queries";

import { RequireRole } from "../auth/role.guard";

/**
 * Platform analytics for the super-admin Overview page.
 *
 *   GET /api/admin/analytics — cross-team aggregates (org counts by status,
 *                              platform totals, signup momentum, pending queue)
 *
 * Separate base path from AdminTeamsController so `/analytics` never collides
 * with the `/api/admin/teams/:id` param route. superAdmin-only.
 */
@Controller("api/admin/analytics")
@RequireRole("superAdmin")
export class AdminAnalyticsController {
  @Get()
  async get() {
    return getPlatformAnalytics();
  }
}
