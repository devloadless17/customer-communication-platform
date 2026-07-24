import { Module } from "@nestjs/common";

import { OAuthProvisionController } from "./oauth-provision.controller";
import { RegisterController } from "./register.controller";

/**
 * Registration surface — `POST /api/register` only.
 *
 * The old `POST /api/workspaces` controller + TeamsService were removed: they
 * were internet-reachable, unauthenticated, and dead code (the register
 * controller already creates Team + User + Account + initial stages
 * atomically in one transaction). The module name stays "Teams" to avoid
 * an app-wide rename churn; consider renaming to `RegistrationModule` in
 * a follow-up sweep.
 */
@Module({
  controllers: [RegisterController, OAuthProvisionController],
})
export class TeamsModule {}
