import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";

import { CurrentSession } from "../../auth/current-session.decorator";
import { RequireRole } from "../../auth/role.guard";
import type { ApiSession } from "../../auth/session.guard";
import { zBody, zQuery } from "../../common/zod-validation.pipe";
import { OutboundWebhooksService } from "./outbound-webhooks.service";
import {
  CreateOutboundWebhookSchema,
  ListDeliveriesQuerySchema,
  UpdateOutboundWebhookSchema,
  type CreateOutboundWebhookInput,
  type ListDeliveriesQueryInput,
  type UpdateOutboundWebhookInput,
} from "./outbound-webhooks.schemas";

/**
 * Outbound webhook admin surface. Admin-only — adding a webhook means
 * choosing where the team's data flows next, which is a security-relevant
 * decision.
 *
 *   GET    /api/team/outbound-webhooks                          — list
 *   POST   /api/team/outbound-webhooks                          — create (returns secret ONCE)
 *   PATCH  /api/team/outbound-webhooks/:id                      — update url / name / events / enabled
 *   POST   /api/team/outbound-webhooks/:id/rotate-secret        — rotate (returns new secret ONCE)
 *   DELETE /api/team/outbound-webhooks/:id                      — remove + cascade deliveries
 *   GET    /api/team/outbound-webhooks/:id/deliveries           — recent delivery log
 *   POST   /api/team/outbound-webhooks/:id/test                 — fire synthetic test event
 */
@Controller("api/team/outbound-webhooks")
@RequireRole("admin")
export class OutboundWebhooksController {
  constructor(private readonly webhooks: OutboundWebhooksService) {}

  @Get()
  async list(@CurrentSession() session: ApiSession) {
    const webhooks = await this.webhooks.list(session.teamId);
    return { webhooks };
  }

  @Post()
  async create(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreateOutboundWebhookSchema)) body: CreateOutboundWebhookInput,
  ) {
    return this.webhooks.create(session.teamId, session.userId, body);
  }

  @Patch(":id")
  async update(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(UpdateOutboundWebhookSchema)) body: UpdateOutboundWebhookInput,
  ) {
    const webhook = await this.webhooks.update(session.teamId, id, body);
    return { webhook };
  }

  @Post(":id/rotate-secret")
  async rotateSecret(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    return this.webhooks.rotateSecret(session.teamId, id);
  }

  @Delete(":id")
  async remove(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.webhooks.remove(session.teamId, id);
    return { ok: true };
  }

  @Get(":id/deliveries")
  async deliveries(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Query(zQuery(ListDeliveriesQuerySchema)) query: ListDeliveriesQueryInput,
  ) {
    return this.webhooks.listDeliveries(session.teamId, id, query);
  }

  @Post(":id/test")
  async test(@CurrentSession() session: ApiSession, @Param("id") id: string) {
    return this.webhooks.test(session.teamId, id);
  }
}
