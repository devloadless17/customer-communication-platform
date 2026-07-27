import { Module } from "@nestjs/common";

import { WorkspaceSettingsModule } from "../workspace-settings/workspace-settings.module";

import { WorkspacesController } from "./workspaces.controller";
import { WorkspacesService } from "./workspaces.service";

@Module({
  // WorkspaceSettingsModule exports WorkspaceRootService — the single real
  // implementation of workspace destruction (blob cleanup, batched message
  // drain, provider-cache bust, socket kick). `remove()` delegates to it
  // rather than keeping a second, unsafe cascade.
  imports: [WorkspaceSettingsModule],
  controllers: [WorkspacesController],
  providers: [WorkspacesService],
  exports: [WorkspacesService],
})
export class WorkspacesModule {}
