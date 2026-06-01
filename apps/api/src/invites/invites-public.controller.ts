import { Body, Controller, Get, HttpException, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";

import { createTokenBucket } from "../common/token-bucket";
import { zBody } from "../common/zod-validation.pipe";
import { AcceptInviteSchema, type AcceptInviteInput } from "./invites.schemas";
import { InvitesService } from "./invites.service";

// Per-IP buckets, tighter than the global 600/min/IP cap, because these are
// UNAUTHENTICATED token surfaces: `lookup` validates an invite token (bound
// enumeration) and `accept` creates a User + credential Account (a write). The
// generic IP middleware doesn't gate them tightly enough on its own.
const lookupBucket = createTokenBucket({ perMin: 30 });
const acceptBucket = createTokenBucket({ perMin: 10 });

function enforceIpLimit(req: Request, bucket: ReturnType<typeof createTokenBucket>): void {
  const ip = req.ip ?? "unknown";
  const r = bucket.consume(ip);
  if (!r.ok) {
    throw new HttpException(
      { error: "rate_limited", detail: "too many invite requests", retryAfter: r.retryAfter },
      429,
    );
  }
}

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
  async lookup(@Param("token") token: string, @Req() req: Request) {
    enforceIpLimit(req, lookupBucket);
    return this.invites.lookup(token);
  }

  @Post("accept")
  async accept(
    @Body(zBody(AcceptInviteSchema)) body: AcceptInviteInput,
    @Req() req: Request,
  ) {
    enforceIpLimit(req, acceptBucket);
    const out = await this.invites.accept(body);
    return { ok: true, ...out };
  }
}
