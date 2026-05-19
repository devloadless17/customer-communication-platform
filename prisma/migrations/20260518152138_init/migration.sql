-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "plpgsql";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('superAdmin', 'admin', 'manager', 'agent');

-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('free', 'starter', 'advanced', 'enterprise');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('open', 'pending', 'closed');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('in', 'out');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('sent', 'delivered', 'read', 'failed');

-- CreateEnum
CREATE TYPE "ProviderName" AS ENUM ('meta_cloud');

-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('approved', 'pending', 'rejected', 'paused', 'disabled');

-- CreateEnum
CREATE TYPE "TemplateCategory" AS ENUM ('marketing', 'utility', 'authentication');

-- CreateEnum
CREATE TYPE "BroadcastStatus" AS ENUM ('queued', 'running', 'completed', 'failed', 'canceled');

-- CreateEnum
CREATE TYPE "BroadcastRecipientStatus" AS ENUM ('queued', 'sent', 'failed');

-- CreateEnum
CREATE TYPE "ContactSource" AS ENUM ('inbound', 'manual');

-- CreateEnum
CREATE TYPE "ConversationEventKind" AS ENUM ('assigned', 'status_changed', 'tag_added', 'tag_removed', 'note_added', 'note_deleted');

-- CreateEnum
CREATE TYPE "WorkflowTriggerEvent" AS ENUM ('message_received', 'conversation_created', 'conversation_opened', 'conversation_closed', 'conversation_assigned', 'conversation_status_changed', 'contact_field_updated', 'contact_tag_updated', 'contact_lifecycle_updated', 'manual_trigger', 'incoming_webhook');

-- CreateEnum
CREATE TYPE "WorkflowStepType" AS ENUM ('send_message', 'send_template', 'add_comment', 'assign_to', 'set_status', 'open_conversation', 'close_conversation', 'add_tag', 'remove_tag', 'update_field', 'update_lifecycle', 'branch', 'wait', 'jump_to_step', 'http_request', 'trigger_workflow');

-- CreateEnum
CREATE TYPE "WorkflowRunStatus" AS ENUM ('queued', 'running', 'waiting', 'completed', 'failed', 'skipped');

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "plan" "Plan" NOT NULL DEFAULT 'starter',
    "metaPhoneNumberId" TEXT,
    "metaDisplayPhoneNumber" TEXT,
    "metaWabaId" TEXT,
    "metaAccessToken" TEXT,
    "metaAppSecret" TEXT,
    "metaVerifyToken" TEXT,
    "metaAppId" TEXT,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'agent',
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT true,
    "avatarUrl" TEXT,
    "deactivatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Snippet" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Snippet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "phoneNumber" TEXT,
    "identityProvider" "ProviderName",
    "externalContactId" TEXT,
    "name" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "language" TEXT,
    "countryCode" TEXT,
    "assignedUserId" TEXT,
    "avatarUrl" TEXT,
    "email" TEXT,
    "location" TEXT,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "stageId" TEXT,
    "source" "ContactSource" NOT NULL DEFAULT 'inbound',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastInboundAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactStage" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'slate',
    "position" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactFieldDefinition" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactFieldDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "assignedUserId" TEXT,
    "status" "ConversationStatus" NOT NULL DEFAULT 'pending',
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessagePreview" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstAssignedAt" TIMESTAMP(3),
    "firstAssignedUserId" TEXT,
    "lastAssignedAt" TIMESTAMP(3),
    "firstResponseAt" TIMESTAMP(3),
    "firstResponseByUserId" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedByUserId" TEXT,
    "closedCategory" TEXT,
    "closedSummary" TEXT,
    "assignmentsCount" INTEGER NOT NULL DEFAULT 0,
    "incomingMessagesCount" INTEGER NOT NULL DEFAULT 0,
    "outgoingMessagesCount" INTEGER NOT NULL DEFAULT 0,
    "responsesCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "senderUserId" TEXT,
    "body" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "provider" "ProviderName" NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'sent',
    "rawPayload" JSONB NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mediaKind" TEXT,
    "mediaKey" TEXT,
    "mediaUrl" TEXT,
    "mediaMimeType" TEXT,
    "mediaCaption" TEXT,
    "mediaFilename" TEXT,
    "mediaSizeBytes" INTEGER,
    "mediaDurationMs" INTEGER,
    "mediaThumbnailKey" TEXT,
    "mediaThumbnailUrl" TEXT,
    "replyToMessageId" TEXT,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invite" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'agent',
    "tokenHash" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageTemplate" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "externalId" TEXT,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "category" "TemplateCategory" NOT NULL,
    "status" "TemplateStatus" NOT NULL,
    "bodyText" TEXT NOT NULL DEFAULT '',
    "components" JSONB NOT NULL,
    "variableBindings" JSONB NOT NULL DEFAULT '{}',
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'slate',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudienceGroup" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudienceGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Broadcast" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "createdById" TEXT,
    "status" "BroadcastStatus" NOT NULL DEFAULT 'queued',
    "templateId" TEXT NOT NULL,
    "templateName" TEXT NOT NULL,
    "templateLanguage" TEXT NOT NULL,
    "variables" JSONB NOT NULL,
    "audienceMode" TEXT NOT NULL,
    "audienceTagIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "audienceGroupId" TEXT,
    "audienceGroupName" TEXT,
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Broadcast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BroadcastRecipient" (
    "id" TEXT NOT NULL,
    "broadcastId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "conversationId" TEXT,
    "status" "BroadcastRecipientStatus" NOT NULL DEFAULT 'queued',
    "externalId" TEXT,
    "errorMessage" TEXT,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "BroadcastRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InternalNote" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "authorUserId" TEXT,
    "body" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InternalNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workflow" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "trigger" "WorkflowTriggerEvent" NOT NULL,
    "triggerConfig" JSONB NOT NULL DEFAULT '{}',
    "triggerConditions" JSONB NOT NULL DEFAULT '{"op":"AND","children":[]}',
    "triggerOncePerContact" BOOLEAN NOT NULL DEFAULT false,
    "graph" JSONB NOT NULL DEFAULT '{"startNodeId":"","nodes":[],"edges":[]}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowRun" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "status" "WorkflowRunStatus" NOT NULL DEFAULT 'queued',
    "trigger" "WorkflowTriggerEvent" NOT NULL,
    "contactId" TEXT,
    "conversationId" TEXT,
    "eventPayload" JSONB NOT NULL,
    "currentStepId" TEXT,
    "waitUntil" TIMESTAMP(3),
    "jumpsUsed" INTEGER NOT NULL DEFAULT 0,
    "stepLog" JSONB NOT NULL DEFAULT '[]',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "WorkflowRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowContactState" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "firedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowContactState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamApiKey" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "scopes" TEXT[] DEFAULT ARRAY['*']::TEXT[],

    CONSTRAINT "TeamApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiIdempotencyKey" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "responseBody" JSONB NOT NULL,
    "responseStatus" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiIdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundWebhook" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "eventTypes" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastDeliveredAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "lastErrorMessage" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "disabledAt" TIMESTAMP(3),
    "disabledReason" TEXT,

    CONSTRAINT "OutboundWebhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundWebhookDelivery" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "deliveredAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboundWebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationReadReceipt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationReadReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationEvent" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT,
    "apiKeyId" TEXT,
    "kind" "ConversationEventKind" NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamChannel" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessagePreview" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "TeamChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamChannelMessage" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "authorUserId" TEXT,
    "body" TEXT NOT NULL,
    "mediaKind" TEXT,
    "mediaKey" TEXT,
    "mediaUrl" TEXT,
    "mediaMimeType" TEXT,
    "mediaCaption" TEXT,
    "mediaFilename" TEXT,
    "mediaSizeBytes" INTEGER,
    "mediaDurationMs" INTEGER,
    "editedAt" TIMESTAMP(3),
    "threadRootId" TEXT,
    "threadReplyCount" INTEGER NOT NULL DEFAULT 0,
    "threadLastReplyAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamChannelMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamChannelMention" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "mentionedUserId" TEXT NOT NULL,

    CONSTRAINT "TeamChannelMention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamChannelReaction" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamChannelReaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamChannelPin" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "pinnedById" TEXT,
    "pinnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamChannelPin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamChannelReadReceipt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamChannelReadReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "email" TEXT NOT NULL,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastFailedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("email")
);

-- CreateTable
CREATE TABLE "OutboundEvent" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "OutboundEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_ContactToTag" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_ContactToTag_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_AudienceGroupTags" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_AudienceGroupTags_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_AudienceGroupContacts" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_AudienceGroupContacts_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "Team_metaPhoneNumberId_key" ON "Team"("metaPhoneNumberId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_teamId_idx" ON "User"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_providerId_accountId_key" ON "Account"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "Verification_identifier_idx" ON "Verification"("identifier");

-- CreateIndex
CREATE INDEX "Snippet_teamId_label_idx" ON "Snippet"("teamId", "label");

-- CreateIndex
CREATE UNIQUE INDEX "Snippet_teamId_name_key" ON "Snippet"("teamId", "name");

-- CreateIndex
CREATE INDEX "Contact_teamId_idx" ON "Contact"("teamId");

-- CreateIndex
CREATE INDEX "Contact_teamId_source_idx" ON "Contact"("teamId", "source");

-- CreateIndex
CREATE INDEX "Contact_teamId_stageId_idx" ON "Contact"("teamId", "stageId");

-- CreateIndex
CREATE INDEX "Contact_teamId_assignedUserId_idx" ON "Contact"("teamId", "assignedUserId");

-- CreateIndex
CREATE INDEX "Contact_teamId_lastInboundAt_idx" ON "Contact"("teamId", "lastInboundAt" DESC);

-- CreateIndex
CREATE INDEX "Contact_name_trgm_idx" ON "Contact" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "Contact_teamId_phoneNumber_key" ON "Contact"("teamId", "phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_teamId_identityProvider_externalContactId_key" ON "Contact"("teamId", "identityProvider", "externalContactId");

-- CreateIndex
CREATE INDEX "ContactStage_teamId_position_idx" ON "ContactStage"("teamId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ContactStage_teamId_name_key" ON "ContactStage"("teamId", "name");

-- CreateIndex
CREATE INDEX "ContactFieldDefinition_teamId_order_idx" ON "ContactFieldDefinition"("teamId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "ContactFieldDefinition_teamId_key_key" ON "ContactFieldDefinition"("teamId", "key");

-- CreateIndex
CREATE INDEX "Conversation_teamId_status_lastMessageAt_idx" ON "Conversation"("teamId", "status", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "Conversation_teamId_assignedUserId_idx" ON "Conversation"("teamId", "assignedUserId");

-- CreateIndex
CREATE INDEX "Conversation_teamId_lastMessageAt_id_idx" ON "Conversation"("teamId", "lastMessageAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Conversation_teamId_contactId_idx" ON "Conversation"("teamId", "contactId");

-- CreateIndex
CREATE INDEX "Conversation_lastMessagePreview_trgm_idx" ON "Conversation" USING GIN ("lastMessagePreview" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Message_conversationId_timestamp_idx" ON "Message"("conversationId", "timestamp");

-- CreateIndex
CREATE INDEX "Message_teamId_idx" ON "Message"("teamId");

-- CreateIndex
CREATE INDEX "Message_replyToMessageId_idx" ON "Message"("replyToMessageId");

-- CreateIndex
CREATE INDEX "Message_conversationId_timestamp_id_idx" ON "Message"("conversationId", "timestamp" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Message_teamId_provider_externalId_key" ON "Message"("teamId", "provider", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Invite_tokenHash_key" ON "Invite"("tokenHash");

-- CreateIndex
CREATE INDEX "Invite_teamId_email_idx" ON "Invite"("teamId", "email");

-- CreateIndex
CREATE INDEX "MessageTemplate_teamId_status_idx" ON "MessageTemplate"("teamId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MessageTemplate_teamId_name_language_key" ON "MessageTemplate"("teamId", "name", "language");

-- CreateIndex
CREATE INDEX "Tag_teamId_idx" ON "Tag"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_teamId_name_key" ON "Tag"("teamId", "name");

-- CreateIndex
CREATE INDEX "AudienceGroup_teamId_idx" ON "AudienceGroup"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "AudienceGroup_teamId_name_key" ON "AudienceGroup"("teamId", "name");

-- CreateIndex
CREATE INDEX "Broadcast_teamId_createdAt_idx" ON "Broadcast"("teamId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Broadcast_teamId_status_idx" ON "Broadcast"("teamId", "status");

-- CreateIndex
CREATE INDEX "BroadcastRecipient_broadcastId_status_idx" ON "BroadcastRecipient"("broadcastId", "status");

-- CreateIndex
CREATE INDEX "BroadcastRecipient_contactId_idx" ON "BroadcastRecipient"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "BroadcastRecipient_broadcastId_contactId_key" ON "BroadcastRecipient"("broadcastId", "contactId");

-- CreateIndex
CREATE INDEX "InternalNote_conversationId_timestamp_idx" ON "InternalNote"("conversationId", "timestamp");

-- CreateIndex
CREATE INDEX "Workflow_teamId_trigger_enabled_published_idx" ON "Workflow"("teamId", "trigger", "enabled", "published");

-- CreateIndex
CREATE UNIQUE INDEX "Workflow_teamId_name_key" ON "Workflow"("teamId", "name");

-- CreateIndex
CREATE INDEX "WorkflowRun_workflowId_startedAt_idx" ON "WorkflowRun"("workflowId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "WorkflowRun_teamId_startedAt_idx" ON "WorkflowRun"("teamId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "WorkflowRun_status_waitUntil_idx" ON "WorkflowRun"("status", "waitUntil");

-- CreateIndex
CREATE INDEX "WorkflowContactState_teamId_idx" ON "WorkflowContactState"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowContactState_workflowId_contactId_key" ON "WorkflowContactState"("workflowId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamApiKey_tokenHash_key" ON "TeamApiKey"("tokenHash");

-- CreateIndex
CREATE INDEX "TeamApiKey_teamId_revokedAt_idx" ON "TeamApiKey"("teamId", "revokedAt");

-- CreateIndex
CREATE INDEX "ApiIdempotencyKey_expiresAt_idx" ON "ApiIdempotencyKey"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApiIdempotencyKey_teamId_apiKeyId_key_key" ON "ApiIdempotencyKey"("teamId", "apiKeyId", "key");

-- CreateIndex
CREATE INDEX "OutboundWebhook_teamId_enabled_idx" ON "OutboundWebhook"("teamId", "enabled");

-- CreateIndex
CREATE INDEX "OutboundWebhookDelivery_webhookId_createdAt_idx" ON "OutboundWebhookDelivery"("webhookId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "OutboundWebhookDelivery_createdAt_idx" ON "OutboundWebhookDelivery"("createdAt");

-- CreateIndex
CREATE INDEX "ConversationReadReceipt_conversationId_idx" ON "ConversationReadReceipt"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationReadReceipt_userId_conversationId_key" ON "ConversationReadReceipt"("userId", "conversationId");

-- CreateIndex
CREATE INDEX "ConversationEvent_conversationId_at_idx" ON "ConversationEvent"("conversationId", "at" DESC);

-- CreateIndex
CREATE INDEX "TeamChannel_teamId_lastMessageAt_idx" ON "TeamChannel"("teamId", "lastMessageAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "TeamChannel_teamId_name_key" ON "TeamChannel"("teamId", "name");

-- CreateIndex
CREATE INDEX "TeamChannelMessage_channelId_createdAt_id_idx" ON "TeamChannelMessage"("channelId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "TeamChannelMessage_threadRootId_createdAt_idx" ON "TeamChannelMessage"("threadRootId", "createdAt");

-- CreateIndex
CREATE INDEX "TeamChannelMessage_teamId_idx" ON "TeamChannelMessage"("teamId");

-- CreateIndex
CREATE INDEX "TeamChannelMessage_body_trgm_idx" ON "TeamChannelMessage" USING GIN ("body" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "TeamChannelMention_mentionedUserId_idx" ON "TeamChannelMention"("mentionedUserId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamChannelMention_messageId_mentionedUserId_key" ON "TeamChannelMention"("messageId", "mentionedUserId");

-- CreateIndex
CREATE INDEX "TeamChannelReaction_messageId_idx" ON "TeamChannelReaction"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamChannelReaction_messageId_userId_emoji_key" ON "TeamChannelReaction"("messageId", "userId", "emoji");

-- CreateIndex
CREATE UNIQUE INDEX "TeamChannelPin_messageId_key" ON "TeamChannelPin"("messageId");

-- CreateIndex
CREATE INDEX "TeamChannelPin_channelId_pinnedAt_idx" ON "TeamChannelPin"("channelId", "pinnedAt" DESC);

-- CreateIndex
CREATE INDEX "TeamChannelReadReceipt_channelId_idx" ON "TeamChannelReadReceipt"("channelId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamChannelReadReceipt_userId_channelId_key" ON "TeamChannelReadReceipt"("userId", "channelId");

-- CreateIndex
CREATE INDEX "LoginAttempt_lockedUntil_idx" ON "LoginAttempt"("lockedUntil");

-- CreateIndex
CREATE INDEX "_ContactToTag_B_index" ON "_ContactToTag"("B");

-- CreateIndex
CREATE INDEX "_AudienceGroupTags_B_index" ON "_AudienceGroupTags"("B");

-- CreateIndex
CREATE INDEX "_AudienceGroupContacts_B_index" ON "_AudienceGroupContacts"("B");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Snippet" ADD CONSTRAINT "Snippet_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Snippet" ADD CONSTRAINT "Snippet_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "ContactStage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactStage" ADD CONSTRAINT "ContactStage_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactFieldDefinition" ADD CONSTRAINT "ContactFieldDefinition_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_replyToMessageId_fkey" FOREIGN KEY ("replyToMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudienceGroup" ADD CONSTRAINT "AudienceGroup_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudienceGroup" ADD CONSTRAINT "AudienceGroup_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Broadcast" ADD CONSTRAINT "Broadcast_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Broadcast" ADD CONSTRAINT "Broadcast_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BroadcastRecipient" ADD CONSTRAINT "BroadcastRecipient_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "Broadcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BroadcastRecipient" ADD CONSTRAINT "BroadcastRecipient_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalNote" ADD CONSTRAINT "InternalNote_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalNote" ADD CONSTRAINT "InternalNote_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowContactState" ADD CONSTRAINT "WorkflowContactState_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowContactState" ADD CONSTRAINT "WorkflowContactState_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamApiKey" ADD CONSTRAINT "TeamApiKey_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiIdempotencyKey" ADD CONSTRAINT "ApiIdempotencyKey_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "TeamApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundWebhook" ADD CONSTRAINT "OutboundWebhook_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundWebhookDelivery" ADD CONSTRAINT "OutboundWebhookDelivery_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "OutboundWebhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationReadReceipt" ADD CONSTRAINT "ConversationReadReceipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationReadReceipt" ADD CONSTRAINT "ConversationReadReceipt_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationEvent" ADD CONSTRAINT "ConversationEvent_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationEvent" ADD CONSTRAINT "ConversationEvent_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationEvent" ADD CONSTRAINT "ConversationEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationEvent" ADD CONSTRAINT "ConversationEvent_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "TeamApiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChannel" ADD CONSTRAINT "TeamChannel_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChannel" ADD CONSTRAINT "TeamChannel_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChannelMessage" ADD CONSTRAINT "TeamChannelMessage_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "TeamChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChannelMessage" ADD CONSTRAINT "TeamChannelMessage_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChannelMessage" ADD CONSTRAINT "TeamChannelMessage_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChannelMessage" ADD CONSTRAINT "TeamChannelMessage_threadRootId_fkey" FOREIGN KEY ("threadRootId") REFERENCES "TeamChannelMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChannelMention" ADD CONSTRAINT "TeamChannelMention_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "TeamChannelMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChannelMention" ADD CONSTRAINT "TeamChannelMention_mentionedUserId_fkey" FOREIGN KEY ("mentionedUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChannelReaction" ADD CONSTRAINT "TeamChannelReaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "TeamChannelMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChannelReaction" ADD CONSTRAINT "TeamChannelReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChannelPin" ADD CONSTRAINT "TeamChannelPin_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "TeamChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChannelPin" ADD CONSTRAINT "TeamChannelPin_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "TeamChannelMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChannelPin" ADD CONSTRAINT "TeamChannelPin_pinnedById_fkey" FOREIGN KEY ("pinnedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChannelReadReceipt" ADD CONSTRAINT "TeamChannelReadReceipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChannelReadReceipt" ADD CONSTRAINT "TeamChannelReadReceipt_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "TeamChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundEvent" ADD CONSTRAINT "OutboundEvent_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ContactToTag" ADD CONSTRAINT "_ContactToTag_A_fkey" FOREIGN KEY ("A") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ContactToTag" ADD CONSTRAINT "_ContactToTag_B_fkey" FOREIGN KEY ("B") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AudienceGroupTags" ADD CONSTRAINT "_AudienceGroupTags_A_fkey" FOREIGN KEY ("A") REFERENCES "AudienceGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AudienceGroupTags" ADD CONSTRAINT "_AudienceGroupTags_B_fkey" FOREIGN KEY ("B") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AudienceGroupContacts" ADD CONSTRAINT "_AudienceGroupContacts_A_fkey" FOREIGN KEY ("A") REFERENCES "AudienceGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AudienceGroupContacts" ADD CONSTRAINT "_AudienceGroupContacts_B_fkey" FOREIGN KEY ("B") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Partial / expression indexes (raw SQL because Prisma can't model them).
-- The schema comments reference these by their pre-consolidation migration
-- filenames; they live here now after the init consolidation.
-- ---------------------------------------------------------------------------

-- Contact.customFields JSONB containment lookups (settings/contact-fields
-- filters, /v1 contact search). Without this the planner seqscans Contact.
CREATE INDEX "Contact_customFields_gin_idx" ON "Contact" USING GIN ("customFields" jsonb_path_ops);

-- At-most-one default ContactStage per team. Cheap partial unique that the
-- app-code pre-check still wraps with a friendlier 4xx, but this is the
-- backstop preventing two concurrent admin clicks from leaving two defaults.
CREATE UNIQUE INDEX "ContactStage_teamId_isDefault_key" ON "ContactStage"("teamId") WHERE "isDefault" = true;

-- Inbound-only Message lookups: "what was the contact's last inbound?"
-- (24h-window UI, lastInboundAt drift sweeper, getConversationWithRefs).
-- Skips outbound rows so the working set stays small on chatty conversations.
CREATE INDEX "Message_conversationId_timestamp_inbound_idx" ON "Message"("conversationId", "timestamp" DESC) WHERE "direction" = 'in';

-- Channel feed keyset: WHERE channelId = ? AND threadRootId IS NULL
-- ORDER BY createdAt DESC, id DESC. Top-level messages only; thread replies
-- ride the full (threadRootId, createdAt) index above.
CREATE INDEX "TeamChannelMessage_channel_toplevel_keyset_idx" ON "TeamChannelMessage"("channelId", "createdAt" DESC, "id" DESC) WHERE "threadRootId" IS NULL;

-- OutboundEvent drainer hot path: pending rows (publishedAt IS NULL AND
-- failedAt IS NULL) ORDER BY createdAt ASC. The drainer polls this set;
-- a partial keeps the index tiny (steady-state ≈ in-flight events only).
CREATE INDEX "OutboundEvent_drainer_pending_idx" ON "OutboundEvent"("createdAt") WHERE "publishedAt" IS NULL AND "failedAt" IS NULL;
