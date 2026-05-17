import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";

import { PrismaExceptionFilter } from "./prisma-exception.filter";

/**
 * Cross-cutting utilities. The Prisma exception filter is registered via
 * `APP_FILTER` (not `app.useGlobalFilters` in main.ts) so DI sees it —
 * Test.createTestingModule(...) builds in tests would otherwise miss it.
 *
 * `ZodValidationPipe` stays per-route (it's instantiated with a schema, not
 * injected), so it has no entry here.
 */
@Module({
  providers: [{ provide: APP_FILTER, useClass: PrismaExceptionFilter }],
})
export class CommonModule {}
