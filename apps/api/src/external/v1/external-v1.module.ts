import { Module } from "@nestjs/common";

import { ExternalV1Controller } from "./external-v1.controller";
import { ExternalV1MessagingService } from "./external-v1-messaging.service";
import { ExternalV1Service } from "./external-v1.service";

@Module({
  controllers: [ExternalV1Controller],
  providers: [ExternalV1Service, ExternalV1MessagingService],
  exports: [ExternalV1Service],
})
export class ExternalV1Module {}
