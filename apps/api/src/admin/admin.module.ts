import { Module } from "@nestjs/common";

import { TeamModule } from "../team/team.module";
import { AdminTeamsController } from "./admin-teams.controller";

@Module({
  imports: [TeamModule],
  controllers: [AdminTeamsController],
})
export class AdminModule {}
