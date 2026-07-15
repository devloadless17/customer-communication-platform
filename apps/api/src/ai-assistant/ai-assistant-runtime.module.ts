import { Module } from "@nestjs/common";

import { AiInboxController } from "./ai-inbox.controller";
import { AiInboxService } from "./ai-inbox.service";
import { AiReplySubscriber } from "./ai-reply.subscriber";
import { AiWorkerService } from "./ai-worker.service";

/**
 * Runtime side of the native AI Assistant: the event subscriber (enqueues
 * replies / transcriptions / human-takeover), the in-process worker, and the
 * inbox-facing operations controller. The SETTINGS side lives under
 * team/ai-assistant. Nothing here touches the legacy autopilot/n8n code.
 */
@Module({
  controllers: [AiInboxController],
  providers: [AiReplySubscriber, AiWorkerService, AiInboxService],
})
export class AiAssistantRuntimeModule {}
