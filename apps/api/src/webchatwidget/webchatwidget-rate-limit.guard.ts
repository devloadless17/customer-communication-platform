import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { HttpException, HttpStatus } from "@nestjs/common";
import type { Request } from "express";

import { createTokenBucket } from "../common/token-bucket";

/**
 * Per-IP token bucket for the anonymous widget media-upload endpoint. The global
 * RateLimitInterceptor no-ops without a session, so a public surface needs its
 * own brake. 60 uploads/min/IP is generous for a real visitor (who uploads a
 * handful of files a minute) yet bounds a hostile loop. The media GET is left to
 * the global ipRateLimitMiddleware (600/min/IP) since it's a cheap proxy read.
 */
@Injectable()
export class WebchatwidgetUploadRateLimitGuard implements CanActivate {
  private readonly bucket = createTokenBucket({ perMin: 60 });

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const ip =
      (req.headers["x-real-ip"] as string | undefined)?.trim() || req.ip || "unknown";
    const r = this.bucket.consume(ip);
    if (!r.ok) {
      throw new HttpException(
        { error: "rate_limited", retryAfter: r.retryAfter },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
