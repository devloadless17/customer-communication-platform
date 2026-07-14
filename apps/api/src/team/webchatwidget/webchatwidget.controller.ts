import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";

import { CurrentSession } from "../../auth/current-session.decorator";
import { RequireRole } from "../../auth/role.guard";
import type { ApiSession } from "../../auth/session.guard";
import { zBody } from "../../common/zod-validation.pipe";
import {
  CreateWidgetSchema,
  UpdateWidgetSchema,
  type CreateWidgetInput,
  type UpdateWidgetInput,
} from "./webchatwidget.schemas";
import { WebchatwidgetAdminService } from "./webchatwidget.service";

/**
 * Website chat-widget management — admin-only. A team runs many named widgets.
 *
 *   GET    /api/team/webchatwidget      — list the team's widgets
 *   POST   /api/team/webchatwidget      — create one (mints a public site key)
 *   PATCH  /api/team/webchatwidget/:id  — rename / re-theme / toggle active
 *   DELETE /api/team/webchatwidget/:id  — delete (conversations keep their history)
 */
@Controller("api/team/webchatwidget")
@RequireRole("admin")
export class WebchatwidgetController {
  constructor(private readonly widgets: WebchatwidgetAdminService) {}

  @Get()
  async list(@CurrentSession() session: ApiSession) {
    return { widgets: await this.widgets.list(session.teamId) };
  }

  @Post()
  async create(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreateWidgetSchema)) body: CreateWidgetInput,
  ) {
    return { widget: await this.widgets.create(session.teamId, body) };
  }

  @Patch(":id")
  async update(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(UpdateWidgetSchema)) body: UpdateWidgetInput,
  ) {
    return { widget: await this.widgets.update(session.teamId, id, body) };
  }

  @Delete(":id")
  async remove(@CurrentSession() session: ApiSession, @Param("id") id: string) {
    await this.widgets.remove(session.teamId, id);
    return { ok: true };
  }
}
