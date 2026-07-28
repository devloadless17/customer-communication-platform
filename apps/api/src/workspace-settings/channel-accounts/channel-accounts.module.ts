import { Module } from "@nestjs/common";

import { EventBusModule } from "../../events/event-bus.module";

import {
  ChannelAccountDirectoryController,
  ChannelAccountsController,
} from "./channel-accounts.controller";
import { ChannelAccountsService } from "./channel-accounts.service";

@Module({
  // The per-account mutators publish `team.catalog_changed` so a rename or a
  // new default reaches every open tab — see `announce` in the service.
  imports: [EventBusModule],
  controllers: [ChannelAccountDirectoryController, ChannelAccountsController],
  providers: [ChannelAccountsService],
  exports: [ChannelAccountsService],
})
export class ChannelAccountsModule {}
