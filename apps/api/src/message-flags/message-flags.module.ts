import { Module } from "@nestjs/common";

import { MessageFlagsController } from "./message-flags.controller";
import { MessageFlagsService } from "./message-flags.service";

@Module({
  controllers: [MessageFlagsController],
  providers: [MessageFlagsService],
  exports: [MessageFlagsService],
})
export class MessageFlagsModule {}
