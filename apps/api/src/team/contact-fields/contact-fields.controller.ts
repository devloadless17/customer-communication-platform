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

import { CurrentSession } from "../../auth/current-session.decorator";
import { SessionGuard } from "../../auth/session.guard";
import type { ApiSession } from "../../auth/session.guard";
import { zBody } from "../../common/zod-validation.pipe";
import {
  CreateContactFieldSchema,
  UpdateContactFieldSchema,
  type CreateContactFieldInput,
  type UpdateContactFieldInput,
} from "./contact-fields.schemas";
import { ContactFieldsService } from "./contact-fields.service";

/**
 * Contact custom field definitions.
 *
 *   GET    /api/team/contact-fields          — anyone signed in (panel reads schema)
 *   POST   /api/team/contact-fields          — admin / manager only
 *   PATCH  /api/team/contact-fields/:id      — admin / manager only
 *   DELETE /api/team/contact-fields/:id      — admin / manager only
 *
 * Write gate enforced in ContactFieldsService via canManageContactFields().
 * Key is derived from label and IMMUTABLE — renaming would orphan every
 * contact's customFields[key] data.
 */
@Controller("api/team/contact-fields")
@UseGuards(SessionGuard)
export class ContactFieldsController {
  constructor(private readonly fields: ContactFieldsService) {}

  @Get()
  async list(@CurrentSession() session: ApiSession) {
    const definitions = await this.fields.list(session.teamId);
    return { definitions };
  }

  @Post()
  @HttpCode(201)
  async create(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreateContactFieldSchema)) body: CreateContactFieldInput,
  ) {
    const definition = await this.fields.create(session.teamId, session.role, body);
    return { definition };
  }

  @Patch(":id")
  async update(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(UpdateContactFieldSchema)) body: UpdateContactFieldInput,
  ) {
    const definition = await this.fields.update(session.teamId, session.role, id, body);
    return { definition };
  }

  @Delete(":id")
  async remove(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.fields.remove(session.teamId, session.role, id);
    return { ok: true };
  }
}
