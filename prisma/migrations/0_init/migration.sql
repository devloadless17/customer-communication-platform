-- ---------------------------------------------------------------------------
-- Single-init migration. Replaces the prior init + the
-- 20260526160000_add_user_availability migration on 2026-05-26 (squash #2).
--
-- Produced by:
--   1. apply the previous migration chain to a clean Postgres 16
--   2. pg_dump --schema-only that DB
--   3. sanitize away pg_dump preamble + _prisma_migrations table
--   4. prepend the pg_trgm extension (the only one we need; plpgsql is auto)
--   5. append the two partial indexes schema.prisma documents but that
--      were lost in the previous (2026-05-26) squash
--
-- Every raw SQL nuance is preserved verbatim below:
--   - `Contact_customFields_gin_idx`              GIN with jsonb_path_ops
--   - `Contact_teamId_phoneNumber_whatsapp_key`   partial unique (WHERE channel)
--   - `Contact_phoneNumber_trgm_idx`              GIN trgm WHERE phoneNumber NOT NULL
--   - `Contact_name_trgm_idx`                     GIN trgm
--   - `Conversation_lastMessagePreview_trgm_idx`  GIN trgm
--   - `Message_body_trgm_idx` / `InternalNote_body_trgm_idx` /
--     `TeamChannelMessage_body_trgm_idx`          GIN trgm
--   - `ContactStage_teamId_isDefault_key`         partial unique (WHERE isDefault)
--   - `OutboundEvent_drainer_pending_idx`         partial (WHERE publishedAt NULL AND failedAt NULL)
--   - `Message_conversationId_timestamp_inbound_idx`  partial (WHERE direction='in')
--   - `TeamChannelMessage_channel_toplevel_keyset_idx`  partial (WHERE threadRootId IS NULL)
--
-- Do NOT regenerate this file from `prisma migrate dev` after edits to
-- schema.prisma; the auto-emitted DDL strips the jsonb_path_ops index and
-- both partial indexes above. Any future schema change goes in a NEW
-- timestamped migration alongside this one.
-- ---------------------------------------------------------------------------

-- pg_trgm powers every GIN trigram search index below. plpgsql ships
-- enabled by default in stock Postgres so we don't restate it here.
CREATE EXTENSION IF NOT EXISTS "pg_trgm";


CREATE TYPE public."BroadcastRecipientStatus" AS ENUM (
    'queued',
    'sent',
    'failed'
);

CREATE TYPE public."BroadcastStatus" AS ENUM (
    'queued',
    'running',
    'completed',
    'failed',
    'canceled',
    'paused',
    'scheduled'
);

CREATE TYPE public."Channel" AS ENUM (
    'whatsapp'
);

CREATE TYPE public."ContactSource" AS ENUM (
    'inbound',
    'manual'
);

CREATE TYPE public."ConversationEventKind" AS ENUM (
    'assigned',
    'status_changed',
    'tag_added',
    'tag_removed',
    'note_added',
    'note_deleted',
    'stage_changed'
);

CREATE TYPE public."ConversationStatus" AS ENUM (
    'open',
    'pending',
    'closed'
);

CREATE TYPE public."MessageDirection" AS ENUM (
    'in',
    'out'
);

CREATE TYPE public."MessageStatus" AS ENUM (
    'sent',
    'delivered',
    'read',
    'failed'
);

CREATE TYPE public."Plan" AS ENUM (
    'free',
    'starter',
    'advanced',
    'enterprise'
);

CREATE TYPE public."Role" AS ENUM (
    'superAdmin',
    'admin',
    'manager',
    'agent'
);

CREATE TYPE public."TemplateCategory" AS ENUM (
    'marketing',
    'utility',
    'authentication'
);

CREATE TYPE public."TemplateStatus" AS ENUM (
    'approved',
    'pending',
    'rejected',
    'paused',
    'disabled'
);

CREATE TYPE public."WorkflowRunStatus" AS ENUM (
    'queued',
    'running',
    'waiting',
    'completed',
    'failed',
    'skipped'
);

CREATE TYPE public."WorkflowStepType" AS ENUM (
    'send_message',
    'send_template',
    'add_comment',
    'assign_to',
    'set_status',
    'open_conversation',
    'close_conversation',
    'add_tag',
    'remove_tag',
    'update_field',
    'update_lifecycle',
    'branch',
    'wait',
    'jump_to_step',
    'noop',
    'ask_question',
    'http_request',
    'trigger_workflow'
);

CREATE TYPE public."WorkflowTriggerEvent" AS ENUM (
    'message_received',
    'conversation_created',
    'conversation_opened',
    'conversation_closed',
    'conversation_assigned',
    'conversation_status_changed',
    'contact_field_updated',
    'contact_tag_updated',
    'contact_lifecycle_updated',
    'manual_trigger',
    'incoming_webhook'
);

CREATE TABLE public."Account" (
    id text NOT NULL,
    "userId" text NOT NULL,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamp(3) without time zone,
    "refreshTokenExpiresAt" timestamp(3) without time zone,
    scope text,
    password text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public."ApiIdempotencyKey" (
    id text NOT NULL,
    "teamId" text NOT NULL,
    "apiKeyId" text NOT NULL,
    key text NOT NULL,
    "responseBody" jsonb NOT NULL,
    "responseStatus" integer NOT NULL,
    "requestHash" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "expiresAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public."AudienceGroup" (
    id text NOT NULL,
    "teamId" text NOT NULL,
    name text NOT NULL,
    description text,
    "createdById" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public."Broadcast" (
    id text NOT NULL,
    "teamId" text NOT NULL,
    "createdById" text,
    status public."BroadcastStatus" DEFAULT 'queued'::public."BroadcastStatus" NOT NULL,
    "templateId" text NOT NULL,
    "templateName" text NOT NULL,
    "templateLanguage" text NOT NULL,
    variables jsonb NOT NULL,
    "audienceMode" text NOT NULL,
    "audienceTagIds" text[] DEFAULT ARRAY[]::text[],
    "audienceGroupId" text,
    "audienceGroupName" text,
    "totalCount" integer DEFAULT 0 NOT NULL,
    "sentCount" integer DEFAULT 0 NOT NULL,
    "failedCount" integer DEFAULT 0 NOT NULL,
    "lastError" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "startedAt" timestamp(3) without time zone,
    "completedAt" timestamp(3) without time zone,
    name text,
    "scheduledAt" timestamp(3) without time zone
);

CREATE TABLE public."BroadcastRecipient" (
    id text NOT NULL,
    "broadcastId" text NOT NULL,
    "contactId" text NOT NULL,
    "conversationId" text,
    status public."BroadcastRecipientStatus" DEFAULT 'queued'::public."BroadcastRecipientStatus" NOT NULL,
    "externalId" text,
    "errorMessage" text,
    "sentAt" timestamp(3) without time zone
);

CREATE TABLE public."ChannelConnection" (
    id text NOT NULL,
    "teamId" text NOT NULL,
    channel public."Channel" NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    secrets jsonb DEFAULT '{}'::jsonb NOT NULL,
    "isActive" boolean DEFAULT true NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public."Contact" (
    id text NOT NULL,
    "teamId" text NOT NULL,
    "phoneNumber" text,
    "identityChannel" public."Channel" NOT NULL,
    "externalContactId" text,
    name text NOT NULL,
    "firstName" text,
    "lastName" text,
    language text,
    "countryCode" text,
    "avatarUrl" text,
    email text,
    location text,
    "customFields" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "stageId" text,
    source public."ContactSource" DEFAULT 'inbound'::public."ContactSource" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "lastInboundAt" timestamp(3) without time zone,
    version integer DEFAULT 0 NOT NULL,
    "deletedAt" timestamp(3) without time zone
);

CREATE TABLE public."ContactFieldDefinition" (
    id text NOT NULL,
    "teamId" text NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    "order" integer DEFAULT 0 NOT NULL,
    "isVisible" boolean DEFAULT true NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."ContactStage" (
    id text NOT NULL,
    "teamId" text NOT NULL,
    name text NOT NULL,
    color text DEFAULT 'slate'::text NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    "isDefault" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."Conversation" (
    id text NOT NULL,
    "teamId" text NOT NULL,
    "contactId" text NOT NULL,
    channel public."Channel" DEFAULT 'whatsapp'::public."Channel" NOT NULL,
    "assignedUserId" text,
    status public."ConversationStatus" DEFAULT 'pending'::public."ConversationStatus" NOT NULL,
    "unreadCount" integer DEFAULT 0 NOT NULL,
    "lastMessageAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "lastMessagePreview" text DEFAULT ''::text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "firstAssignedAt" timestamp(3) without time zone,
    "firstAssignedUserId" text,
    "lastAssignedAt" timestamp(3) without time zone,
    "firstResponseAt" timestamp(3) without time zone,
    "firstResponseByUserId" text,
    "closedAt" timestamp(3) without time zone,
    "closedByUserId" text,
    "closedCategory" text,
    "closedSummary" text,
    "assignmentsCount" integer DEFAULT 0 NOT NULL,
    "incomingMessagesCount" integer DEFAULT 0 NOT NULL,
    "outgoingMessagesCount" integer DEFAULT 0 NOT NULL,
    "responsesCount" integer DEFAULT 0 NOT NULL
);

CREATE TABLE public."ConversationEvent" (
    id text NOT NULL,
    "conversationId" text NOT NULL,
    "teamId" text NOT NULL,
    "userId" text,
    "apiKeyId" text,
    kind public."ConversationEventKind" NOT NULL,
    before jsonb,
    after jsonb,
    at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."InternalNote" (
    id text NOT NULL,
    "teamId" text NOT NULL,
    "conversationId" text NOT NULL,
    "authorUserId" text,
    body text NOT NULL,
    "timestamp" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."Invite" (
    id text NOT NULL,
    "teamId" text NOT NULL,
    email text NOT NULL,
    role public."Role" DEFAULT 'agent'::public."Role" NOT NULL,
    "tokenHash" text NOT NULL,
    "createdById" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "expiresAt" timestamp(3) without time zone NOT NULL,
    "acceptedAt" timestamp(3) without time zone
);

CREATE TABLE public."LoginAttempt" (
    email text NOT NULL,
    "failedCount" integer DEFAULT 0 NOT NULL,
    "lockedUntil" timestamp(3) without time zone,
    "lastFailedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."Message" (
    id text NOT NULL,
    "teamId" text NOT NULL,
    "conversationId" text NOT NULL,
    "externalId" text NOT NULL,
    "senderUserId" text,
    body text NOT NULL,
    direction public."MessageDirection" NOT NULL,
    channel public."Channel" NOT NULL,
    status public."MessageStatus" DEFAULT 'sent'::public."MessageStatus" NOT NULL,
    "rawPayload" jsonb NOT NULL,
    "timestamp" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "mediaKind" text,
    "mediaKey" text,
    "mediaUrl" text,
    "mediaMimeType" text,
    "mediaCaption" text,
    "mediaFilename" text,
    "mediaSizeBytes" integer,
    "mediaDurationMs" integer,
    "mediaThumbnailKey" text,
    "mediaThumbnailUrl" text,
    "replyToMessageId" text
);

CREATE TABLE public."MessageTemplate" (
    id text NOT NULL,
    "teamId" text NOT NULL,
    "externalId" text,
    name text NOT NULL,
    language text NOT NULL,
    category public."TemplateCategory" NOT NULL,
    status public."TemplateStatus" NOT NULL,
    "bodyText" text DEFAULT ''::text NOT NULL,
    components jsonb NOT NULL,
    "variableBindings" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "syncedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."OutboundEvent" (
    id text NOT NULL,
    "teamId" text NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "publishedAt" timestamp(3) without time zone,
    "failedAt" timestamp(3) without time zone,
    "lastError" text,
    attempts integer DEFAULT 0 NOT NULL
);

CREATE TABLE public."OutboundSendAttempt" (
    id text NOT NULL,
    "jobId" text NOT NULL,
    "teamId" text NOT NULL,
    "conversationId" text NOT NULL,
    "attemptStartedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "completedAt" timestamp(3) without time zone,
    "externalId" text,
    "failedAt" timestamp(3) without time zone,
    "failureReason" text
);

CREATE TABLE public."OutboundWebhook" (
    id text NOT NULL,
    "teamId" text NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    secret text NOT NULL,
    "eventTypes" text[],
    enabled boolean DEFAULT true NOT NULL,
    "createdById" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "lastDeliveredAt" timestamp(3) without time zone,
    "lastErrorAt" timestamp(3) without time zone,
    "lastErrorMessage" text,
    "consecutiveFailures" integer DEFAULT 0 NOT NULL,
    "disabledAt" timestamp(3) without time zone,
    "disabledReason" text
);

CREATE TABLE public."OutboundWebhookDelivery" (
    id text NOT NULL,
    "webhookId" text NOT NULL,
    "eventType" text NOT NULL,
    payload jsonb NOT NULL,
    "responseStatus" integer,
    "responseBody" text,
    "attemptCount" integer DEFAULT 0 NOT NULL,
    "deliveredAt" timestamp(3) without time zone,
    "failedAt" timestamp(3) without time zone,
    "errorMessage" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "correlationId" text
);

CREATE TABLE public."Session" (
    id text NOT NULL,
    "userId" text NOT NULL,
    token text NOT NULL,
    "expiresAt" timestamp(3) without time zone NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public."Snippet" (
    id text NOT NULL,
    "teamId" text NOT NULL,
    name text NOT NULL,
    label text NOT NULL,
    body text NOT NULL,
    "createdById" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public."Tag" (
    id text NOT NULL,
    "teamId" text NOT NULL,
    name text NOT NULL,
    color text DEFAULT 'slate'::text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."Team" (
    id text NOT NULL,
    name text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    plan public."Plan" DEFAULT 'starter'::public."Plan" NOT NULL,
    "contactPanelBuiltins" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "rolePermissions" jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE TABLE public."TeamApiKey" (
    id text NOT NULL,
    "teamId" text NOT NULL,
    name text NOT NULL,
    "tokenHash" text NOT NULL,
    "tokenPrefix" text NOT NULL,
    "createdById" text NOT NULL,
    "lastUsedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "revokedAt" timestamp(3) without time zone,
    scopes text[] DEFAULT ARRAY['*'::text]
);

CREATE TABLE public."TeamChannel" (
    id text NOT NULL,
    "teamId" text NOT NULL,
    name text NOT NULL,
    description text,
    "isDefault" boolean DEFAULT false NOT NULL,
    "createdById" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "lastMessageAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "lastMessagePreview" text DEFAULT ''::text NOT NULL
);

CREATE TABLE public."TeamChannelMember" (
    "channelId" text NOT NULL,
    "userId" text NOT NULL,
    "addedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "addedById" text
);

CREATE TABLE public."TeamChannelMention" (
    id text NOT NULL,
    "messageId" text NOT NULL,
    "mentionedUserId" text NOT NULL
);

CREATE TABLE public."TeamChannelMessage" (
    id text NOT NULL,
    "channelId" text NOT NULL,
    "teamId" text NOT NULL,
    "authorUserId" text,
    body text NOT NULL,
    "mediaKind" text,
    "mediaKey" text,
    "mediaUrl" text,
    "mediaMimeType" text,
    "mediaCaption" text,
    "mediaFilename" text,
    "mediaSizeBytes" integer,
    "mediaDurationMs" integer,
    "editedAt" timestamp(3) without time zone,
    "threadRootId" text,
    "threadReplyCount" integer DEFAULT 0 NOT NULL,
    "threadLastReplyAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."TeamChannelPin" (
    id text NOT NULL,
    "channelId" text NOT NULL,
    "messageId" text NOT NULL,
    "pinnedById" text,
    "pinnedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."TeamChannelReaction" (
    id text NOT NULL,
    "messageId" text NOT NULL,
    "userId" text NOT NULL,
    emoji text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."TeamChannelReadReceipt" (
    id text NOT NULL,
    "userId" text NOT NULL,
    "channelId" text NOT NULL,
    "lastReadAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."User" (
    id text NOT NULL,
    "teamId" text NOT NULL,
    role public."Role" DEFAULT 'agent'::public."Role" NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    "emailVerified" boolean DEFAULT true NOT NULL,
    "avatarUrl" text,
    "deactivatedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "availabilityStatus" text DEFAULT 'available'::text,
    "availabilityMessage" text
);

CREATE TABLE public."Verification" (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    "expiresAt" timestamp(3) without time zone NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public."Workflow" (
    id text NOT NULL,
    "teamId" text NOT NULL,
    name text NOT NULL,
    published boolean DEFAULT false NOT NULL,
    trigger public."WorkflowTriggerEvent" NOT NULL,
    "triggerConfig" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "triggerConditions" jsonb DEFAULT '{"op": "AND", "children": []}'::jsonb NOT NULL,
    "triggerOncePerContact" boolean DEFAULT false NOT NULL,
    graph jsonb DEFAULT '{"edges": [], "nodes": [], "startNodeId": ""}'::jsonb NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public."WorkflowAwaitingReply" (
    id text NOT NULL,
    "teamId" text NOT NULL,
    "contactId" text NOT NULL,
    "runId" text NOT NULL,
    "workflowId" text NOT NULL,
    "stepId" text NOT NULL,
    "expiresAt" timestamp(3) without time zone NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."WorkflowContactState" (
    id text NOT NULL,
    "workflowId" text NOT NULL,
    "contactId" text NOT NULL,
    "teamId" text NOT NULL,
    "firedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."WorkflowRun" (
    id text NOT NULL,
    "workflowId" text NOT NULL,
    "teamId" text NOT NULL,
    status public."WorkflowRunStatus" DEFAULT 'queued'::public."WorkflowRunStatus" NOT NULL,
    trigger public."WorkflowTriggerEvent" NOT NULL,
    "contactId" text,
    "conversationId" text,
    "eventPayload" jsonb NOT NULL,
    "graphSnapshot" jsonb,
    "currentStepId" text,
    "waitUntil" timestamp(3) without time zone,
    "jumpsUsed" integer DEFAULT 0 NOT NULL,
    "stepLog" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "pendingAnswer" jsonb,
    "stepOutputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    "errorMessage" text,
    "startedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "finishedAt" timestamp(3) without time zone
);

CREATE TABLE public."_AudienceGroupContacts" (
    "A" text NOT NULL,
    "B" text NOT NULL
);

CREATE TABLE public."_AudienceGroupTags" (
    "A" text NOT NULL,
    "B" text NOT NULL
);

CREATE TABLE public."_ContactToTag" (
    "A" text NOT NULL,
    "B" text NOT NULL
);

ALTER TABLE ONLY public."Account"
    ADD CONSTRAINT "Account_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ApiIdempotencyKey"
    ADD CONSTRAINT "ApiIdempotencyKey_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."AudienceGroup"
    ADD CONSTRAINT "AudienceGroup_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."BroadcastRecipient"
    ADD CONSTRAINT "BroadcastRecipient_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Broadcast"
    ADD CONSTRAINT "Broadcast_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ChannelConnection"
    ADD CONSTRAINT "ChannelConnection_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ContactFieldDefinition"
    ADD CONSTRAINT "ContactFieldDefinition_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ContactStage"
    ADD CONSTRAINT "ContactStage_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Contact"
    ADD CONSTRAINT "Contact_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ConversationEvent"
    ADD CONSTRAINT "ConversationEvent_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Conversation"
    ADD CONSTRAINT "Conversation_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."InternalNote"
    ADD CONSTRAINT "InternalNote_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Invite"
    ADD CONSTRAINT "Invite_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."LoginAttempt"
    ADD CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY (email);

ALTER TABLE ONLY public."MessageTemplate"
    ADD CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Message"
    ADD CONSTRAINT "Message_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."OutboundEvent"
    ADD CONSTRAINT "OutboundEvent_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."OutboundSendAttempt"
    ADD CONSTRAINT "OutboundSendAttempt_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."OutboundWebhookDelivery"
    ADD CONSTRAINT "OutboundWebhookDelivery_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."OutboundWebhook"
    ADD CONSTRAINT "OutboundWebhook_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Session"
    ADD CONSTRAINT "Session_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Snippet"
    ADD CONSTRAINT "Snippet_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Tag"
    ADD CONSTRAINT "Tag_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."TeamApiKey"
    ADD CONSTRAINT "TeamApiKey_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."TeamChannelMember"
    ADD CONSTRAINT "TeamChannelMember_pkey" PRIMARY KEY ("channelId", "userId");

ALTER TABLE ONLY public."TeamChannelMention"
    ADD CONSTRAINT "TeamChannelMention_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."TeamChannelMessage"
    ADD CONSTRAINT "TeamChannelMessage_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."TeamChannelPin"
    ADD CONSTRAINT "TeamChannelPin_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."TeamChannelReaction"
    ADD CONSTRAINT "TeamChannelReaction_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."TeamChannelReadReceipt"
    ADD CONSTRAINT "TeamChannelReadReceipt_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."TeamChannel"
    ADD CONSTRAINT "TeamChannel_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Team"
    ADD CONSTRAINT "Team_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."User"
    ADD CONSTRAINT "User_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Verification"
    ADD CONSTRAINT "Verification_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."WorkflowAwaitingReply"
    ADD CONSTRAINT "WorkflowAwaitingReply_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."WorkflowContactState"
    ADD CONSTRAINT "WorkflowContactState_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."WorkflowRun"
    ADD CONSTRAINT "WorkflowRun_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Workflow"
    ADD CONSTRAINT "Workflow_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."_AudienceGroupContacts"
    ADD CONSTRAINT "_AudienceGroupContacts_AB_pkey" PRIMARY KEY ("A", "B");

ALTER TABLE ONLY public."_AudienceGroupTags"
    ADD CONSTRAINT "_AudienceGroupTags_AB_pkey" PRIMARY KEY ("A", "B");

ALTER TABLE ONLY public."_ContactToTag"
    ADD CONSTRAINT "_ContactToTag_AB_pkey" PRIMARY KEY ("A", "B");

CREATE UNIQUE INDEX "Account_providerId_accountId_key" ON public."Account" USING btree ("providerId", "accountId");

CREATE INDEX "Account_userId_idx" ON public."Account" USING btree ("userId");

CREATE INDEX "ApiIdempotencyKey_expiresAt_idx" ON public."ApiIdempotencyKey" USING btree ("expiresAt");

CREATE UNIQUE INDEX "ApiIdempotencyKey_teamId_apiKeyId_key_key" ON public."ApiIdempotencyKey" USING btree ("teamId", "apiKeyId", key);

CREATE INDEX "AudienceGroup_teamId_idx" ON public."AudienceGroup" USING btree ("teamId");

CREATE UNIQUE INDEX "AudienceGroup_teamId_name_key" ON public."AudienceGroup" USING btree ("teamId", name);

CREATE UNIQUE INDEX "BroadcastRecipient_broadcastId_contactId_key" ON public."BroadcastRecipient" USING btree ("broadcastId", "contactId");

CREATE INDEX "BroadcastRecipient_broadcastId_status_idx" ON public."BroadcastRecipient" USING btree ("broadcastId", status);

CREATE INDEX "BroadcastRecipient_contactId_idx" ON public."BroadcastRecipient" USING btree ("contactId");

CREATE INDEX "Broadcast_teamId_createdAt_idx" ON public."Broadcast" USING btree ("teamId", "createdAt" DESC);

CREATE INDEX "Broadcast_teamId_scheduledAt_idx" ON public."Broadcast" USING btree ("teamId", "scheduledAt");

CREATE INDEX "Broadcast_teamId_status_idx" ON public."Broadcast" USING btree ("teamId", status);

CREATE UNIQUE INDEX "ChannelConnection_teamId_channel_key" ON public."ChannelConnection" USING btree ("teamId", channel);

CREATE UNIQUE INDEX "ContactFieldDefinition_teamId_key_key" ON public."ContactFieldDefinition" USING btree ("teamId", key);

CREATE INDEX "ContactFieldDefinition_teamId_order_idx" ON public."ContactFieldDefinition" USING btree ("teamId", "order");

CREATE UNIQUE INDEX "ContactStage_teamId_isDefault_key" ON public."ContactStage" USING btree ("teamId") WHERE ("isDefault" = true);

CREATE UNIQUE INDEX "ContactStage_teamId_name_key" ON public."ContactStage" USING btree ("teamId", name);

CREATE INDEX "ContactStage_teamId_position_idx" ON public."ContactStage" USING btree ("teamId", "position");

CREATE INDEX "Contact_customFields_gin_idx" ON public."Contact" USING gin ("customFields" jsonb_path_ops);

CREATE INDEX "Contact_name_trgm_idx" ON public."Contact" USING gin (name public.gin_trgm_ops);

CREATE INDEX "Contact_phoneNumber_trgm_idx" ON public."Contact" USING gin ("phoneNumber" public.gin_trgm_ops) WHERE ("phoneNumber" IS NOT NULL);

CREATE INDEX "Contact_teamId_deletedAt_idx" ON public."Contact" USING btree ("teamId", "deletedAt");

CREATE UNIQUE INDEX "Contact_teamId_identityChannel_externalContactId_key" ON public."Contact" USING btree ("teamId", "identityChannel", "externalContactId");

CREATE INDEX "Contact_teamId_idx" ON public."Contact" USING btree ("teamId");

CREATE INDEX "Contact_teamId_lastInboundAt_idx" ON public."Contact" USING btree ("teamId", "lastInboundAt" DESC);

CREATE INDEX "Contact_teamId_phoneNumber_idx" ON public."Contact" USING btree ("teamId", "phoneNumber");

CREATE UNIQUE INDEX "Contact_teamId_phoneNumber_whatsapp_key" ON public."Contact" USING btree ("teamId", "phoneNumber") WHERE (("phoneNumber" IS NOT NULL) AND ("identityChannel" = 'whatsapp'::public."Channel"));

CREATE INDEX "Contact_teamId_source_idx" ON public."Contact" USING btree ("teamId", source);

CREATE INDEX "Contact_teamId_stageId_idx" ON public."Contact" USING btree ("teamId", "stageId");

CREATE INDEX "ConversationEvent_at_idx" ON public."ConversationEvent" USING btree (at);

CREATE INDEX "ConversationEvent_conversationId_at_idx" ON public."ConversationEvent" USING btree ("conversationId", at DESC);

CREATE INDEX "Conversation_lastMessagePreview_trgm_idx" ON public."Conversation" USING gin ("lastMessagePreview" public.gin_trgm_ops);

CREATE INDEX "Conversation_teamId_assignedUserId_idx" ON public."Conversation" USING btree ("teamId", "assignedUserId");

CREATE UNIQUE INDEX "Conversation_teamId_contactId_key" ON public."Conversation" USING btree ("teamId", "contactId");

CREATE INDEX "Conversation_teamId_lastMessageAt_id_idx" ON public."Conversation" USING btree ("teamId", "lastMessageAt" DESC, id DESC);

CREATE INDEX "Conversation_teamId_status_lastMessageAt_idx" ON public."Conversation" USING btree ("teamId", status, "lastMessageAt" DESC);

CREATE INDEX "InternalNote_body_trgm_idx" ON public."InternalNote" USING gin (body public.gin_trgm_ops);

CREATE INDEX "InternalNote_conversationId_timestamp_idx" ON public."InternalNote" USING btree ("conversationId", "timestamp");

CREATE INDEX "InternalNote_teamId_idx" ON public."InternalNote" USING btree ("teamId");

CREATE INDEX "Invite_teamId_email_idx" ON public."Invite" USING btree ("teamId", email);

CREATE UNIQUE INDEX "Invite_tokenHash_key" ON public."Invite" USING btree ("tokenHash");

CREATE INDEX "LoginAttempt_lockedUntil_idx" ON public."LoginAttempt" USING btree ("lockedUntil");

CREATE UNIQUE INDEX "MessageTemplate_teamId_name_language_key" ON public."MessageTemplate" USING btree ("teamId", name, language);

CREATE INDEX "MessageTemplate_teamId_status_idx" ON public."MessageTemplate" USING btree ("teamId", status);

CREATE INDEX "Message_body_trgm_idx" ON public."Message" USING gin (body public.gin_trgm_ops);

CREATE INDEX "Message_conversationId_timestamp_id_idx" ON public."Message" USING btree ("conversationId", "timestamp" DESC, id DESC);

CREATE INDEX "Message_conversationId_timestamp_idx" ON public."Message" USING btree ("conversationId", "timestamp");

CREATE INDEX "Message_replyToMessageId_idx" ON public."Message" USING btree ("replyToMessageId");

CREATE UNIQUE INDEX "Message_teamId_channel_externalId_key" ON public."Message" USING btree ("teamId", channel, "externalId");

CREATE INDEX "Message_teamId_idx" ON public."Message" USING btree ("teamId");

CREATE INDEX "OutboundEvent_drainer_pending_idx" ON public."OutboundEvent" USING btree ("createdAt") WHERE (("publishedAt" IS NULL) AND ("failedAt" IS NULL));

CREATE INDEX "OutboundSendAttempt_attemptStartedAt_idx" ON public."OutboundSendAttempt" USING btree ("attemptStartedAt");

CREATE UNIQUE INDEX "OutboundSendAttempt_jobId_key" ON public."OutboundSendAttempt" USING btree ("jobId");

CREATE INDEX "OutboundSendAttempt_teamId_completedAt_idx" ON public."OutboundSendAttempt" USING btree ("teamId", "completedAt");

CREATE INDEX "OutboundWebhookDelivery_createdAt_idx" ON public."OutboundWebhookDelivery" USING btree ("createdAt");

CREATE INDEX "OutboundWebhookDelivery_webhookId_createdAt_idx" ON public."OutboundWebhookDelivery" USING btree ("webhookId", "createdAt" DESC);

CREATE INDEX "OutboundWebhook_teamId_enabled_idx" ON public."OutboundWebhook" USING btree ("teamId", enabled);

CREATE UNIQUE INDEX "Session_token_key" ON public."Session" USING btree (token);

CREATE INDEX "Session_userId_idx" ON public."Session" USING btree ("userId");

CREATE INDEX "Snippet_teamId_label_idx" ON public."Snippet" USING btree ("teamId", label);

CREATE UNIQUE INDEX "Snippet_teamId_name_key" ON public."Snippet" USING btree ("teamId", name);

CREATE INDEX "Tag_teamId_idx" ON public."Tag" USING btree ("teamId");

CREATE UNIQUE INDEX "Tag_teamId_name_key" ON public."Tag" USING btree ("teamId", name);

CREATE INDEX "TeamApiKey_teamId_revokedAt_idx" ON public."TeamApiKey" USING btree ("teamId", "revokedAt");

CREATE UNIQUE INDEX "TeamApiKey_tokenHash_key" ON public."TeamApiKey" USING btree ("tokenHash");

CREATE INDEX "TeamChannelMember_userId_idx" ON public."TeamChannelMember" USING btree ("userId");

CREATE INDEX "TeamChannelMention_mentionedUserId_idx" ON public."TeamChannelMention" USING btree ("mentionedUserId");

CREATE UNIQUE INDEX "TeamChannelMention_messageId_mentionedUserId_key" ON public."TeamChannelMention" USING btree ("messageId", "mentionedUserId");

CREATE INDEX "TeamChannelMessage_body_trgm_idx" ON public."TeamChannelMessage" USING gin (body public.gin_trgm_ops);

CREATE INDEX "TeamChannelMessage_channelId_createdAt_id_idx" ON public."TeamChannelMessage" USING btree ("channelId", "createdAt" DESC, id DESC);

CREATE INDEX "TeamChannelMessage_teamId_idx" ON public."TeamChannelMessage" USING btree ("teamId");

CREATE INDEX "TeamChannelMessage_threadRootId_createdAt_idx" ON public."TeamChannelMessage" USING btree ("threadRootId", "createdAt");

CREATE INDEX "TeamChannelPin_channelId_pinnedAt_idx" ON public."TeamChannelPin" USING btree ("channelId", "pinnedAt" DESC);

CREATE UNIQUE INDEX "TeamChannelPin_messageId_key" ON public."TeamChannelPin" USING btree ("messageId");

CREATE INDEX "TeamChannelReaction_messageId_idx" ON public."TeamChannelReaction" USING btree ("messageId");

CREATE UNIQUE INDEX "TeamChannelReaction_messageId_userId_emoji_key" ON public."TeamChannelReaction" USING btree ("messageId", "userId", emoji);

CREATE INDEX "TeamChannelReadReceipt_channelId_idx" ON public."TeamChannelReadReceipt" USING btree ("channelId");

CREATE UNIQUE INDEX "TeamChannelReadReceipt_userId_channelId_key" ON public."TeamChannelReadReceipt" USING btree ("userId", "channelId");

CREATE INDEX "TeamChannel_teamId_lastMessageAt_idx" ON public."TeamChannel" USING btree ("teamId", "lastMessageAt" DESC);

CREATE UNIQUE INDEX "TeamChannel_teamId_name_key" ON public."TeamChannel" USING btree ("teamId", name);

CREATE UNIQUE INDEX "User_email_key" ON public."User" USING btree (email);

CREATE INDEX "User_teamId_idx" ON public."User" USING btree ("teamId");

CREATE INDEX "Verification_identifier_idx" ON public."Verification" USING btree (identifier);

CREATE INDEX "WorkflowAwaitingReply_expiresAt_idx" ON public."WorkflowAwaitingReply" USING btree ("expiresAt");

CREATE UNIQUE INDEX "WorkflowAwaitingReply_runId_key" ON public."WorkflowAwaitingReply" USING btree ("runId");

CREATE INDEX "WorkflowAwaitingReply_teamId_contactId_idx" ON public."WorkflowAwaitingReply" USING btree ("teamId", "contactId");

CREATE INDEX "WorkflowContactState_teamId_idx" ON public."WorkflowContactState" USING btree ("teamId");

CREATE UNIQUE INDEX "WorkflowContactState_workflowId_contactId_key" ON public."WorkflowContactState" USING btree ("workflowId", "contactId");

CREATE INDEX "WorkflowRun_status_waitUntil_idx" ON public."WorkflowRun" USING btree (status, "waitUntil");

CREATE INDEX "WorkflowRun_teamId_startedAt_idx" ON public."WorkflowRun" USING btree ("teamId", "startedAt" DESC);

CREATE INDEX "WorkflowRun_workflowId_startedAt_idx" ON public."WorkflowRun" USING btree ("workflowId", "startedAt" DESC);

CREATE UNIQUE INDEX "Workflow_teamId_name_key" ON public."Workflow" USING btree ("teamId", name);

CREATE INDEX "Workflow_teamId_trigger_published_idx" ON public."Workflow" USING btree ("teamId", trigger, published);

CREATE INDEX "_AudienceGroupContacts_B_index" ON public."_AudienceGroupContacts" USING btree ("B");

CREATE INDEX "_AudienceGroupTags_B_index" ON public."_AudienceGroupTags" USING btree ("B");

CREATE INDEX "_ContactToTag_B_index" ON public."_ContactToTag" USING btree ("B");

ALTER TABLE ONLY public."Account"
    ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."ApiIdempotencyKey"
    ADD CONSTRAINT "ApiIdempotencyKey_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES public."TeamApiKey"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."AudienceGroup"
    ADD CONSTRAINT "AudienceGroup_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public."AudienceGroup"
    ADD CONSTRAINT "AudienceGroup_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."Team"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."BroadcastRecipient"
    ADD CONSTRAINT "BroadcastRecipient_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES public."Broadcast"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."BroadcastRecipient"
    ADD CONSTRAINT "BroadcastRecipient_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES public."Contact"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."Broadcast"
    ADD CONSTRAINT "Broadcast_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public."Broadcast"
    ADD CONSTRAINT "Broadcast_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."Team"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."ChannelConnection"
    ADD CONSTRAINT "ChannelConnection_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."Team"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."ContactFieldDefinition"
    ADD CONSTRAINT "ContactFieldDefinition_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."Team"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."ContactStage"
    ADD CONSTRAINT "ContactStage_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."Team"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."Contact"
    ADD CONSTRAINT "Contact_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES public."ContactStage"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public."Contact"
    ADD CONSTRAINT "Contact_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."Team"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."ConversationEvent"
    ADD CONSTRAINT "ConversationEvent_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES public."TeamApiKey"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public."ConversationEvent"
    ADD CONSTRAINT "ConversationEvent_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES public."Conversation"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."ConversationEvent"
    ADD CONSTRAINT "ConversationEvent_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."Team"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."ConversationEvent"
    ADD CONSTRAINT "ConversationEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public."Conversation"
    ADD CONSTRAINT "Conversation_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public."Conversation"
    ADD CONSTRAINT "Conversation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES public."Contact"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."Conversation"
    ADD CONSTRAINT "Conversation_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."Team"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."InternalNote"
    ADD CONSTRAINT "InternalNote_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public."InternalNote"
    ADD CONSTRAINT "InternalNote_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES public."Conversation"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."InternalNote"
    ADD CONSTRAINT "InternalNote_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."Team"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."Invite"
    ADD CONSTRAINT "Invite_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public."Invite"
    ADD CONSTRAINT "Invite_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."Team"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."MessageTemplate"
    ADD CONSTRAINT "MessageTemplate_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."Team"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."Message"
    ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES public."Conversation"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."Message"
    ADD CONSTRAINT "Message_replyToMessageId_fkey" FOREIGN KEY ("replyToMessageId") REFERENCES public."Message"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public."Message"
    ADD CONSTRAINT "Message_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public."Message"
    ADD CONSTRAINT "Message_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."Team"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."OutboundEvent"
    ADD CONSTRAINT "OutboundEvent_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."Team"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."OutboundSendAttempt"
    ADD CONSTRAINT "OutboundSendAttempt_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."Team"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."OutboundWebhookDelivery"
    ADD CONSTRAINT "OutboundWebhookDelivery_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES public."OutboundWebhook"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."OutboundWebhook"
    ADD CONSTRAINT "OutboundWebhook_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."Team"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."Session"
    ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."Snippet"
    ADD CONSTRAINT "Snippet_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public."Snippet"
    ADD CONSTRAINT "Snippet_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."Team"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."Tag"
    ADD CONSTRAINT "Tag_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."Team"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."TeamApiKey"
    ADD CONSTRAINT "TeamApiKey_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."Team"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."TeamChannelMember"
    ADD CONSTRAINT "TeamChannelMember_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public."TeamChannelMember"
    ADD CONSTRAINT "TeamChannelMember_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES public."TeamChannel"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."TeamChannelMember"
    ADD CONSTRAINT "TeamChannelMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."TeamChannelMention"
    ADD CONSTRAINT "TeamChannelMention_mentionedUserId_fkey" FOREIGN KEY ("mentionedUserId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."TeamChannelMention"
    ADD CONSTRAINT "TeamChannelMention_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES public."TeamChannelMessage"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."TeamChannelMessage"
    ADD CONSTRAINT "TeamChannelMessage_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public."TeamChannelMessage"
    ADD CONSTRAINT "TeamChannelMessage_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES public."TeamChannel"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."TeamChannelMessage"
    ADD CONSTRAINT "TeamChannelMessage_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."Team"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."TeamChannelMessage"
    ADD CONSTRAINT "TeamChannelMessage_threadRootId_fkey" FOREIGN KEY ("threadRootId") REFERENCES public."TeamChannelMessage"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."TeamChannelPin"
    ADD CONSTRAINT "TeamChannelPin_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES public."TeamChannel"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."TeamChannelPin"
    ADD CONSTRAINT "TeamChannelPin_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES public."TeamChannelMessage"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."TeamChannelPin"
    ADD CONSTRAINT "TeamChannelPin_pinnedById_fkey" FOREIGN KEY ("pinnedById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public."TeamChannelReaction"
    ADD CONSTRAINT "TeamChannelReaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES public."TeamChannelMessage"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."TeamChannelReaction"
    ADD CONSTRAINT "TeamChannelReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."TeamChannelReadReceipt"
    ADD CONSTRAINT "TeamChannelReadReceipt_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES public."TeamChannel"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."TeamChannelReadReceipt"
    ADD CONSTRAINT "TeamChannelReadReceipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."TeamChannel"
    ADD CONSTRAINT "TeamChannel_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public."TeamChannel"
    ADD CONSTRAINT "TeamChannel_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."Team"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."User"
    ADD CONSTRAINT "User_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."Team"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."WorkflowAwaitingReply"
    ADD CONSTRAINT "WorkflowAwaitingReply_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES public."Contact"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."WorkflowAwaitingReply"
    ADD CONSTRAINT "WorkflowAwaitingReply_runId_fkey" FOREIGN KEY ("runId") REFERENCES public."WorkflowRun"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."WorkflowAwaitingReply"
    ADD CONSTRAINT "WorkflowAwaitingReply_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."Team"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."WorkflowAwaitingReply"
    ADD CONSTRAINT "WorkflowAwaitingReply_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES public."Workflow"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."WorkflowContactState"
    ADD CONSTRAINT "WorkflowContactState_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."Team"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."WorkflowContactState"
    ADD CONSTRAINT "WorkflowContactState_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES public."Workflow"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."WorkflowRun"
    ADD CONSTRAINT "WorkflowRun_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."Team"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."WorkflowRun"
    ADD CONSTRAINT "WorkflowRun_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES public."Workflow"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."Workflow"
    ADD CONSTRAINT "Workflow_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."Team"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."_AudienceGroupContacts"
    ADD CONSTRAINT "_AudienceGroupContacts_A_fkey" FOREIGN KEY ("A") REFERENCES public."AudienceGroup"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."_AudienceGroupContacts"
    ADD CONSTRAINT "_AudienceGroupContacts_B_fkey" FOREIGN KEY ("B") REFERENCES public."Contact"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."_AudienceGroupTags"
    ADD CONSTRAINT "_AudienceGroupTags_A_fkey" FOREIGN KEY ("A") REFERENCES public."AudienceGroup"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."_AudienceGroupTags"
    ADD CONSTRAINT "_AudienceGroupTags_B_fkey" FOREIGN KEY ("B") REFERENCES public."Tag"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."_ContactToTag"
    ADD CONSTRAINT "_ContactToTag_A_fkey" FOREIGN KEY ("A") REFERENCES public."Contact"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."_ContactToTag"
    ADD CONSTRAINT "_ContactToTag_B_fkey" FOREIGN KEY ("B") REFERENCES public."Tag"(id) ON UPDATE CASCADE ON DELETE CASCADE;


-- ---------------------------------------------------------------------------
-- Partial indexes — referenced by schema.prisma but lost in the prior squash.
-- Re-added in squash #2.
-- ---------------------------------------------------------------------------

-- Powers "what was the contact's last inbound?" lookups (24h-window UI +
-- lastInboundAt drift sweeper) without scanning outbound rows. Prisma DSL
-- can't express `WHERE direction = 'in'`.
CREATE INDEX "Message_conversationId_timestamp_inbound_idx"
  ON public."Message" USING btree ("conversationId", "timestamp" DESC)
  WHERE (direction = 'in'::public."MessageDirection");

-- Team-chat channel feed keyset: WHERE channelId = ? AND threadRootId IS NULL
-- ORDER BY createdAt DESC, id DESC. Prisma DSL can't express the partial
-- predicate; the unfiltered (channelId, createdAt DESC, id DESC) index that
-- @@index emits covers thread-reply scans but isn't selective enough for the
-- top-level feed in busy channels.
CREATE INDEX "TeamChannelMessage_channel_toplevel_keyset_idx"
  ON public."TeamChannelMessage" USING btree ("channelId", "createdAt" DESC, id DESC)
  WHERE ("threadRootId" IS NULL);
