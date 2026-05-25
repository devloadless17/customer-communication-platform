import { Global, Module } from "@nestjs/common";

import { ApiKeyGuard } from "./api-key.guard";
import { CapabilityGuard } from "./capability.guard";
import { ChangePasswordController } from "./change-password.controller";
import { InternalSessionController } from "./internal-session.controller";
import { RoleGuard } from "./role.guard";
import { ScopeGuard } from "./scope.guard";
import { SessionGuard } from "./session.guard";
import { SessionInvalidationService } from "./session-invalidation.service";

/**
 * Auth primitives — guards + invalidation. Better Auth itself lives in the
 * Next.js process; this module just consumes the session cookie + session
 * table it writes.
 *
 * `SessionInvalidationService` is the one place that owns "this user is no
 * longer valid — drop every cache and live connection that holds them."
 * `InternalSessionController` exposes it over HTTP so the Next.js /logout
 * route can call it after issuing cookie clears.
 *
 * Global so any feature module can inject `SessionInvalidationService` or
 * apply `@UseGuards(SessionGuard)` without importing the module.
 */
@Global()
@Module({
  controllers: [ChangePasswordController, InternalSessionController],
  providers: [
    SessionGuard,
    ApiKeyGuard,
    RoleGuard,
    CapabilityGuard,
    ScopeGuard,
    SessionInvalidationService,
  ],
  exports: [
    SessionGuard,
    ApiKeyGuard,
    RoleGuard,
    CapabilityGuard,
    ScopeGuard,
    SessionInvalidationService,
  ],
})
export class AuthModule {}
