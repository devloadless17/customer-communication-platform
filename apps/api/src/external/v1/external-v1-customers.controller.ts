import { Body, Controller, Get, Headers, Param, Patch, Post, UseGuards } from "@nestjs/common";

import { RateLimit } from "@/common/rate-limit.interceptor";

import { ApiKeyGuard } from "../../auth/api-key.guard";
import type { ApiKeyContext } from "../../auth/api-key.guard";
import { CurrentApiKey } from "../../auth/current-session.decorator";
import { RequireScope } from "../../auth/scope.decorator";
import { ScopeGuard } from "../../auth/scope.guard";
import { zBody } from "../../common/zod-validation.pipe";
import { guardChainDepth } from "./v1-request-guards";
import { CustomersService } from "@/customers/customers.service";
import {
  LinkContactSchema,
  RenameCustomerSchema,
  UnlinkContactSchema,
  type LinkContactInput,
  type RenameCustomerInput,
  type UnlinkContactInput,
} from "@/customers/customers.schemas";

/**
 * /v1 CUSTOMERS (unified identity) — peeled from the 197-route ExternalV1Controller
 * (2026-07-31 split). Same base path + guard stack; check:v1-docs discovers
 * every *.controller.ts here, so the peel cannot drop a route from coverage.
 */
@Controller("api/external/v1")
@UseGuards(ApiKeyGuard, ScopeGuard)
@RateLimit({ perMinute: 600 })
export class ExternalV1CustomersController {
  constructor(
    private readonly customers: CustomersService,
  ) {}

  // CUSTOMERS (unified identity)
  // ===========================================================================
  //
  // Parity build, phase 2. The platform ships unified customer identity — many
  // channel-scoped Contacts roll up to one Customer (a person) — but an
  // API-only integration could not SEE that two contacts were the same human,
  // let alone merge or split them. That is the largest single gap in /v1.
  //
  // Threads stay per-contact/per-channel; a Customer is the profile-and-
  // switcher layer over them. Merges here are the MANUAL, reversible kind:
  // automatic merging happens only on deterministic strong keys at ingest and
  // is deliberately not exposed.

  /** The person behind a contact, with every channel identity they own. */
  @Get("contacts/:id/customer")
  @RequireScope("read:contacts")
  async getCustomerByContactV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    const customer = await this.customers.getProfileByContact(auth.workspaceId, id);
    return { customer };
  }

  /**
   * Possible same-person matches for a contact — the candidates an agent is
   * shown before confirming a merge. Suggestions ONLY; nothing is merged until
   * you call link. Never fuzzy-name matching.
   */
  @Get("contacts/:id/merge-suggestions")
  @RequireScope("read:contacts")
  async getMergeSuggestionsV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    const suggestions = await this.customers.suggestLinks(auth.workspaceId, id);
    return { suggestions };
  }

  @Get("customers/:id")
  @RequireScope("read:contacts")
  async getCustomerV1(@CurrentApiKey() auth: ApiKeyContext, @Param("id") id: string) {
    const customer = await this.customers.getProfile(auth.workspaceId, id);
    return { customer };
  }

  @Patch("customers/:id")
  @RequireScope("write:contacts")
  async renameCustomerV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(RenameCustomerSchema)) body: RenameCustomerInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    const customer = await this.customers.rename(auth.workspaceId, id, body.name);
    return { ok: true, customer };
  }

  /**
   * MERGE: point a contact at this customer. Reversible — merging never
   * deletes a contact or its messages, it only re-points `Contact.customerId`,
   * so `unlink` puts it back on its own customer. `actorUserId` is null: an
   * integration is not a person.
   */
  @Post("customers/:id/link")
  @RequireScope("write:contacts")
  async linkCustomerContactV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(LinkContactSchema)) body: LinkContactInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    const customer = await this.customers.linkContact(
      auth.workspaceId,
      id,
      body.contactId,
      null,
    );
    return { ok: true, customer };
  }

  /** SPLIT: take a contact back off this customer onto its own. */
  @Post("customers/:id/unlink")
  @RequireScope("write:contacts")
  async unlinkCustomerContactV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(UnlinkContactSchema)) body: UnlinkContactInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    const out = await this.customers.unlinkContact(
      auth.workspaceId,
      id,
      body.contactId,
      null,
    );
    return { ok: true, ...out };
  }

  // ===========================================================================
}
