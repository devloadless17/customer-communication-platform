import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";

import { PrismaExceptionFilter } from "./prisma-exception.filter";
import { RateLimitGuard } from "./rate-limit.guard";

/**
 * Cross-cutting utilities. The Prisma exception filter is registered via
 * `APP_FILTER` (not `app.useGlobalFilters` in main.ts) so DI sees it —
 * Test.createTestingModule(...) builds in tests would otherwise miss it.
 *
 * RateLimitGuard runs globally but no-ops when `req.session` isn't set
 * (webhooks, login pages, API-key routes — those have their own limits).
 *
 * `ZodValidationPipe` stays per-route (it's instantiated with a schema, not
 * injected), so it has no entry here.
 */
@Module({
  providers: [
    { provide: APP_FILTER, useClass: PrismaExceptionFilter },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class CommonModule {}
