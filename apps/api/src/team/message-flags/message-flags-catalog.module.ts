import { Module } from "@nestjs/common";

import { MessageFlagsCatalogController } from "./message-flags-catalog.controller";
import { MessageFlagsCatalogService } from "./message-flags-catalog.service";

@Module({
  controllers: [MessageFlagsCatalogController],
  providers: [MessageFlagsCatalogService],
  exports: [MessageFlagsCatalogService],
})
export class MessageFlagsCatalogModule {}
