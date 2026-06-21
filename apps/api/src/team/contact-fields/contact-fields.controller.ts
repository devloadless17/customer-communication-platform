import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";

import { resolvePermissions } from "@ccp/shared/auth/permissions";

import { CurrentSession } from "../../auth/current-session.decorator";
import { SessionGuard } from "../../auth/session.guard";
import type { ApiSession } from "../../auth/session.guard";
import { zBody } from "../../common/zod-validation.pipe";
import {
  ContactPanelBuiltinSchema,
  CreateContactFieldSchema,
  ReorderContactFieldsSchema,
  UpdateContactFieldSchema,
  type ContactPanelBuiltins,
  type CreateContactFieldInput,
  type ReorderContactFieldsInput,
  type UpdateContactFieldInput,
} from "./contact-fields.schemas";
import { ContactFieldsService } from "./contact-fields.service";

/**
 * Contact custom field definitions.
 *
 *   GET    /api/team/contact-fields          — anyone signed in (panel reads schema)
 *   POST   /api/team/contact-fields          — admin / manager only
 *   PATCH  /api/team/contact-fields/reorder  — admin / manager only
 *   PATCH  /api/team/contact-fields/:id      — admin / manager only
 *   DELETE /api/team/contact-fields/:id      — admin / manager only
 *
 * Write gate is the admin-configurable `contactFields:manage` capability,
 * resolved here and passed into the service as a boolean. Key is derived from
 * label and IMMUTABLE — renaming would orphan every contact's
 * customFields[key] data.
 */
@Controller("api/team/contact-fields")
@UseGuards(SessionGuard)
export class ContactFieldsController {
  constructor(private readonly fields: ContactFieldsService) {}

  private canManage(session: ApiSession): boolean {
    return resolvePermissions(session.role, session.rolePermissions)[
      "contactFields:manage"
    ];
  }

  @Get()
  async list(@CurrentSession() session: ApiSession) {
    const [definitions, builtins] = await Promise.all([
      this.fields.list(session.teamId),
      this.fields.getBuiltins(session.teamId),
    ]);
    return { definitions, builtins };
  }

  @Patch("builtins")
  async updateBuiltins(
    @CurrentSession() session: ApiSession,
    @Body(zBody(ContactPanelBuiltinSchema)) body: ContactPanelBuiltins,
  ) {
    const builtins = await this.fields.updateBuiltins(session.teamId, this.canManage(session), body);
    return { builtins };
  }

  @Post()
  @HttpCode(201)
  async create(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreateContactFieldSchema)) body: CreateContactFieldInput,
  ) {
    const definition = await this.fields.create(session.teamId, this.canManage(session), body);
    return { definition };
  }

  // Reorder must come BEFORE the :id PATCH so /reorder isn't matched as an id.
  @Patch("reorder")
  async reorder(
    @CurrentSession() session: ApiSession,
    @Body(zBody(ReorderContactFieldsSchema)) body: ReorderContactFieldsInput,
  ) {
    await this.fields.reorder(session.teamId, this.canManage(session), body);
    return { ok: true };
  }

  @Patch(":id")
  async update(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(UpdateContactFieldSchema)) body: UpdateContactFieldInput,
  ) {
    const definition = await this.fields.update(session.teamId, this.canManage(session), id, body);
    return { definition };
  }

  @Delete(":id")
  async remove(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.fields.remove(session.teamId, this.canManage(session), id);
    return { ok: true };
  }
}
