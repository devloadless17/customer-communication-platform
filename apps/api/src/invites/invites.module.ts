import { Module } from "@nestjs/common";

import { InvitesController } from "./invites.controller";
import { InvitesPublicController } from "./invites-public.controller";
import { InvitesService } from "./invites.service";

@Module({
  controllers: [InvitesController, InvitesPublicController],
  providers: [InvitesService],
  exports: [InvitesService],
})
export class InvitesModule {}
