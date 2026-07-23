import { Module } from "@nestjs/common";

import { WorkflowsController } from "./workflows.controller";
import { WorkflowsIncomingWebhookController } from "./workflows-webhook.controller";
import { WorkflowsService } from "./workflows.service";

@Module({
  controllers: [WorkflowsController, WorkflowsIncomingWebhookController],
  providers: [WorkflowsService],
  exports: [WorkflowsService],
})
export class WorkflowsModule {}
