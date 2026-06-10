import { Module } from "@nestjs/common";

import { TeamModule } from "../team/team.module";
import { AdminAnalyticsController } from "./admin-analytics.controller";
import { AdminTeamsController } from "./admin-teams.controller";

@Module({
  imports: [TeamModule],
  controllers: [AdminTeamsController, AdminAnalyticsController],
})
export class AdminModule {}
