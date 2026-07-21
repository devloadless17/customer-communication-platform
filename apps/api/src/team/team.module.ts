import { Module } from "@nestjs/common";

import { AiAssistantModule } from "./ai-assistant/ai-assistant.module";
import { ApiKeysModule } from "./api-keys/api-keys.module";
import { AudienceGroupsModule } from "./audience-groups/audience-groups.module";
import { ContactFieldsModule } from "./contact-fields/contact-fields.module";
import { OutboundWebhooksAdminModule } from "./outbound-webhooks/outbound-webhooks.module";
import { PermissionsModule } from "./permissions/permissions.module";
import { SnippetsModule } from "./snippets/snippets.module";
import { StagesModule } from "./stages/stages.module";
import { MessageFlagsCatalogModule } from "./message-flags/message-flags-catalog.module";
import { TagsModule } from "./tags/tags.module";
import { TeamRootController } from "./team-root.controller";
import { TeamRootService } from "./team-root.service";
import { InstagramModule } from "./instagram/instagram.module";
import { MessengerModule } from "./messenger/messenger.module";
import { MetaModule } from "./meta/meta.module";
import { TeamWebchatwidgetModule } from "./webchatwidget/webchatwidget.module";
import { WhatsappModule } from "./whatsapp/whatsapp.module";
import { WorkflowsModule as TeamWorkflowsModule } from "./workflows/workflows.module";
import { UsersModule } from "../users/users.module";

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
    MessageFlagsCatalogModule,
    SnippetsModule,
    StagesModule,
    ContactFieldsModule,
    AudienceGroupsModule,
    ApiKeysModule,
    OutboundWebhooksAdminModule,
    MetaModule,
    WhatsappModule,
    MessengerModule,
    InstagramModule,
    TeamWebchatwidgetModule,
    TeamWorkflowsModule,
    PermissionsModule,
    AiAssistantModule,
    // The org work-hours route re-resolves availability via UsersService — the
    // single writer — rather than re-implementing the rule here.
    UsersModule,
  ],
  controllers: [TeamRootController],
  providers: [TeamRootService],
  exports: [TeamRootService],
})
export class TeamModule {}
