import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from "@nestjs/common";

import { acquisitionSources } from "@/lib/analytics/acquisition-sources";
import { campaignRollup, listCampaigns } from "@/lib/analytics/campaign-rollup";
import { getWorkspaceReport, ReportRangeError } from "@/lib/analytics/reports";
import { getWabaAnalytics } from "@/lib/analytics/waba-analytics";

import { RequireCapability } from "../auth/capability.guard";
import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { zQuery } from "../common/zod-validation.pipe";
import {
  AcquisitionQuerySchema,
  type AcquisitionQuery,
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
   * ACQUISITION SOURCES — where each customer came from.
   *
   * Aggregates the `attribution` every ad-sourced inbound already carries: the
   * Click-to-Messenger `ad_id`, an m.me `ref` deep link, an Instagram Shop
   * product tap, and WhatsApp's `ctwa_clid`. Counted by distinct CONTACT keyed on
   * their FIRST attributed inbound, because Meta sends `referral` only on the
   * message that starts a conversation — counting messages would answer a
   * different and useless question.
   *
   * `organic` (no attribution at all) is reported SEPARATELY rather than as a
   * row: it is the absence of a source, and folding it in would let it sort above
   * every real campaign and read as the best-performing one.
   */
  @RequireCapability("teamActivity:view")
  @Get("acquisition")
  async acquisition(
    @CurrentSession() session: ApiSession,
    @Query(zQuery(AcquisitionQuerySchema)) query: AcquisitionQuery,
  ) {
    return acquisitionSources(session.workspaceId, {
      ...(query.from ? { since: new Date(query.from) } : {}),
      ...(query.to ? { until: new Date(query.to) } : {}),
      ...(query.channel ? { channel: query.channel } : {}),
    });
  }

  /**
   * Every campaign in the workspace — the picker behind the rollup below.
   */
  @RequireCapability("teamActivity:view")
  @Get("campaigns")
  async campaigns(@CurrentSession() session: ApiSession) {
    return { campaigns: await listCampaigns(session.workspaceId) };
  }

  /**
   * CAMPAIGN ROLLUP — several broadcasts read as one set of numbers.
   *
   * Summed from recipient rows, never by adding up per-broadcast reports: those
   * carry derived RATES, and averaging rates across sends of different sizes is
   * wrong in a way nobody can see (a 100%-delivered send of 3 and a
   * 50%-delivered send of 10,000 do not average to 75%). Rates are computed once
   * from summed counts.
   */
  @RequireCapability("teamActivity:view")
  @Get("campaigns/:name")
  async campaign(@CurrentSession() session: ApiSession, @Param("name") name: string) {
    const rollup = await campaignRollup(session.workspaceId, name);
    if (!rollup) throw new NotFoundException({ error: "campaign_not_found" });
    return rollup;
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
