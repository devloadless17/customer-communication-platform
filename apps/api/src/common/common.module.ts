import { Module } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR } from "@nestjs/core";

import { PrismaExceptionFilter } from "./prisma-exception.filter";
import { RateLimitInterceptor } from "./rate-limit.interceptor";

/**
 * Cross-cutting utilities. The Prisma exception filter is registered via
 * `APP_FILTER` (not `app.useGlobalFilters` in main.ts) so DI sees it —
 * Test.createTestingModule(...) builds in tests would otherwise miss it.
 *
 * RateLimitInterceptor runs globally but no-ops when neither `req.session`
 * nor `req.apiKey` is set (webhooks, login pages — those have IP-level
 * limits). It is an APP_INTERCEPTOR, NOT an APP_GUARD: per-controller
 * `@UseGuards(SessionGuard)` runs AFTER global guards but BEFORE interceptors,
 * so only an interceptor sees the resolved principal. As a global guard it
 * silently metered nothing.
 *
 * `ZodValidationPipe` stays per-route (it's instantiated with a schema, not
 * injected), so it has no entry here.
 */
@Module({
  providers: [
    { provide: APP_FILTER, useClass: PrismaExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: RateLimitInterceptor },
  ],
})
export class CommonModule {}
