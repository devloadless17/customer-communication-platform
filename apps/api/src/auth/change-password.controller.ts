import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";

import {
  hashPassword,
  isPasswordBreached,
  validatePasswordStructure,
  verifyPassword,
} from "@/auth/password";

import { zBody } from "../common/zod-validation.pipe";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentSession } from "./current-session.decorator";
import { SessionGuard } from "./session.guard";
import type { ApiSession } from "./session.guard";

/**
 * Self-service password change. Requires the current password to prevent a
 * leaked session cookie from rotating credentials.
 *
 *   POST /api/auth/change-password   { currentPassword, newPassword }
 *
 * `currentPassword` is NOT length-validated by zod — verifyPassword will
 * reject a wrong password anyway, and tighter validation here would leak
 * structure info about what the user's current password looks like.
 *
 * Better Auth verifies signin credentials against `Account.password`, not
 * `User.passwordHash`. If we updated only User.passwordHash, the new pwd
 * would fail signin and the OLD pwd would still work. Update both columns
 * in one transaction so they can't diverge.
 */
const BodySchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string(),
});
type Input = z.infer<typeof BodySchema>;

@Controller("api/auth/change-password")
@UseGuards(SessionGuard)
export class ChangePasswordController {
  constructor(private readonly prisma: PrismaService) {}

  @Post()
  @HttpCode(200)
  async change(
    @CurrentSession() session: ApiSession,
    @Body(zBody(BodySchema)) body: Input,
  ) {
    const { currentPassword, newPassword } = body;

    const policyError = validatePasswordStructure(newPassword);
    if (policyError) {
      throw new BadRequestException({ error: policyError });
    }

    const user = await this.prisma.user.findUnique({ where: { id: session.userId } });
    if (!user || !user.passwordHash) {
      throw new BadRequestException({ error: "no password set" });
    }

    // Verify CURRENT password first — keeps a stolen cookie from spamming
    // HIBP queries with arbitrary candidates.
    const ok = await verifyPassword(currentPassword, user.passwordHash);
    if (!ok) {
      throw new BadRequestException({ error: "current password is incorrect" });
    }

    if (await isPasswordBreached(newPassword)) {
      throw new BadRequestException({
        error: "that password has appeared in known data breaches. Please choose another.",
      });
    }

    const newHash = await hashPassword(newPassword);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: newHash },
      }),
      this.prisma.account.updateMany({
        where: { userId: user.id, providerId: "credential" },
        data: { password: newHash },
      }),
    ]);

    return { ok: true };
  }
}
