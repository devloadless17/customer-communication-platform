import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpException,
  Post,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";

import {
  hashPassword,
  validatePasswordStructure,
  verifyPassword,
} from "@/auth/password";

import { zBody } from "../common/zod-validation.pipe";
import { DbService } from "../db/db.service";
import { CurrentSession } from "./current-session.decorator";
import { SessionGuard } from "./session.guard";
import type { ApiSession } from "./session.guard";

/**
 * Per-user `currentPassword` attempt counter. Bcrypt makes mass brute force
 * unattractive (~100ms/attempt), but a small counter is cheap insurance
 * against a stolen-cookie attacker probing the current password to take
 * full control. Buckets reset 15 minutes after the latest attempt;
 * exceeding `MAX_ATTEMPTS` blocks change-password for the same window.
 *
 * Process-local — fine for single-VPS pilot. Move to Redis alongside the
 * Socket.io adapter the day a second api process appears.
 */
const CP_MAX_ATTEMPTS = 5;
const CP_WINDOW_MS = 15 * 60_000;
const CP_BUCKET_MAX = 5_000;
const changePasswordAttempts = new Map<string, { count: number; firstAt: number }>();

function consumeAttempt(userId: string): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now();
  const bucket = changePasswordAttempts.get(userId);
  if (!bucket || now - bucket.firstAt > CP_WINDOW_MS) {
    // LRU-ish eviction on overflow — Map insertion order is iteration order.
    if (changePasswordAttempts.size >= CP_BUCKET_MAX) {
      const oldest = changePasswordAttempts.keys().next().value;
      if (oldest !== undefined) changePasswordAttempts.delete(oldest);
    }
    changePasswordAttempts.set(userId, { count: 1, firstAt: now });
    return { ok: true };
  }
  if (bucket.count >= CP_MAX_ATTEMPTS) {
    return {
      ok: false,
      retryAfter: Math.max(1, Math.ceil((bucket.firstAt + CP_WINDOW_MS - now) / 1000)),
    };
  }
  bucket.count += 1;
  return { ok: true };
}

function resetAttempts(userId: string): void {
  changePasswordAttempts.delete(userId);
}

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
 * Reads + writes go through Account.password — the row Better Auth's signin
 * actually verifies against. One source of truth, one write.
 */
const BodySchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string(),
});
type Input = z.infer<typeof BodySchema>;

@Controller("api/auth/change-password")
@UseGuards(SessionGuard)
export class ChangePasswordController {
  constructor(private readonly db: DbService) {}

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

    // Per-user lockout: refuse further attempts after MAX consecutive wrong
    // `currentPassword`s. Bucket reset happens on a successful change below.
    const rate = consumeAttempt(session.userId);
    if (!rate.ok) {
      throw new HttpException(
        {
          error: "too_many_attempts",
          detail: `Too many incorrect current-password attempts. Retry in ${rate.retryAfter}s.`,
        },
        429,
      );
    }

    const account = await this.db.account.findFirst({
      where: { userId: session.userId, providerId: "credential" },
      select: { id: true, password: true },
    });
    if (!account?.password) {
      throw new BadRequestException({ error: "no password set" });
    }

    const ok = await verifyPassword(currentPassword, account.password);
    if (!ok) {
      throw new BadRequestException({ error: "current password is incorrect" });
    }
    // Verified — drop the attempt bucket so a legitimate user who fumbled
    // once isn't penalized on their next intentional change.
    resetAttempts(session.userId);

    const newHash = await hashPassword(newPassword);
    await this.db.account.update({
      where: { id: account.id },
      data: { password: newHash },
    });

    return { ok: true };
  }
}
