import { Module } from "@nestjs/common";

import { OAuthProvisionController } from "./oauth-provision.controller";
import { RegisterController } from "./register.controller";

/**
 * Registration surface — `POST /api/register` only.
 *
 * The old `POST /api/workspaces` controller + TeamsService were removed: they
 * were internet-reachable, unauthenticated, and dead code (the register
 * controller already creates Organization + Workspace + User + Account +
 * initial stages atomically in one transaction).
 *
 * Renamed from `TeamsModule` 2026-07-27 — the follow-up sweep this file's own
 * comment asked for. It never had anything to do with teams.
 */
@Module({
  controllers: [RegisterController, OAuthProvisionController],
})
export class RegistrationModule {}
