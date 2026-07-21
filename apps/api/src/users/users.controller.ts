import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { diskStorage } from "multer";

import { avatarObjectKey } from "../lib/blob-storage/avatar";
import { streamBlob } from "../media/stream-blob";

import { RequireCapability } from "../auth/capability.guard";
import { CurrentSession } from "../auth/current-session.decorator";
import { RequireRole } from "../auth/role.guard";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { zBody, zQuery } from "../common/zod-validation.pipe";
import {
  ResetUserPasswordSchema,
  SetUserAvailabilitySchema,
  SetUserWorkHoursSchema,
  StatsQuerySchema,
  UpdateMyAvailabilitySchema,
  UpdateMyProfileSchema,
  UpdateUserSchema,
  type ResetUserPasswordInput,
  type SetUserAvailabilityInput,
  type SetUserWorkHoursInput,
  type StatsQuery,
  type UpdateMyAvailabilityInput,
  type UpdateMyProfileInput,
  type UpdateUserInput,
} from "./users.schemas";
import { UsersService } from "./users.service";

/**
 * Rolling-window start for the stats period, or null for all-time.
 */
function periodSince(period: StatsQuery["period"]): Date | null {
  if (period === "all") return null;
  const days =
    period === "day" ? 1 : period === "week" ? 7 : period === "month" ? 30 : 365;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/**
 * Team member roster + management.
 *
 *   GET    /api/users        — list teammates (any session — the assignment
 *                              dropdown + sidebar need this for every agent)
 *   PATCH  /api/users/:id    — change role, activate/deactivate (admin)
 *   DELETE /api/users/:id    — hard-delete (admin)
 *
 * Auth split: SessionGuard at class level (any logged-in user can list),
 * RequireRole on mutating methods. Authorization details in UsersService.
 */
@Controller("api/users")
@UseGuards(SessionGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  async list(@CurrentSession() session: ApiSession) {
    const users = await this.users.list(session.teamId);
    return { users };
  }

  /**
   * Per-member activity (active assignments + windowed assigned / messages-sent
   * / closed) for the team-activity settings page. Gated by the
   * admin-configurable `teamActivity:view` capability (default: admin + manager;
   * agents off unless granted). `?period` windows the counts; `all` = all-time.
   * No GET `:id` route exists, so the static `stats` segment can't be shadowed.
   */
  @RequireCapability("teamActivity:view")
  @Get("stats")
  async stats(
    @CurrentSession() session: ApiSession,
    @Query(zQuery(StatsQuerySchema)) query: StatsQuery,
  ) {
    const stats = await this.users.getMemberStats(
      session.teamId,
      periodSince(query.period),
    );
    return { stats, period: query.period };
  }

  /**
   * Live "current activity" — open chats assigned per user, right now. Cheap
   * single query; the team-activity page re-polls it on assignment/status
   * socket events. Same capability gate as the full report.
   */
  @RequireCapability("teamActivity:view")
  @Get("active-assignments")
  async activeAssignments(@CurrentSession() session: ApiSession) {
    const counts = await this.users.getActiveAssignments(session.teamId);
    return { counts };
  }

  /**
   * Avatar serving — authenticated SAME-ORIGIN stream of the private avatar
   * object. The UI renders `<img src="/api/users/:id/avatar?v=…">` (the value
   * stored in `avatarUrl`) and lands here. Same-team check first; 404 when the
   * target user has no avatar. The `?v` cache-buster changes on replace, so the
   * bytes are safely cached hard. Two-segment path can't shadow `stats` /
   * the `:id` routes.
   */
  @Get(":userId/avatar")
  async avatar(
    @CurrentSession() session: ApiSession,
    @Param("userId") userId: string,
    @Res() res: Response,
  ): Promise<void> {
    const hasAvatar = await this.users.hasAvatar(session.teamId, userId);
    if (!hasAvatar) throw new NotFoundException({ error: "not_found" });
    await streamBlob(res, avatarObjectKey(userId), undefined);
  }

  // `me` is a static segment — must appear before `:id` routes so Express
  // doesn't try to match "me" as a user id (which would route through the
  // admin-only PATCH guard and 403 the caller's own profile edit).
  @Patch("me")
  async updateSelf(
    @CurrentSession() session: ApiSession,
    @Body(zBody(UpdateMyProfileSchema)) body: UpdateMyProfileInput,
  ) {
    const user = await this.users.updateMyProfile(
      session.teamId,
      session.userId,
      body,
    );
    return { user };
  }

  /**
   * Self-availability — "busy / away / appear offline" toggle + optional note.
   * Gated by `availability:manage` so an admin can lock it down for teams that
   * don't want agents self-marking away mid-shift (default on for every role).
   * The route is dedicated, not folded into PATCH /me, because the capability
   * check is its own concern (a user might be allowed to edit their name but
   * not their availability, or vice versa).
   */
  @RequireCapability("availability:manage")
  @Patch("me/availability")
  async updateAvailability(
    @CurrentSession() session: ApiSession,
    @Body(zBody(UpdateMyAvailabilitySchema)) body: UpdateMyAvailabilityInput,
  ) {
    const user = await this.users.updateMyAvailability(
      session.teamId,
      session.userId,
      body,
    );
    return { user };
  }

  /**
   * Avatar upload — multipart `file`. 2 MiB ceiling matches the per-image
   * cap in [avatar.ts](apps/api/src/lib/blob-storage/avatar.ts) so multer
   * refuses huge bodies before the service even runs. `diskStorage` mirrors
   * the team-chat media route's pattern (don't pin avatar bytes in V8 heap
   * on the 4 GB pilot VPS).
   */
  @Post("me/avatar")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 2 * 1024 * 1024 },
      storage: diskStorage({
        destination: tmpdir(),
        filename: (_req, file, cb) =>
          cb(null, `ccp-avatar-${randomUUID()}-${(file.originalname || "img").slice(-32)}`),
      }),
    }),
  )
  async uploadAvatar(
    @CurrentSession() session: ApiSession,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) throw new BadRequestException({ error: "file required" });
    try {
      const bytes = await readFile(file.path);
      const out = await this.users.uploadMyAvatar(session.teamId, session.userId, {
        bytes: new Uint8Array(bytes),
        mimeType: file.mimetype || "application/octet-stream",
        originalFilename: file.originalname ?? null,
      });
      return { ok: true, ...out };
    } finally {
      await unlink(file.path).catch(() => undefined);
    }
  }

  /**
   * Set a TEAMMATE's availability — the lever an admin never had. Two shapes:
   * a status/note ("he went home without flipping off"), or
   * `{ followSchedule: true }` to hand them back to their working hours.
   *
   * Separate route from `PATCH :id` (role/deactivate) because the gate is a
   * capability, not a role: a manager running the floor should be able to fix a
   * teammate's status without being able to change their role. `canModifyUser`
   * in the service still stops a manager from overriding an admin.
   */
  @RequireCapability("availability:manageOthers")
  @Patch(":id/availability")
  async setAvailability(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(SetUserAvailabilitySchema)) body: SetUserAvailabilityInput,
  ) {
    const user = await this.users.setUserAvailability(
      session.teamId,
      session.userId,
      session.role,
      id,
      body,
    );
    return { user };
  }

  /**
   * A teammate's own schedule config, for the edit dialog. Deliberately NOT on
   * the roster payload: the JSON grid would ride along on every hot inbox query
   * that includes `assignedUser`, for a value only this dialog reads.
   */
  @RequireCapability("availability:manageOthers")
  @Get(":id/work-hours")
  async getWorkHours(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    return this.users.getUserWorkHours(session.teamId, id);
  }

  /**
   * Set a teammate's working hours: inherit the org schedule, run a custom one,
   * or opt out entirely. Re-resolves their availability immediately so the
   * change lands now rather than at the next sweeper tick.
   */
  @RequireCapability("availability:manageOthers")
  @Put(":id/work-hours")
  async setWorkHours(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(SetUserWorkHoursSchema)) body: SetUserWorkHoursInput,
  ) {
    const user = await this.users.setUserWorkHours(
      session.teamId,
      session.role,
      id,
      body,
    );
    return { user };
  }

  @RequireRole("admin")
  @Patch(":id")
  async update(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(UpdateUserSchema)) body: UpdateUserInput,
  ) {
    const user = await this.users.update(
      session.teamId,
      session.role,
      session.userId,
      id,
      body,
    );
    return { user };
  }

  /**
   * Admin-initiated password reset for a teammate. The only recovery path —
   * there's no self-serve email reset (no mail provider). Admin/superAdmin
   * sets a new password, then hands it to the user out-of-band. Scoped to the
   * caller's own team; cross-team reset is the superAdmin route on
   * AdminTeamsController. `canModifyUser` (in the service) blocks an admin
   * from resetting a superAdmin.
   */
  @RequireRole("admin")
  @Post(":id/reset-password")
  @HttpCode(200)
  async resetPassword(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(ResetUserPasswordSchema)) body: ResetUserPasswordInput,
  ) {
    // Admin reset is for OTHER members. Resetting your own credentials here
    // would delete your own sessions mid-request (sign you out) — route the
    // self case to change-password, which verifies the current password.
    if (id === session.userId) {
      throw new BadRequestException({
        error: "Use change password to update your own account",
      });
    }
    await this.users.resetPassword(
      session.teamId,
      session.role,
      id,
      body.newPassword,
    );
    return { ok: true };
  }

  @RequireRole("admin")
  @Delete(":id")
  async remove(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.users.remove(session.teamId, session.role, session.userId, id);
    return { ok: true };
  }
}
