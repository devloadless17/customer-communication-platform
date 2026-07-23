import { Module } from "@nestjs/common";

import { WebchatwidgetController } from "./webchatwidget.controller";
import { WebchatwidgetAdminService } from "./webchatwidget.service";

/** Admin onboarding for website chat widgets (multi-widget CRUD). Nested under
 *  WorkspaceSettingsModule alongside the other channel-connection admin modules. */
@Module({
  controllers: [WebchatwidgetController],
  providers: [WebchatwidgetAdminService],
  exports: [WebchatwidgetAdminService],
})
export class TeamWebchatwidgetModule {}
