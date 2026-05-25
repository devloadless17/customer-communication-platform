import { Module } from "@nestjs/common";

import { ConversationsController } from "./conversations.controller";
import { ConversationsService } from "./conversations.service";
import { InboxConversationController } from "./inbox.controller";
import { InboxSearchController } from "./inbox-search.controller";

@Module({
  controllers: [
    ConversationsController,
    InboxConversationController,
    InboxSearchController,
  ],
  providers: [ConversationsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}
