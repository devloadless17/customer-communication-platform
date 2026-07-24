import { Module } from "@nestjs/common";

import { WorkspaceSettingsModule } from "../workspace-settings/workspace-settings.module";
import { AdminAnalyticsController } from "./admin-analytics.controller";
import { AdminOrganizationsController } from "./admin-organizations.controller";
import { AdminTeamsController } from "./admin-teams.controller";

@Module({
  // UsersModule is gone with the cross-team password-reset route it existed
  // for: password recovery is self-serve now (/forgot-password, emailed OTP),
  // so no operator ever chooses or handles a customer's credential.
  imports: [WorkspaceSettingsModule],
  controllers: [
    AdminTeamsController,
    AdminOrganizationsController,
    AdminAnalyticsController,
  ],
})
export class AdminModule {}
