import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { zBody } from "../common/zod-validation.pipe";
import { SessionInvalidationService } from "./session-invalidation.service";

/**
 * POST /api/internal/session-invalidated
 *
 * Cross-process invalidation. The Next.js /logout handler calls this after
 * clearing cookies so NestJS drops the user's sockets + cache immediately
 * instead of waiting for the 15s cache TTL. Auth: shared `INTERNAL_BUS_SECRET`
 * header, timing-safe compared. Only callable over the docker-internal /
 * loopback network — Caddy doesn't route external traffic here.
 */

const BodySchema = z.object({
  userId: z.string().min(1),
  reason: z
    .enum(["signout", "deactivation", "password-change", "role-change", "team-deletion"])
    .default("signout"),
});
type Input = z.infer<typeof BodySchema>;

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

@Controller("api/internal/session-invalidated")
export class InternalSessionController {
  constructor(private readonly invalidator: SessionInvalidationService) {}

  @Post()
  @HttpCode(200)
  invalidate(@Req() req: Request, @Body(zBody(BodySchema)) body: Input) {
    const expected = process.env.INTERNAL_BUS_SECRET;
    if (!expected) {
      throw new BadRequestException({ error: "internal_invalidate_unavailable" });
    }
    const got =
      typeof req.headers["x-internal-secret"] === "string"
        ? req.headers["x-internal-secret"]
        : "";
    if (!safeEqual(got, expected)) {
      throw new UnauthorizedException("unauthorized");
    }

    this.invalidator.revoke(body.userId, body.reason);
    return { ok: true };
  }
}
