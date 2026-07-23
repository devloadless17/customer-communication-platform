import { Module } from "@nestjs/common";

import { WorkspaceSettingsModule } from "../workspace-settings/workspace-settings.module";
import { UsersModule } from "../users/users.module";
import { AdminAnalyticsController } from "./admin-analytics.controller";
import { AdminTeamsController } from "./admin-teams.controller";

@Module({
  // UsersModule exports UsersService for the cross-team password-reset route
  // (POST /api/admin/teams/:id/members/:userId/reset-password).
  imports: [WorkspaceSettingsModule, UsersModule],
  controllers: [AdminTeamsController, AdminAnalyticsController],
})
export class AdminModule {}
