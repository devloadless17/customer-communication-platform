import { Module, type OnModuleInit } from "@nestjs/common";

import { RealtimeModule } from "../realtime/realtime.module";
import { DevEmitController } from "./dev-emit.controller";

/**
 * Dev-only routes. Three layers of defence make accidental prod exposure
 * physically impossible:
 *
 *   1) **Module-init gate** (this file's `onModuleInit`). If
 *      NODE_ENV === "production", boot crashes with a legible message
 *      before any request can reach a controller. This is the structural
 *      guarantee: no decorator-removal refactor, no test-env leak, no
 *      half-applied runtime check can route around it.
 *   2) **Controller route gate** (dev-emit.controller.ts). Each handler
 *      checks NODE_ENV !== "production" and returns 404 otherwise. Belt
 *      to the boot-time suspenders — useful in any non-prod environment
 *      where the module legitimately loads but a particular caller
 *      shouldn't have reached the route.
 *   3) **ENABLE_DEV_TOOLS=1** opt-in env flag. Even in dev, the DevTools
 *      UI gates its own affordances on this flag; off by default.
 *
 * Plus SessionGuard + per-team scoping inside each handler — so even with
 * everything enabled, an unauthenticated caller can't reach anything and
 * a logged-in user can't reach into another team.
 *
 * The module is still imported unconditionally by AppModule. The hard
 * cutoff is NODE_ENV, enforced here at NestJS lifecycle init time.
 */
@Module({
  imports: [RealtimeModule],
  controllers: [DevEmitController],
})
export class DevModule implements OnModuleInit {
  onModuleInit(): void {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "[dev] DevModule initialised in production — refusing. " +
          "Remove DevModule from AppModule's imports for prod builds, " +
          "or set NODE_ENV correctly. Loading dev routes in prod would " +
          "expose an authenticated event-firehose surface that bypasses " +
          "audit, analytics, and workflow dispatch.",
      );
    }
  }
}
