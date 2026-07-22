import { Module } from "@nestjs/common";

import { ChannelAccountsController } from "./channel-accounts.controller";
import { ChannelAccountsService } from "./channel-accounts.service";

@Module({
  controllers: [ChannelAccountsController],
  providers: [ChannelAccountsService],
  exports: [ChannelAccountsService],
})
export class ChannelAccountsModule {}
