import { Module } from "@nestjs/common";

import { ContactFieldsController } from "./contact-fields.controller";
import { ContactFieldsService } from "./contact-fields.service";

@Module({
  controllers: [ContactFieldsController],
  providers: [ContactFieldsService],
  exports: [ContactFieldsService],
})
export class ContactFieldsModule {}
