import { Module } from "@nestjs/common";

import { ContactsModule } from "@/contacts/contacts.module";

import { InstagramModule } from "@/workspace-settings/instagram/instagram.module";
import { MessengerModule } from "@/workspace-settings/messenger/messenger.module";
import { ApiIdempotencyService } from "./api-idempotency.service";
import { ExternalV1Controller } from "./external-v1.controller";
import { ExternalV1MessagingService } from "./external-v1-messaging.service";
import { ExternalV1Service } from "./external-v1.service";
import { ExternalV1FlagsService } from "./external-v1-flags.service";
import { CallsModule } from "@/calls/calls.module";
import { AssignmentModule } from "@/assignment/assignment.module";
import { UsersModule } from "@/users/users.module";
import { ChannelAccountsModule } from "@/workspace-settings/channel-accounts/channel-accounts.module";
import { TicketsModule } from "@/tickets/tickets.module";
import { MessageFlagsCatalogModule } from "@/workspace-settings/message-flags/message-flags-catalog.module";
import { InboxViewsModule } from "@/inbox-views/inbox-views.module";
import { WhatsappModule } from "@/workspace-settings/whatsapp/whatsapp.module";
import { BroadcastsModule } from "@/broadcasts/broadcasts.module";
import { OutboundWebhooksAdminModule } from "@/workspace-settings/outbound-webhooks/outbound-webhooks.module";
import { AudienceGroupsModule } from "@/workspace-settings/audience-groups/audience-groups.module";
import { SnippetsModule } from "@/workspace-settings/snippets/snippets.module";
import { CustomersModule } from "@/customers/customers.module";
import { ConversationsModule } from "@/conversations/conversations.module";
// Aliased: the worker module in src/workflows exports the same class NAME.
import { WorkflowsModule as WorkflowsSettingsModule } from "@/workspace-settings/workflows/workflows.module";

@Module({
  // ContactsModule exports ContactTransferService — /v1 import/export runs the
  // SAME jobs the in-app UI queues, which is what keeps parity real rather
  // than a second implementation that drifts.
  // CallsModule for the /v1 calling surface — the permission read/request and
  // the call button reuse the same domain service the inbox does, so the rules
  // can't drift between the two entry points.
  // AssignmentModule exports AssignmentService — the /v1 routing-config routes
  // reuse the SAME service the settings page calls, which is what makes the
  // parity rule real instead of a second implementation that drifts.
  // UsersModule exports UserAvailabilityService — the /v1 availability + working-hours
  // writes run through the SAME single writer the settings UI does, so the
  // override-expiry rule and the domain event can't diverge between them.
  // MessageFlagsCatalogModule exports MessageFlagsCatalogService — the /v1
  // flag-catalog writes run through the SAME service the settings page calls,
  // so the archive-not-delete rule and the catalog-changed fanout can't drift
  // between the two entry points.
  imports: [
    ContactsModule,
    CallsModule,
    // Same service the campaign report page uses — the /v1 analytics refresh
    // must hit the identical Meta fetch + COALESCE upsert, or the API and the
    // dashboard would disagree about a campaign's cost.
    BroadcastsModule,
    // Parity build phase 1 — each exposes the SAME service the settings UI
    // calls, so /v1 and the UI can never disagree about a webhook's secret,
    // an audience definition or a snippet body.
    OutboundWebhooksAdminModule,
    AudienceGroupsModule,
    SnippetsModule,
    CustomersModule,
    ConversationsModule,
    WorkflowsSettingsModule,
    AssignmentModule,
    UsersModule,
    MessageFlagsCatalogModule,
    // Same service the in-app settings page uses, so /v1 and the UI can never
    // disagree about which accounts exist or which one is the default.
    ChannelAccountsModule,
    // Same service the in-app board uses — /v1 and the UI can never disagree
    // about a ticket rule.
    TicketsModule,
    // Same service the inbox rail uses. Views become a WHERE clause, so a
    // second implementation here would mean a view could select different
    // conversations through the API than it shows in the product.
    InboxViewsModule,
    // Same service the templates page calls — an unpause has to do the same
    // three things either way (Meta call, local status, resume the campaigns we
    // parked), and a second copy of that would drift.
    WhatsappModule,
    // Same service the Instagram settings panel calls. Entry points live on
    // META, not in our DB, so a second implementation here would mean /v1 and
    // the UI could write different shapes to the same `messenger_profile` node.
    InstagramModule,
    MessengerModule,
  ],
  controllers: [ExternalV1Controller],
  providers: [
    ApiIdempotencyService,
    ExternalV1Service,
    ExternalV1MessagingService,
    ExternalV1FlagsService,
  ],
  exports: [ExternalV1Service],
})
export class ExternalV1Module {}
