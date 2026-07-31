import { Module } from "@nestjs/common";

import { ChannelsController } from "./channels.controller";
import { ChannelEngagementService } from "./channel-engagement.service";
import { ChannelMessagesService } from "./channel-messages.service";
import { ChannelsService } from "./channels.service";

@Module({
  controllers: [ChannelsController],
  providers: [ChannelsService, ChannelMessagesService, ChannelEngagementService],
  exports: [ChannelsService, ChannelMessagesService, ChannelEngagementService],
})
export class TeamChatModule {}
