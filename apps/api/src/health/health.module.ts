import { Module } from "@nestjs/common";

import { HealthController } from "./health.controller";
import { HealthWatchdogService } from "./health-watchdog.service";

@Module({
  controllers: [HealthController],
  providers: [HealthWatchdogService],
})
export class HealthModule {}
