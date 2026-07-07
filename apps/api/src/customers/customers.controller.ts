import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";

import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { zBody } from "../common/zod-validation.pipe";
import { CustomersService } from "./customers.service";
import {
  LinkContactSchema,
  UnlinkContactSchema,
  type LinkContactInput,
  type UnlinkContactInput,
} from "./customers.schemas";

/**
 * Unified customer profile + manual merge/split (§6 / docs/identity.md).
 *
 *   GET  /api/customers/:id          — the person + their channel-contacts
 *   POST /api/customers/:id/link     — join a contact to this person
 *   POST /api/customers/:id/unlink   — split a contact off to its own person
 *
 * Any team member can link/unlink — deciding two threads are the same person is
 * a normal triage action, not an admin one.
 */
@Controller("api/customers")
@UseGuards(SessionGuard)
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get(":id")
  async get(@CurrentSession() session: ApiSession, @Param("id") id: string) {
    const customer = await this.customers.getProfile(session.teamId, id);
    return { customer };
  }

  @Post(":id/link")
  async link(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(LinkContactSchema)) body: LinkContactInput,
  ) {
    const customer = await this.customers.linkContact(session.teamId, id, body.contactId);
    return { ok: true, customer };
  }

  @Post(":id/unlink")
  async unlink(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(UnlinkContactSchema)) body: UnlinkContactInput,
  ) {
    const out = await this.customers.unlinkContact(session.teamId, id, body.contactId);
    return { ok: true, ...out };
  }
}
