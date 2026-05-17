import { Body, ConflictException, Controller, Post } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import { hashPassword } from "@/auth/password";

import { zBody } from "../common/zod-validation.pipe";
import { DbService } from "../db/db.service";

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
 * Mirrors the password hashing strategy used by acceptInvite (bcryptjs cost
 * 10) so Better Auth's verify path treats these credentials identically.
 */

const RegisterSchema = z.object({
  orgName: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(6).max(200),
});
type RegisterInput = z.infer<typeof RegisterSchema>;

@Controller("api/register")
export class RegisterController {
  constructor(private readonly db: DbService) {}

  @Post()
  async register(@Body(zBody(RegisterSchema)) body: RegisterInput) {
    const passwordHash = await hashPassword(body.password);

    try {
      const result = await this.db.$transaction(async (tx) => {
        const team = await tx.team.create({ data: { name: body.orgName } });
        const user = await tx.user.create({
          data: {
            teamId: team.id,
            role: "admin",
            name: body.name,
            email: body.email,
            // Kept populated alongside Account.password for legacy callers
            // (seed scripts, ad-hoc maintenance). Better Auth's verify path
            // reads from Account.password.
            passwordHash,
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
        await tx.teamChannel.create({
          data: { teamId: team.id, name: "general", isDefault: true, createdById: user.id },
        });
        return { email: body.email, teamId: team.id };
      });

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
