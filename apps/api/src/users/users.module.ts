import { Module } from "@nestjs/common";

import { UsersController } from "./users.controller";
import { UserAvailabilityService } from "./user-availability.service";
import { UsersService } from "./users.service";

@Module({
  controllers: [UsersController],
  providers: [UsersService, UserAvailabilityService],
  exports: [UsersService, UserAvailabilityService],
})
export class UsersModule {}
