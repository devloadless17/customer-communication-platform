import { Module } from "@nestjs/common";

import { WhatsappController } from "./whatsapp.controller";
import { WhatsappTemplatesController } from "./whatsapp-templates.controller";
import { WhatsappService } from "./whatsapp.service";

@Module({
  controllers: [WhatsappController, WhatsappTemplatesController],
  providers: [WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule {}
