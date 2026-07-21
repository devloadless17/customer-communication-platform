import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";

import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { zBody } from "../common/zod-validation.pipe";
import { CustomersService } from "./customers.service";
import {
  LinkContactSchema,
  RenameCustomerSchema,
  UnlinkContactSchema,
  type LinkContactInput,
  type RenameCustomerInput,
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

  // Literal segment declared BEFORE `:id` so it isn't captured as an id.
  @Get("by-contact/:contactId")
  async byContact(
    @CurrentSession() session: ApiSession,
    @Param("contactId") contactId: string,
  ) {
    const customer = await this.customers.getProfileByContact(session.teamId, contactId);
    return { customer };
  }

  /**
   * Possible same-person matches for a contact, for the agent to confirm.
   * Declared before `:id` so "by-contact" isn't captured as a customer id.
   */
  @Get("by-contact/:contactId/suggestions")
  async suggestions(
    @CurrentSession() session: ApiSession,
    @Param("contactId") contactId: string,
  ) {
    const suggestions = await this.customers.suggestLinks(session.teamId, contactId);
    return { suggestions };
  }

  @Get(":id")
  async get(@CurrentSession() session: ApiSession, @Param("id") id: string) {
    const customer = await this.customers.getProfile(session.teamId, id);
    return { customer };
  }

  @Patch(":id")
  async rename(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(RenameCustomerSchema)) body: RenameCustomerInput,
  ) {
    const customer = await this.customers.rename(session.teamId, id, body.name);
    return { ok: true, customer };
  }

  @Post(":id/link")
  async link(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(LinkContactSchema)) body: LinkContactInput,
  ) {
    const customer = await this.customers.linkContact(
      session.teamId,
      id,
      body.contactId,
      session.userId,
    );
    return { ok: true, customer };
  }

  @Post(":id/unlink")
  async unlink(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(UnlinkContactSchema)) body: UnlinkContactInput,
  ) {
    const out = await this.customers.unlinkContact(
      session.teamId,
      id,
      body.contactId,
      session.userId,
    );
    return { ok: true, ...out };
  }
}
