import { Module } from "@nestjs/common";

import { InboxViewCountsService } from "./inbox-view-counts.service";
import { InboxViewsController } from "./inbox-views.controller";
import { InboxViewsService } from "./inbox-views.service";

@Module({
  controllers: [InboxViewsController],
  providers: [InboxViewsService, InboxViewCountsService],
  // Exported so the conversations module can resolve `?viewId=` into a filter
  // document without duplicating the visibility check.
  exports: [InboxViewsService, InboxViewCountsService],
})
export class InboxViewsModule {}
