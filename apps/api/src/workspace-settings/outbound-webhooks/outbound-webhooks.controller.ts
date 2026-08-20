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
import { DbService } from "../../db/db.service";
import { recordOperatorAction } from "@/lib/workspaces/operator-log";
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
 *   GET    /api/workspace/outbound-webhooks                          — list
 *   POST   /api/workspace/outbound-webhooks                          — create (returns secret ONCE)
 *   PATCH  /api/workspace/outbound-webhooks/:id                      — update url / name / events / enabled
 *   POST   /api/workspace/outbound-webhooks/:id/rotate-secret        — rotate (returns new secret ONCE)
 *   DELETE /api/workspace/outbound-webhooks/:id                      — remove + cascade deliveries
 *   GET    /api/workspace/outbound-webhooks/:id/deliveries           — recent delivery log
 *   POST   /api/workspace/outbound-webhooks/:id/test                 — fire synthetic test event
 */
@Controller("api/workspace/outbound-webhooks")
@RequireRole("admin")
export class OutboundWebhooksController {
  constructor(
    private readonly webhooks: OutboundWebhooksService,
    private readonly db: DbService,
  ) {}

  @Get()
  async list(@CurrentSession() session: ApiSession) {
    const webhooks = await this.webhooks.list(session.workspaceId);
    return { webhooks };
  }

  @Post()
  async create(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreateOutboundWebhookSchema)) body: CreateOutboundWebhookInput,
  ) {
    // OPERATOR ACTION LOG (CLAUDE.md §18): a webhook points the tenant's event
    // stream at an external URL, so an operator creating one is recorded —
    // awaited BEFORE the create, so a failed record fails the action.
    if (session.isOperator) {
      await recordOperatorAction(this.db, {
        userId: session.userId,
        workspaceId: session.workspaceId,
        action: "outbound_webhook_create",
        detail: { url: body.url },
      });
    }
    return this.webhooks.create(session.workspaceId, session.userId, body);
  }

  @Patch(":id")
  async update(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(UpdateOutboundWebhookSchema)) body: UpdateOutboundWebhookInput,
  ) {
    const webhook = await this.webhooks.update(session.workspaceId, id, body);
    return { webhook };
  }

  @Post(":id/rotate-secret")
  async rotateSecret(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    return this.webhooks.rotateSecret(session.workspaceId, id);
  }

  @Delete(":id")
  async remove(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.webhooks.remove(session.workspaceId, id);
    return { ok: true };
  }

  @Get(":id/deliveries")
  async deliveries(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Query(zQuery(ListDeliveriesQuerySchema)) query: ListDeliveriesQueryInput,
  ) {
    return this.webhooks.listDeliveries(session.workspaceId, id, query);
  }

  @Post(":id/test")
  async test(@CurrentSession() session: ApiSession, @Param("id") id: string) {
    return this.webhooks.test(session.workspaceId, id);
  }
}
