import { Module } from "@nestjs/common";

import { InstagramModule } from "../instagram/instagram.module";
import { MessengerModule } from "../messenger/messenger.module";
import { WhatsappModule } from "../whatsapp/whatsapp.module";
import { MetaController } from "./meta.controller";
import { MetaService } from "./meta.service";

// Imports the channel modules so MetaService can re-sync each connected channel
// (re-derive its Page token + refresh its stored creds) when the shared
// credentials change. One-directional — the channel modules never import this.
@Module({
  imports: [WhatsappModule, MessengerModule, InstagramModule],
  controllers: [MetaController],
  providers: [MetaService],
  exports: [MetaService],
})
export class MetaModule {}
