import { Body, Controller, Post } from "@nestjs/common";

import { zBody } from "../common/zod-validation.pipe";
import { AcceptInviteSchema, type AcceptInviteInput } from "./invites.schemas";
import { InvitesService } from "./invites.service";

/**
 * Public invite endpoints — no SessionGuard, the invite token IS the auth.
 *
 *   POST   /api/invites/accept   — finalize a pending invite: create
 *                                  User + Better-Auth credential Account,
 *                                  stamp acceptedAt, fan out catalog events.
 *
 * The web-side server action calls this from `/invite/[token]` then runs
 * Better Auth's signInEmail() to set the session cookie. That sign-in step
 * stays in apps/web because the nextCookies plugin writes through Next.js's
 * cookies() API — there's no equivalent on the NestJS side.
 *
 * Sibling controller (not method-on-InvitesController) so the class-level
 * `@RequireRole("admin")` on the existing controller doesn't have to grow
 * a per-method override.
 */
@Controller("api/invites")
export class InvitesPublicController {
  constructor(private readonly invites: InvitesService) {}

  @Post("accept")
  async accept(@Body(zBody(AcceptInviteSchema)) body: AcceptInviteInput) {
    const out = await this.invites.accept(body);
    return { ok: true, ...out };
  }
}
