import { Module } from "@nestjs/common";

import { ContactsModule } from "@/contacts/contacts.module";

import { ApiIdempotencyService } from "./api-idempotency.service";
import { ExternalV1Controller } from "./external-v1.controller";
import { ExternalV1MessagingService } from "./external-v1-messaging.service";
import { ExternalV1Service } from "./external-v1.service";
import { CallsModule } from "@/calls/calls.module";

@Module({
  // ContactsModule exports ContactTransferService — /v1 import/export runs the
  // SAME jobs the in-app UI queues, which is what keeps parity real rather
  // than a second implementation that drifts.
  // CallsModule for the /v1 calling surface — the permission read/request and
  // the call button reuse the same domain service the inbox does, so the rules
  // can't drift between the two entry points.
  imports: [ContactsModule, CallsModule],
  controllers: [ExternalV1Controller],
  providers: [ApiIdempotencyService, ExternalV1Service, ExternalV1MessagingService],
  exports: [ExternalV1Service],
})
export class ExternalV1Module {}
