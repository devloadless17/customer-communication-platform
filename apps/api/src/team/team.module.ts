import { Module } from "@nestjs/common";

import { ApiKeysModule } from "./api-keys/api-keys.module";
import { AudienceGroupsModule } from "./audience-groups/audience-groups.module";
import { ContactFieldsModule } from "./contact-fields/contact-fields.module";
import { SnippetsModule } from "./snippets/snippets.module";
import { StagesModule } from "./stages/stages.module";
import { TagsModule } from "./tags/tags.module";
import { TeamRootController } from "./team-root.controller";
import { TeamRootService } from "./team-root.service";
import { WhatsappModule } from "./whatsapp/whatsapp.module";
import { WorkflowsModule as TeamWorkflowsModule } from "./workflows/workflows.module";

/**
 * Aggregates the `/api/team/*` catalog routes. Each sub-module owns a
 * single catalog (tags, snippets, stages, contact-fields, audience-groups,
 * api-keys, channels, workflows, …) and follows the canonical
 * controller→service→bus pattern set by [tags/](./tags/).
 *
 * Adding a new catalog: copy the tags/ directory shape, swap names, add
 * to this module's `imports`. No app.module.ts change needed.
 */
@Module({
  imports: [
    TagsModule,
    SnippetsModule,
    StagesModule,
    ContactFieldsModule,
    AudienceGroupsModule,
    ApiKeysModule,
    WhatsappModule,
    TeamWorkflowsModule,
  ],
  controllers: [TeamRootController],
  providers: [TeamRootService],
  exports: [TeamRootService],
})
export class TeamModule {}
