import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Request, Response } from "express";

import { withCorrelation } from "./correlation";

/**
 * Global filter for Prisma errors that escape a service's explicit catch
 * block. Most services intercept the codes that matter to their domain
 * (P2002 → ConflictException with a domain-specific error key, P2025 →
 * NotFoundException with a domain-specific path) — that's the right place
 * for those, because only the service knows what "name taken" or "snippet
 * not found" means semantically.
 *
 * This filter is the safety net for the cases that slip through:
 *
 *   - A code path that triggers P2025 in an unexpected place (e.g. a
 *     row deleted by another agent between SELECT and UPDATE) and the
 *     caller hadn't anticipated needing a catch.
 *   - A P2003 (foreign-key violation) — nothing in the codebase handles
 *     this explicitly today; without a filter it surfaces as 500.
 *
 * Without this, those leaks become opaque 500 responses with NestJS's
 * default "Internal server error" body. The handler still logs the full
 * Prisma error server-side (including `meta`, which can contain field
 * names and sometimes values — so it stays out of the response body to
 * avoid PII leak through error responses).
 *
 * Domain-specific exceptions thrown by services (Conflict / NotFound /
 * BadRequest with structured error keys) are NOT intercepted — they
 * already extend HttpException and NestJS's built-in HttpExceptionFilter
 * handles them with their intended status + body.
 */
@Catch(
  Prisma.PrismaClientKnownRequestError,
  Prisma.PrismaClientValidationError,
)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(
    err: Prisma.PrismaClientKnownRequestError | Prisma.PrismaClientValidationError,
    host: ArgumentsHost,
  ): void {
    const { status, errorKey } = this.map(err);

    // APP_FILTER binds this to EVERY context, so a Prisma error escaping a
    // @SubscribeMessage handler in either gateway lands here too — and there
    // `getResponse()` is a socket, not an Express Response. Calling
    // `res.status()` on it threw a TypeError, replacing one clean error with
    // two and losing the correlation log. Log and stop: the ws layer has no
    // status code to carry, and the gateway handlers own their own acks.
    if (host.getType() !== "http") {
      this.logger.error(
        withCorrelation(`prisma error outside http (${host.getType()}) → ${errorKey}`),
        err instanceof Prisma.PrismaClientKnownRequestError
          ? `code=${err.code} meta=${JSON.stringify(err.meta ?? {})}`
          : err.message,
      );
      return;
    }

    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    // Log the FULL error (including .meta) server-side so debugging has
    // everything. The response body keeps only the safe summary.
    // withCorrelation prefixes the originating request id so a leaked Prisma
    // error can be joined back to its HTTP request in log search (the Nest
    // Logger doesn't carry the ALS correlation id on its own).
    this.logger.error(
      withCorrelation(`${req.method} ${req.url} → ${status} (${errorKey})`),
      err instanceof Prisma.PrismaClientKnownRequestError
        ? `code=${err.code} meta=${JSON.stringify(err.meta ?? {})}`
        : err.message,
    );

    res.status(status).json({ error: errorKey });
  }

  private map(err: Prisma.PrismaClientKnownRequestError | Prisma.PrismaClientValidationError): {
    status: number;
    errorKey: string;
  } {
    if (err instanceof Prisma.PrismaClientValidationError) {
      // Invalid Prisma query shape — usually a developer bug, but if it
      // reaches the user it's a 400, not a 500.
      return { status: HttpStatus.BAD_REQUEST, errorKey: "invalid_request" };
    }

    switch (err.code) {
      case "P2025":
        // "Record to update/delete not found" — concurrent delete or stale id.
        return { status: HttpStatus.NOT_FOUND, errorKey: "not_found" };
      case "P2002":
        // Unique constraint violation — domain handlers normally translate
        // these to a meaningful error key (e.g. "phone_taken"). When one
        // slips through, return a generic 409.
        return { status: HttpStatus.CONFLICT, errorKey: "conflict" };
      case "P2003":
      case "P2014":
        // Foreign-key / relation violation — usually a delete that other
        // rows depend on, or an insert pointing at a non-existent parent.
        return { status: HttpStatus.CONFLICT, errorKey: "relation_violation" };
      case "P2024":
        // Connection pool timeout — surface as 503 so caches/proxies
        // back off appropriately instead of retrying immediately.
        return {
          status: HttpStatus.SERVICE_UNAVAILABLE,
          errorKey: "db_busy",
        };
      default:
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          errorKey: "db_error",
        };
    }
  }
}
