import { Module } from "@nestjs/common";

import { ConversationsController } from "./conversations.controller";
import { ConversationsService } from "./conversations.service";
import { InboxConversationController } from "./inbox.controller";

@Module({
  controllers: [ConversationsController, InboxConversationController],
  providers: [ConversationsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}
