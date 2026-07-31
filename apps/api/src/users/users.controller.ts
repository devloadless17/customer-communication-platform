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
import { zBody } from "../common/zod-validation.pipe";
import {
  ResetUserPasswordSchema,
  SetUserAvailabilitySchema,
  SetUserWorkHoursSchema,
  UpdateMyAvailabilitySchema,
  UpdateMyProfileSchema,
  UpdateUserSchema,
  type ResetUserPasswordInput,
  type SetUserAvailabilityInput,
  type SetUserWorkHoursInput,
  type UpdateMyAvailabilityInput,
  type UpdateMyProfileInput,
  type UpdateUserInput,
} from "./users.schemas";
import { UserAvailabilityService } from "./user-availability.service";
import { UsersService } from "./users.service";

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
  constructor(
    private readonly users: UsersService,
    private readonly availability: UserAvailabilityService,
  ) {}

  @Get()
  async list(@CurrentSession() session: ApiSession) {
    const users = await this.users.list(session.workspaceId);
    return { users };
  }

  // Per-member activity moved to /api/reports/team (+ /team/live) — the
  // /reports/team page superseded the settings-activity table 2026-07-31.

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
    const hasAvatar = await this.users.hasAvatar(session.workspaceId, userId);
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
      session.workspaceId,
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
    const user = await this.availability.updateMyAvailability(
      session.workspaceId,
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
    if (!file) throw new BadRequestException({ error: "file_required" });
    try {
      const bytes = await readFile(file.path);
      const out = await this.users.uploadMyAvatar(session.workspaceId, session.userId, {
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
    const user = await this.availability.setUserAvailability(
      session.workspaceId,
      session.userId,
      { role: session.role, isSuperAdmin: session.isSuperAdmin, orgRole: session.orgRole },
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
    return this.availability.getUserWorkHours(session.workspaceId, id);
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
    const user = await this.availability.setUserWorkHours(
      session.workspaceId,
      { role: session.role, isSuperAdmin: session.isSuperAdmin, orgRole: session.orgRole },
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
      session.workspaceId,
      { role: session.role, isSuperAdmin: session.isSuperAdmin, orgRole: session.orgRole },
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
   * caller's own workspace; there is deliberately NO cross-tenant superAdmin
   * reset route (removed — an operator choosing a customer's credential was
   * indefensible; tests/e2e/auth-recovery.spec.ts asserts it stays gone).
   * `canModifyUser` (in the service) blocks an admin from resetting a
   * superAdmin.
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
        error: "use_change_password_for_self", detail: "Use the change-password flow to update your own account.",
      });
    }
    await this.users.resetPassword(
      session.workspaceId,
      { role: session.role, isSuperAdmin: session.isSuperAdmin, orgRole: session.orgRole },
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
    await this.users.remove(session.workspaceId, { role: session.role, isSuperAdmin: session.isSuperAdmin, orgRole: session.orgRole }, session.userId, id);
    return { ok: true };
  }
}
