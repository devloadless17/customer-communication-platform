import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";

import { RequireCapability } from "../../auth/capability.guard";
import { CurrentSession } from "../../auth/current-session.decorator";
import { SessionGuard } from "../../auth/session.guard";
import type { ApiSession } from "../../auth/session.guard";
import { zBody } from "../../common/zod-validation.pipe";
import {
  CreateAudienceGroupSchema,
  UpdateAudienceGroupSchema,
  type CreateAudienceGroupInput,
  type UpdateAudienceGroupInput,
} from "./audience-groups.schemas";
import { AudienceGroupsService } from "./audience-groups.service";

@Controller("api/team/audience-groups")
@UseGuards(SessionGuard)
export class AudienceGroupsController {
  constructor(private readonly groups: AudienceGroupsService) {}

  @Get()
  async list(@CurrentSession() session: ApiSession) {
    const groups = await this.groups.list(session.workspaceId);
    return { groups };
  }

  @Get(":id")
  async get(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    const group = await this.groups.get(session.workspaceId, id);
    return { group };
  }

  @Post()
  @RequireCapability("audienceGroups:manage")
  async create(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreateAudienceGroupSchema)) body: CreateAudienceGroupInput,
  ) {
    const group = await this.groups.create(session.workspaceId, session.userId, body);
    return { group };
  }

  @Patch(":id")
  @RequireCapability("audienceGroups:manage")
  async update(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(UpdateAudienceGroupSchema)) body: UpdateAudienceGroupInput,
  ) {
    const group = await this.groups.update(session.workspaceId, id, body);
    return { group };
  }

  @Delete(":id")
  @RequireCapability("audienceGroups:manage")
  async remove(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.groups.remove(session.workspaceId, id);
    return { ok: true };
  }
}
