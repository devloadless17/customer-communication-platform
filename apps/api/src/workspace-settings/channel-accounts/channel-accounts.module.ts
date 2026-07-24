import { Module } from "@nestjs/common";

import {
  ChannelAccountDirectoryController,
  ChannelAccountsController,
} from "./channel-accounts.controller";
import { ChannelAccountsService } from "./channel-accounts.service";

@Module({
  controllers: [ChannelAccountDirectoryController, ChannelAccountsController],
  providers: [ChannelAccountsService],
  exports: [ChannelAccountsService],
})
export class ChannelAccountsModule {}
