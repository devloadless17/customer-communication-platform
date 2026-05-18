import { Module } from "@nestjs/common";

import { MessagesController } from "./messages.controller";
import { MessagesService } from "./messages.service";
import { SendWorkerService } from "./send-worker.service";

@Module({
  controllers: [MessagesController],
  providers: [MessagesService, SendWorkerService],
  exports: [MessagesService],
})
export class MessagesModule {}
