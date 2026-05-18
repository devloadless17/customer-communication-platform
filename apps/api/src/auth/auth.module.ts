import { Global, Module } from "@nestjs/common";

import { ApiKeyGuard } from "./api-key.guard";
import { ChangePasswordController } from "./change-password.controller";
import { RoleGuard } from "./role.guard";
import { ScopeGuard } from "./scope.guard";
import { SessionGuard } from "./session.guard";

/**
 * Auth primitives — guards only. Better Auth itself lives in the Next.js
 * process; this module just consumes the session cookie + session table it
 * writes.
 *
 * Global so any feature module can `@UseGuards(SessionGuard)` without
 * importing the module.
 */
@Global()
@Module({
  controllers: [ChangePasswordController],
  providers: [SessionGuard, ApiKeyGuard, RoleGuard, ScopeGuard],
  exports: [SessionGuard, ApiKeyGuard, RoleGuard, ScopeGuard],
})
export class AuthModule {}
