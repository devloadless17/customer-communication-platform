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
  CreateFieldOptionSchema,
  DeleteFieldOptionSchema,
  ReorderContactFieldsSchema,
  ReorderFieldOptionsSchema,
  UpdateContactFieldSchema,
  UpdateFieldOptionSchema,
  type ContactPanelBuiltins,
  type CreateContactFieldInput,
  type CreateFieldOptionInput,
  type DeleteFieldOptionInput,
  type ReorderContactFieldsInput,
  type ReorderFieldOptionsInput,
  type UpdateContactFieldInput,
  type UpdateFieldOptionInput,
} from "./contact-fields.schemas";
import { ContactFieldsService } from "./contact-fields.service";

/**
 * Contact custom field definitions (+ the option catalogs of select fields).
 *
 *   GET    /api/workspace/contact-fields          — anyone signed in (panel reads schema)
 *   GET    /api/workspace/contact-fields/:id/option-counts — anyone signed in
 *   POST   /api/workspace/contact-fields          — admin / manager only
 *   PATCH  /api/workspace/contact-fields/reorder  — admin / manager only
 *   PATCH  /api/workspace/contact-fields/:id      — admin / manager only
 *   DELETE /api/workspace/contact-fields/:id      — admin / manager only
 *   POST   /api/workspace/contact-fields/:id/options              — admin / manager only
 *   PATCH  /api/workspace/contact-fields/:id/options/reorder      — admin / manager only
 *   PATCH  /api/workspace/contact-fields/:id/options/:optionId    — admin / manager only
 *   DELETE /api/workspace/contact-fields/:id/options/:optionId    — admin / manager only
 *
 * Write gate is the admin-configurable `contactFields:manage` capability,
 * resolved here and passed into the service as a boolean. Key is derived from
 * label and IMMUTABLE — renaming would orphan every contact's
 * customFields[key] data. Field `type` is likewise immutable after create.
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

  // ---------------------------------------------------------------------
  // Select-field options. All nested under the owning field id so the
  // service can verify field ownership + type on every call.
  // ---------------------------------------------------------------------

  /** Per-option usage counts — settings badges + the delete dialog. */
  @Get(":id/option-counts")
  async optionCounts(
    @CurrentSession() session: ApiSession,
    @Param("id") fieldId: string,
  ) {
    return this.fields.optionCounts(session.workspaceId, fieldId);
  }

  @Post(":id/options")
  @HttpCode(201)
  async createOption(
    @CurrentSession() session: ApiSession,
    @Param("id") fieldId: string,
    @Body(zBody(CreateFieldOptionSchema)) body: CreateFieldOptionInput,
  ) {
    const option = await this.fields.createOption(
      session.workspaceId,
      this.canManage(session),
      fieldId,
      body,
    );
    return { option };
  }

  // Reorder must come BEFORE :optionId PATCH so /reorder isn't matched as an id.
  @Patch(":id/options/reorder")
  async reorderOptions(
    @CurrentSession() session: ApiSession,
    @Param("id") fieldId: string,
    @Body(zBody(ReorderFieldOptionsSchema)) body: ReorderFieldOptionsInput,
  ) {
    await this.fields.reorderOptions(
      session.workspaceId,
      this.canManage(session),
      fieldId,
      body,
    );
    return { ok: true };
  }

  @Patch(":id/options/:optionId")
  async updateOption(
    @CurrentSession() session: ApiSession,
    @Param("id") fieldId: string,
    @Param("optionId") optionId: string,
    @Body(zBody(UpdateFieldOptionSchema)) body: UpdateFieldOptionInput,
  ) {
    const option = await this.fields.updateOption(
      session.workspaceId,
      this.canManage(session),
      fieldId,
      optionId,
      body,
    );
    return { option };
  }

  @Delete(":id/options/:optionId")
  async removeOption(
    @CurrentSession() session: ApiSession,
    @Param("id") fieldId: string,
    @Param("optionId") optionId: string,
    @Body(zBody(DeleteFieldOptionSchema)) body: DeleteFieldOptionInput,
  ) {
    await this.fields.removeOption(
      session.workspaceId,
      this.canManage(session),
      fieldId,
      optionId,
      body,
    );
    return { ok: true };
  }
}
