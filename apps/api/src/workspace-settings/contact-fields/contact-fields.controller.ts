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
 *   GET    /api/workspace/contact-fields          — anyone signed in (panel reads schema)
 *   POST   /api/workspace/contact-fields          — admin / manager only
 *   PATCH  /api/workspace/contact-fields/reorder  — admin / manager only
 *   PATCH  /api/workspace/contact-fields/:id      — admin / manager only
 *   DELETE /api/workspace/contact-fields/:id      — admin / manager only
 *
 * Write gate is the admin-configurable `contactFields:manage` capability,
 * resolved here and passed into the service as a boolean. Key is derived from
 * label and IMMUTABLE — renaming would orphan every contact's
 * customFields[key] data.
 */
@Controller("api/workspace/contact-fields")
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
      this.fields.list(session.workspaceId),
      this.fields.getBuiltins(session.workspaceId),
    ]);
    return { definitions, builtins };
  }

  @Patch("builtins")
  async updateBuiltins(
    @CurrentSession() session: ApiSession,
    @Body(zBody(ContactPanelBuiltinSchema)) body: ContactPanelBuiltins,
  ) {
    const builtins = await this.fields.updateBuiltins(session.workspaceId, this.canManage(session), body);
    return { builtins };
  }

  @Post()
  @HttpCode(201)
  async create(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreateContactFieldSchema)) body: CreateContactFieldInput,
  ) {
    const definition = await this.fields.create(session.workspaceId, this.canManage(session), body);
    return { definition };
  }

  // Reorder must come BEFORE the :id PATCH so /reorder isn't matched as an id.
  @Patch("reorder")
  async reorder(
    @CurrentSession() session: ApiSession,
    @Body(zBody(ReorderContactFieldsSchema)) body: ReorderContactFieldsInput,
  ) {
    await this.fields.reorder(session.workspaceId, this.canManage(session), body);
    return { ok: true };
  }

  @Patch(":id")
  async update(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(UpdateContactFieldSchema)) body: UpdateContactFieldInput,
  ) {
    const definition = await this.fields.update(session.workspaceId, this.canManage(session), id, body);
    return { definition };
  }

  @Delete(":id")
  async remove(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.fields.remove(session.workspaceId, this.canManage(session), id);
    return { ok: true };
  }
}
