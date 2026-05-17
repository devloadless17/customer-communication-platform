import { Module } from "@nestjs/common";

import { StagesController } from "./stages.controller";
import { StagesService } from "./stages.service";

@Module({
  controllers: [StagesController],
  providers: [StagesService],
  exports: [StagesService],
})
export class StagesModule {}
