import { BadRequestException, Controller, Get, Query, UseGuards } from "@nestjs/common";

import { getWorkspaceReport, ReportRangeError } from "@/lib/analytics/reports";
import { getWabaAnalytics } from "@/lib/analytics/waba-analytics";

import { RequireCapability } from "../auth/capability.guard";
import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { zQuery } from "../common/zod-validation.pipe";
import {
  ReportOverviewQuerySchema,
  type ReportOverviewQuery,
  WabaAnalyticsQuerySchema,
  type WabaAnalyticsQueryInput,
} from "./reports.schemas";

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

  /**
   * Meta's own account-level analytics: spend, delivered volume, volume-tier
   * standing, conversations and call cost — per WhatsApp Business Account.
   *
   * A DIFFERENT source from `/overview`, which is computed from our own message
   * rows. These are Meta's billing-side figures, read live behind a short cache,
   * and the two must never be blended: our volume counts what we sent, Meta's
   * counts what it DELIVERED and charged for, and they legitimately differ.
   *
   * Same `teamActivity:view` gate as the overview — it is the same question
   * ("how is this workspace doing") asked of a different source, so one switch
   * governs both rather than inventing a second permission for one panel.
   */
  @RequireCapability("teamActivity:view")
  @Get("whatsapp-analytics")
  async whatsappAnalytics(
    @CurrentSession() session: ApiSession,
    @Query(zQuery(WabaAnalyticsQuerySchema)) query: WabaAnalyticsQueryInput,
  ) {
    return getWabaAnalytics(session.workspaceId, {
      from: new Date(query.from),
      to: new Date(query.to),
      granularity: query.granularity,
      wabaAccountId: query.wabaAccountId,
    });
  }
}
