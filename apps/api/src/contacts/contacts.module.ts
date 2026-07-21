import { Module } from "@nestjs/common";

import { ContactsController } from "./contacts.controller";
import { ContactsService } from "./contacts.service";
import { ContactTransferController } from "./transfer.controller";
import { ContactTransferService } from "./transfer.service";
import { ContactTransferWorkerService } from "./contact-transfer-worker.service";

@Module({
  // ContactTransferController is listed FIRST so its literal paths
  // (`contacts/export`, `contacts/transfers/...`) are matched before any
  // parameterized route the contacts controller adds later. Nest resolves in
  // registration order, and a future `@Get(":id")` on ContactsController would
  // otherwise silently swallow `/contacts/transfers`.
  controllers: [ContactTransferController, ContactsController],
  providers: [ContactsService, ContactTransferService, ContactTransferWorkerService],
  exports: [ContactsService, ContactTransferService],
})
export class ContactsModule {}
