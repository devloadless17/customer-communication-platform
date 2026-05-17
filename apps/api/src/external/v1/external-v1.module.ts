import { Module } from "@nestjs/common";

import { ExternalV1Controller } from "./external-v1.controller";
import { ExternalV1Service } from "./external-v1.service";

@Module({
  controllers: [ExternalV1Controller],
  providers: [ExternalV1Service],
  exports: [ExternalV1Service],
})
export class ExternalV1Module {}
