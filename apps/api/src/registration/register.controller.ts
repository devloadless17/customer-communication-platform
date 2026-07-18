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
        // `status: pending` (explicit, though it's the column default too) — the
        // org is created but locked out of the app until a superAdmin approves
        // it. The web action redirects the new admin to /pending afterward.
        const team = await tx.team.create({
          data: { name: body.orgName, status: "pending" },
        });
        const user = await tx.user.create({
          data: {
            teamId: team.id,
            role: "admin",
            name: body.name,
            email: body.email,
          },
        });
        await tx.account.create({
          data: {
            userId: user.id,
            providerId: "credential",
            accountId: body.email,
            password: passwordHash,
          },
        });
        // Seed the pipeline with three lifecycle stages so the inbox sidebar
        // shows a real pipeline from the first login. Admin can rename /
        // recolor / add more in /settings/stages.
        await tx.contactStage.createMany({
          data: [
            { teamId: team.id, name: "Stage 1", color: "lime", position: 0, isDefault: true },
            { teamId: team.id, name: "Stage 2", color: "amber", position: 1, isDefault: false },
            { teamId: team.id, name: "Stage 3", color: "emerald", position: 2, isDefault: false },
          ],
        });
        // Default #general channel. The schema documents this as auto-created
        // at team setup; /team redirects to it on first login. Without this
        // row the team-chat surface lands on the "No channels yet" dead-end.
        // Auto-membership for the founder so they can see + post immediately;
        // every future invite-accepted user is also auto-added to the default
        // channel via apps/api/src/team/invites/.
        const channel = await tx.teamChannel.create({
          data: { teamId: team.id, name: "general", isDefault: true, createdById: user.id },
        });
        await tx.teamChannelMember.create({
          data: { channelId: channel.id, userId: user.id, addedById: user.id },
        });
        return { email: body.email, teamId: team.id };
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
