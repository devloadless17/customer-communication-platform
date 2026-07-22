import { Module } from "@nestjs/common";

import { ContactsModule } from "../contacts/contacts.module";
import { InboxViewsModule } from "../inbox-views/inbox-views.module";
import { ConversationsController } from "./conversations.controller";
import { ConversationsService } from "./conversations.service";
import { InboxConversationController } from "./inbox.controller";
import { InboxSearchController } from "./inbox-search.controller";

@Module({
  imports: [ContactsModule, InboxViewsModule],
  controllers: [
    ConversationsController,
    InboxConversationController,
    InboxSearchController,
  ],
  providers: [ConversationsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}
