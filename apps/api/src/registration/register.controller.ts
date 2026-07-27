import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpException,
  Post,
  Req,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Request } from "express";
import { z } from "zod";

import { checkEmailPolicy } from "@ccp/shared/auth/email-policy";

import { hashPassword } from "@/auth/password";
import { invalidateSuperAdminAggregates } from "@/lib/queries";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  validatePasswordStructure,
} from "@ccp/shared/auth/password-policy";

import { createTokenBucket } from "../common/token-bucket";
import { zBody } from "../common/zod-validation.pipe";
import { DbService } from "../db/db.service";
import { provisionOrganization } from "./provision-organization";

// Per-IP register bucket. Tighter than the global 600/min/IP cap because
// register is unauthenticated AND creates an entire Team+User+Account+...
// chain — a single IP at the global cap could fabricate 36k teams/hour.
// 5/min/IP fits "legitimate human signs up via the form" comfortably while
// bounding adversarial fan-out. In-process — moves to Redis when a second
// app instance ships.
const registerBucket = createTokenBucket({ perMin: 5 });

/**
 * Public org self-signup — replaces the inline `db.$transaction` from
 * apps/web/src/app/register/actions.ts so the Team + admin User + credential
 * Account + initial stage seed all happen on the NestJS side, where the bus
 * lives in-process. The web-side action just calls this endpoint and then
 * runs Better Auth's signInEmail() to set the session cookie.
 *
 * No SessionGuard — the visitor doesn't have a session yet by definition.
 * Password policy is enforced via zod's min(); we don't gate on HIBP breach
 * status — admins choose their own password.
 *
 * Mirrors the password hashing strategy used by acceptInvite (bcrypt cost
 * 10) so Better Auth's verify path treats these credentials identically.
 */

const RegisterSchema = z.object({
  orgName: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
});
type RegisterInput = z.infer<typeof RegisterSchema>;


@Controller("api/register")
export class RegisterController {
  constructor(private readonly db: DbService) {}

  @Post()
  async register(@Req() req: Request, @Body(zBody(RegisterSchema)) body: RegisterInput) {
    // Per-IP throttle BEFORE any DB work. See `registerBucket` above for
    // rationale; main.ts sets `trust proxy: TRUSTED_PROXY_HOPS` so `req.ip`
    // is the real client behind Caddy.
    const ip = req.ip ?? "unknown";
    const r = registerBucket.consume(ip);
    if (!r.ok) {
      throw new HttpException(
        { error: "rate_limited", detail: "Too many registrations from this IP.", retryAfter: r.retryAfter },
        429,
      );
    }

    // Server-side EMAIL policy, for the same reason as the password check
    // below: the web action runs it, a direct POST to /api/register did not,
    // so the disposable-domain list was advisory for anyone using curl.
    const emailProblem = checkEmailPolicy(body.email);
    if (emailProblem) {
      throw new BadRequestException({
        error: "email_not_allowed",
        detail:
          emailProblem === "disposable"
            ? "That looks like a temporary email address. Use a permanent one so you don't lose access to your account."
            : "That email address doesn't look valid.",
      });
    }

    // Server-side password policy. The web form runs the same check, but a
    // direct POST to /api/register bypasses it. Without this gate any string
    // ≥ 6 chars creates an admin account (this endpoint always grants
    // `admin` role on a new team — see hard-coded role below).
    const policyError = validatePasswordStructure(body.password);
    if (policyError) {
      throw new BadRequestException({ error: "weak_password", detail: policyError });
    }
    const passwordHash = await hashPassword(body.password);

    try {
      const result = await this.db.$transaction(async (tx) => {
        // One shared implementation with the Google path — see
        // provision-organization.ts for why this is extracted rather than
        // inlined twice.
        //
        // `emailVerified: false` is the change that makes signup real: the
        // account exists but cannot act until the OTP is confirmed. The web
        // action sends the code immediately after this returns.
        const { userId, workspaceId } = await provisionOrganization(tx, {
          orgName: body.orgName,
          name: body.name,
          email: body.email,
          emailVerified: false,
        });
        await tx.account.create({
          data: {
            userId,
            providerId: "credential",
            accountId: body.email,
            password: passwordHash,
          },
        });
        return { email: body.email, workspaceId };
      });

      // The super-admin roster + overview are memoized for 60s. A brand-new
      // org lands in the APPROVAL QUEUE, which is the one list an admin sits
      // and watches — it must not take a minute to appear.
      invalidateSuperAdminAggregates();

      return { ok: true, ...result };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new ConflictException({
          error: "email_taken",
          detail: "An account with this email already exists.",
        });
      }
      throw err;
    }
  }
}
