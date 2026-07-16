import { Module } from "@nestjs/common";

import { AiAssistantController } from "./ai-assistant.controller";
import { AiAssistantService } from "./ai-assistant.service";
import { AiKnowledgeService } from "./ai-knowledge.service";

@Module({
  controllers: [AiAssistantController],
  providers: [AiAssistantService, AiKnowledgeService],
  exports: [AiAssistantService, AiKnowledgeService],
})
export class AiAssistantModule {}
