import { Module } from "@nestjs/common";

import { AdminModule } from "./admin/admin.module";
import { AuthModule } from "./auth/auth.module";
import { BroadcastsModule } from "./broadcasts/broadcasts.module";
import { CommonModule } from "./common/common.module";
import { ContactsModule } from "./contacts/contacts.module";
import { ConversationsModule } from "./conversations/conversations.module";
import { DevModule } from "./dev/dev.module";
import { EventBusModule } from "./events/event-bus.module";
import { ExternalV1Module } from "./external/v1/external-v1.module";
import { HealthModule } from "./health/health.module";
import { InvitesModule } from "./invites/invites.module";
import { MediaModule } from "./media/media.module";
import { MessagesModule } from "./messages/messages.module";
import { NotesModule } from "./notes/notes.module";
import { OutboundWebhooksModule } from "./outbound-webhooks/outbound-webhooks.module";
import { DbModule } from "./db/db.module";
import { RealtimeModule } from "./realtime/realtime.module";
import { TeamModule } from "./team/team.module";
import { TeamChatModule } from "./team-chat/team-chat.module";
import { TeamsModule } from "./registration/teams.module";
import { UsersModule } from "./users/users.module";
import { WebhooksModule } from "./webhooks/webhooks.module";
import { WorkflowsModule } from "./workflows/workflows.module";

/**
 * Root module. Wires every feature area in. Module order here is purely
 * cosmetic; Nest resolves dependencies via the graph, not source order.
 *
 * Phase 3 adds the REST controllers; each domain ships as its own module
 * under `./<domain>/`. The catalog modules (tags, snippets, stages, etc.)
 * are nested under TeamModule.
 */
@Module({
  imports: [
    // Infrastructure
    DbModule,
    CommonModule,
    EventBusModule,
    AuthModule,
    RealtimeModule,
    WebhooksModule,
    WorkflowsModule,
    // Feature modules
    TeamModule,
    TeamsModule,
    InvitesModule,
    UsersModule,
    AdminModule,
    ConversationsModule,
    NotesModule,
    ContactsModule,
    BroadcastsModule,
    TeamChatModule,
    MessagesModule,
    MediaModule,
    ExternalV1Module,
    OutboundWebhooksModule,
    // DevModule is import-gated on NODE_ENV. The module's onModuleInit also
    // throws hard if production somehow reaches it — belt-and-suspenders so
    // a refactor that swaps the import order or the env check still can't
    // accidentally expose the dev event-firehose in prod.
    ...(process.env.NODE_ENV !== "production" ? [DevModule] : []),
    // Smoke
    HealthModule,
  ],
})
export class AppModule {}
