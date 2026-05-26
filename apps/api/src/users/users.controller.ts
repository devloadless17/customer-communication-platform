import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";

import { RequireCapability } from "../auth/capability.guard";
import { CurrentSession } from "../auth/current-session.decorator";
import { RequireRole } from "../auth/role.guard";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { zBody } from "../common/zod-validation.pipe";
import {
  UpdateMyAvailabilitySchema,
  UpdateMyProfileSchema,
  UpdateUserSchema,
  type UpdateMyAvailabilityInput,
  type UpdateMyProfileInput,
  type UpdateUserInput,
} from "./users.schemas";
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
  constructor(private readonly users: UsersService) {}

  @Get()
  async list(@CurrentSession() session: ApiSession) {
    const users = await this.users.list(session.teamId);
    return { users };
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
