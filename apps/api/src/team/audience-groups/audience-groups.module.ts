import { Module } from "@nestjs/common";

import { AudienceGroupsController } from "./audience-groups.controller";
import { AudienceGroupsService } from "./audience-groups.service";

@Module({
  controllers: [AudienceGroupsController],
  providers: [AudienceGroupsService],
  exports: [AudienceGroupsService],
})
export class AudienceGroupsModule {}
