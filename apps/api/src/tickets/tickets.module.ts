import { Module } from "@nestjs/common";

import { ConversationsModule } from "../conversations/conversations.module";
import { TicketSettingsController, TicketsController } from "./tickets.controller";
import { TicketsService } from "./tickets.service";

@Module({
  // ConversationsModule for the escalation "Message customer" action, which
  // starts a thread from the snapshot's phone via the canonical
  // startConversation path (find-or-create contact + conversation).
  imports: [ConversationsModule],
  controllers: [TicketsController, TicketSettingsController],
  providers: [TicketsService],
  exports: [TicketsService],
})
export class TicketsModule {}
