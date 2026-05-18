import { Body, Controller, Get, Param, Post } from "@nestjs/common";

import { zBody } from "../common/zod-validation.pipe";
import { AcceptInviteSchema, type AcceptInviteInput } from "./invites.schemas";
import { InvitesService } from "./invites.service";

/**
 * Public invite endpoints — no SessionGuard, the invite token IS the auth.
 *
 *   GET    /api/invites/lookup/:token   — read-only validation: returns the
 *                                         invite's email + role + team name
 *                                         for the landing-page render. Never
 *                                         leaks the token hash; rejects
 *                                         expired/accepted with a code so
 *                                         the page can show the right Shell.
 *   POST   /api/invites/accept          — finalize a pending invite: create
 *                                         User + Better-Auth credential Account,
 *                                         stamp acceptedAt, fan out catalog events.
 *
 * The web-side server action calls accept from `/invite/[token]/actions.ts`
 * then runs Better Auth's signInEmail() to set the session cookie. That
 * sign-in step stays in apps/web because the nextCookies plugin writes
 * through Next.js's cookies() API — there's no equivalent in NestJS.
 *
 * Sibling controller (not method-on-InvitesController) so the class-level
 * `@RequireRole("admin")` on the existing controller doesn't have to grow
 * a per-method override.
 */
@Controller("api/invites")
export class InvitesPublicController {
  constructor(private readonly invites: InvitesService) {}

  @Get("lookup/:token")
  async lookup(@Param("token") token: string) {
    return this.invites.lookup(token);
  }

  @Post("accept")
  async accept(@Body(zBody(AcceptInviteSchema)) body: AcceptInviteInput) {
    const out = await this.invites.accept(body);
    return { ok: true, ...out };
  }
}
