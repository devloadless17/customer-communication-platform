import { BadRequestException, Controller, Get, Query, UseGuards } from "@nestjs/common";

import { getWorkspaceReport, ReportRangeError } from "@/lib/analytics/reports";

import { RequireCapability } from "../auth/capability.guard";
import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { zQuery } from "../common/zod-validation.pipe";
import { ReportOverviewQuerySchema, type ReportOverviewQuery } from "./reports.schemas";

/**
 * Workspace performance reports.
 *
 *   GET /api/reports/overview?from&to&tz — every dashboard panel in one
 *     round-trip (volume, channels, first-response, resolution, per-agent,
 *     ticket SLA, AI share). Shape: WorkspaceReport (@ccp/shared/dtos).
 *
 * Gated by the SAME `teamActivity:view` capability as the member-stats page —
 * both answer "how is the team performing", so one admin-configurable switch
 * governs who sees either (default: admin + manager).
 */
@Controller("api/reports")
@UseGuards(SessionGuard)
export class ReportsController {
  @RequireCapability("teamActivity:view")
  @Get("overview")
  async overview(
    @CurrentSession() session: ApiSession,
    @Query(zQuery(ReportOverviewQuerySchema)) query: ReportOverviewQuery,
  ) {
    try {
      return await getWorkspaceReport(session.workspaceId, {
        from: new Date(query.from),
        to: new Date(query.to),
        tz: query.tz,
        accountId: query.accountId,
      });
    } catch (err) {
      if (err instanceof ReportRangeError) {
        throw new BadRequestException({ error: "invalid_range", detail: err.message });
      }
      throw err;
    }
  }
}
