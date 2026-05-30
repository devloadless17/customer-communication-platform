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
  // Compare BYTE lengths, not string char lengths — `timingSafeEqual` throws
  // "Input buffers must have the same byte length" when the two UTF-8 encodings
  // differ in size even if `a.length === b.length` (a non-ASCII probe value
  // could otherwise crash this with a 500 instead of returning a clean false).
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
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
      throw new UnauthorizedException({ error: "unauthorized" });
    }

    this.invalidator.revoke(body.userId, body.reason);
    return { ok: true };
  }
}
