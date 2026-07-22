import { Module } from "@nestjs/common";

import { TicketSettingsController, TicketsController } from "./tickets.controller";
import { TicketsService } from "./tickets.service";

@Module({
  controllers: [TicketsController, TicketSettingsController],
  providers: [TicketsService],
  exports: [TicketsService],
})
export class TicketsModule {}
