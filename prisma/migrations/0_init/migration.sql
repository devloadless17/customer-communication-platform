-- ============================================================================
-- BASELINE — the whole schema as one migration.
--
-- Squashed on 2026-07-24, pre-launch, from the 106 incremental migrations that
-- came before it. Those described how the schema was BUILT (including the
-- org->workspace rename and its fallout); this file describes what it IS. The
-- history is in git if it is ever needed.
--
-- Everything above the "hand-maintained" section below is generated:
--     prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
-- Regenerating it is safe. The section BELOW it is not generated and must be
-- carried by hand on every regeneration — see the warning there.
-- ============================================================================

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "plpgsql";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('admin', 'manager', 'agent');

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('owner', 'admin', 'member');

-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('free', 'starter', 'advanced', 'enterprise');

-- CreateEnum
CREATE TYPE "OrgStatus" AS ENUM ('pending', 'active', 'suspended');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('open', 'pending', 'closed');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('in', 'out');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('sent', 'delivered', 'read', 'failed');

-- CreateEnum
CREATE TYPE "MessageFlagStatus" AS ENUM ('open', 'resolved', 'dismissed');

-- CreateEnum
CREATE TYPE "MessageOrigin" AS ENUM ('api', 'business_app');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('whatsapp', 'messenger', 'instagram', 'telegram', 'email', 'sms', 'webchatwidget');

-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('approved', 'pending', 'rejected', 'paused', 'disabled', 'archived');

-- CreateEnum
CREATE TYPE "TemplateCategory" AS ENUM ('marketing', 'utility', 'authentication');

-- CreateEnum
CREATE TYPE "BroadcastStatus" AS ENUM ('scheduled', 'materializing', 'queued', 'running', 'completed', 'failed', 'canceled', 'paused');

-- CreateEnum
CREATE TYPE "BroadcastRecipientStatus" AS ENUM ('queued', 'sent', 'failed');

-- CreateEnum
CREATE TYPE "BroadcastDeliveryState" AS ENUM ('pending', 'failed_at_send', 'sent', 'delivered', 'read', 'undelivered', 'held');

-- CreateEnum
CREATE TYPE "BroadcastKind" AS ENUM ('template', 'freeform');

-- CreateEnum
CREATE TYPE "BroadcastTargetMode" AS ENUM ('contact', 'customer');

-- CreateEnum
CREATE TYPE "ContactSource" AS ENUM ('inbound', 'manual');

-- CreateEnum
CREATE TYPE "ConversationEventKind" AS ENUM ('assigned', 'status_changed', 'tag_added', 'tag_removed', 'stage_changed', 'note_added', 'note_deleted', 'flag_added', 'flag_reopened', 'flag_resolved', 'flag_removed', 'visitor_started_conversation', 'ai_paused', 'ai_resumed', 'call_completed', 'call_missed', 'call_rejected', 'call_failed', 'ticket_opened', 'ticket_solved', 'ticket_reopened', 'ticket_closed');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('ringing', 'in_progress', 'completed', 'missed', 'rejected', 'failed');

-- CreateEnum
CREATE TYPE "CallDirection" AS ENUM ('in', 'out');

-- CreateEnum
CREATE TYPE "CallPermissionStatus" AS ENUM ('pending', 'granted', 'denied');

-- CreateEnum
CREATE TYPE "WorkflowTriggerEvent" AS ENUM ('message_received', 'conversation_created', 'conversation_opened', 'conversation_closed', 'conversation_assigned', 'conversation_status_changed', 'contact_field_updated', 'contact_tag_updated', 'contact_lifecycle_updated', 'manual_trigger', 'incoming_webhook');

-- CreateEnum
CREATE TYPE "WorkflowStepType" AS ENUM ('send_message', 'send_template', 'add_comment', 'assign_to', 'set_status', 'open_conversation', 'close_conversation', 'add_tag', 'remove_tag', 'update_field', 'update_lifecycle', 'branch', 'wait', 'jump_to_step', 'noop', 'ask_question', 'create_ticket', 'set_ticket_status', 'set_ticket_priority', 'assign_ticket', 'http_request', 'trigger_workflow');

-- CreateEnum
CREATE TYPE "WorkflowRunStatus" AS ENUM ('queued', 'running', 'waiting', 'completed', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "AiHandoffAction" AS ENUM ('none', 'unassign', 'assign_fixed', 'round_robin');

-- CreateEnum
CREATE TYPE "FirstTouchGreeter" AS ENUM ('ai', 'workflow');

-- CreateEnum
CREATE TYPE "CustomerIdentityAction" AS ENUM ('link', 'unlink');

-- CreateEnum
CREATE TYPE "ContactTransferKind" AS ENUM ('import', 'export');

-- CreateEnum
CREATE TYPE "ContactTransferFormat" AS ENUM ('csv', 'xlsx');

-- CreateEnum
CREATE TYPE "ContactTransferStatus" AS ENUM ('pending', 'running', 'completed', 'failed', 'canceled');

-- CreateEnum
CREATE TYPE "InboxViewVisibility" AS ENUM ('personal', 'shared');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('new', 'open', 'pending', 'on_hold', 'solved', 'closed');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('low', 'normal', 'high', 'urgent');

-- CreateEnum
CREATE TYPE "TicketEventKind" AS ENUM ('created', 'assigned', 'unassigned', 'team_changed', 'note', 'status_changed', 'priority_changed', 'subject_changed', 'tag_added', 'tag_removed', 'field_changed', 'sla_breached', 'reopened', 'merged');

-- CreateEnum
CREATE TYPE "TeamChannelKind" AS ENUM ('channel', 'dm');

-- CreateEnum
CREATE TYPE "TeamChannelVisibility" AS ENUM ('public', 'private');

-- CreateEnum
CREATE TYPE "AiAutoReplyMode" AS ENUM ('auto_send', 'draft', 'hybrid');

-- CreateEnum
CREATE TYPE "AiLanguagePolicy" AS ENUM ('match_customer', 'default_language', 'specific');

-- CreateEnum
CREATE TYPE "AiReplyChannelMode" AS ENUM ('text', 'voice', 'match_customer', 'text_and_voice');

-- CreateEnum
CREATE TYPE "AiContextDocStatus" AS ENUM ('processing', 'ready', 'failed', 'disabled');

-- CreateEnum
CREATE TYPE "AiConvAutomationState" AS ENUM ('ai_active', 'human_active', 'ai_paused', 'disabled');

-- CreateEnum
CREATE TYPE "AiAutomationOwner" AS ENUM ('native_ai', 'autopilot', 'workflow');

-- CreateEnum
CREATE TYPE "AiMemoryKind" AS ENUM ('preferred_language', 'dialect', 'script', 'tone', 'communication_style', 'interest', 'recurring_need', 'preference');

-- CreateEnum
CREATE TYPE "AiMemoryStatus" AS ENUM ('candidate', 'confirmed', 'rejected', 'superseded');

-- CreateEnum
CREATE TYPE "AiMemorySource" AS ENUM ('system', 'agent');

-- CreateEnum
CREATE TYPE "AiInteractionDecision" AS ENUM ('replied', 'suggested', 'skipped', 'escalated', 'cancelled', 'failed');

-- CreateEnum
CREATE TYPE "AiSuggestionState" AS ENUM ('pending', 'accepted', 'edited', 'rejected', 'expired', 'superseded');

-- CreateEnum
CREATE TYPE "AiTranscriptionStatus" AS ENUM ('pending', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "AssignmentStrategy" AS ENUM ('round_robin', 'least_busy', 'weighted', 'fixed', 'manual');

-- CreateEnum
CREATE TYPE "AssignmentEligibility" AS ENUM ('online_first', 'online_only', 'available_only', 'any_active');

-- CreateEnum
CREATE TYPE "AssignmentOverflow" AS ENUM ('leave_unassigned', 'ignore_capacity', 'fallback_user');

-- CreateEnum
CREATE TYPE "BroadcastAssignmentMode" AS ENUM ('none', 'fixed', 'split_counts', 'split_percent', 'policy');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isPlatform" BOOLEAN NOT NULL DEFAULT false,
    "plan" "Plan" NOT NULL DEFAULT 'starter',
    "maxWorkspaces" INTEGER NOT NULL DEFAULT 2,
    "status" "OrgStatus" NOT NULL DEFAULT 'pending',
    "statusReason" TEXT,
    "statusUpdatedAt" TIMESTAMP(3),
    "statusUpdatedById" TEXT,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organizationId" TEXT NOT NULL,
    "contactPanelBuiltins" JSONB NOT NULL DEFAULT '{}',
    "rolePermissions" JSONB NOT NULL DEFAULT '{}',
    "workHours" JSONB,
    "agentConversationVisibility" TEXT NOT NULL DEFAULT 'team',
    "aiAutopilotEnabled" BOOLEAN NOT NULL DEFAULT false,
    "aiHandoffAction" "AiHandoffAction" NOT NULL DEFAULT 'none',
    "aiHandoffAssigneeId" TEXT,
    "aiRoundRobinCursorUserId" TEXT,
    "firstTouchGreeter" "FirstTouchGreeter" NOT NULL DEFAULT 'ai',
    "ticketAutoOpen" BOOLEAN NOT NULL DEFAULT false,
    "ticketReopenWindowHours" INTEGER NOT NULL DEFAULT 72,
    "ticketCloseConversationOnLastSolved" BOOLEAN NOT NULL DEFAULT false,
    "maxMembers" INTEGER NOT NULL DEFAULT 2,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMember" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'agent',
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "externalAccountId" TEXT NOT NULL DEFAULT '',
    "label" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "wabaId" TEXT,
    "portfolioId" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secrets" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "insightsEnabledAt" TIMESTAMP(3),
    "needsReconnect" BOOLEAN NOT NULL DEFAULT false,
    "lastAuthErrorAt" TIMESTAMP(3),
    "qualityRating" TEXT,
    "throughputLevel" TEXT,
    "messagingHealthUpdatedAt" TIMESTAMP(3),
    "callingRestrictedUntil" TIMESTAMP(3),
    "callingRestrictionType" TEXT,
    "callingRestrictionReason" TEXT,
    "callingQualityWarning" TEXT,
    "policyViolationType" TEXT,
    "policyViolationAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappPortfolio" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "externalPortfolioId" TEXT,
    "messagingTier" TEXT,
    "messagingDailyCap" INTEGER,
    "verificationStatus" TEXT,
    "messagingHealthUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappPortfolio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebchatWidget" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "allowedOrigins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "firstSeenOrigin" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebchatWidget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secrets" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "orgRole" "OrgRole" NOT NULL DEFAULT 'member',
    "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "avatarUrl" TEXT,
    "deactivatedAt" TIMESTAMP(3),
    "availabilityStatus" TEXT DEFAULT 'available',
    "availabilityMessage" TEXT,
    "availabilityManualStatus" TEXT,
    "availabilityManualMessage" TEXT,
    "availabilitySource" TEXT DEFAULT 'manual',
    "availabilitySetByUserId" TEXT,
    "availabilityOverrideUntil" TIMESTAMP(3),
    "workHoursMode" TEXT NOT NULL DEFAULT 'inherit',
    "workHours" JSONB,
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
    "activeWorkspaceId" TEXT,

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
    "workspaceId" TEXT NOT NULL,
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
    "workspaceId" TEXT NOT NULL,
    "phoneNumber" TEXT,
    "identityChannel" "Channel" NOT NULL,
    "externalContactId" TEXT,
    "bsuid" TEXT,
    "username" TEXT,
    "name" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "language" TEXT,
    "countryCode" TEXT,
    "avatarUrl" TEXT,
    "socialProfile" JSONB,
    "email" TEXT,
    "location" TEXT,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "stageId" TEXT,
    "customerId" TEXT,
    "source" "ContactSource" NOT NULL DEFAULT 'inbound',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastInboundAt" TIMESTAMP(3),
    "marketingOptOutAt" TIMESTAMP(3),
    "marketingCapReachedAt" TIMESTAMP(3),
    "marketingOptOutSource" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    "callPermissionRevokedUntil" TIMESTAMP(3),
    "consecutiveUnansweredOutCalls" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerIdentityEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "action" "CustomerIdentityAction" NOT NULL,
    "fromCustomerId" TEXT,
    "fromCustomerName" TEXT,
    "toCustomerId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerIdentityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactStage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
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
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactFieldDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactTransferJob" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" "ContactTransferKind" NOT NULL,
    "format" "ContactTransferFormat" NOT NULL,
    "status" "ContactTransferStatus" NOT NULL DEFAULT 'pending',
    "createdByUserId" TEXT,
    "filename" TEXT NOT NULL,
    "sourceKey" TEXT,
    "artifactKey" TEXT,
    "errorArtifactKey" TEXT,
    "artifactBytes" INTEGER,
    "options" JSONB NOT NULL DEFAULT '{}',
    "totalRows" INTEGER,
    "processedRows" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "revived" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "automationsSkipped" BOOLEAN NOT NULL DEFAULT false,
    "errorSample" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "heartbeatAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactTransferJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL DEFAULT 'whatsapp',
    "webchatWidgetId" TEXT,
    "channelConnectionId" TEXT,
    "assignedUserId" TEXT,
    "lastAssignedUserId" TEXT,
    "status" "ConversationStatus" NOT NULL DEFAULT 'pending',
    "aiEnabled" BOOLEAN NOT NULL DEFAULT true,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessagePreview" TEXT NOT NULL DEFAULT '',
    "lastMessageDirection" "MessageDirection",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstAssignedAt" TIMESTAMP(3),
    "firstAssignedUserId" TEXT,
    "lastAssignedAt" TIMESTAMP(3),
    "firstResponseAt" TIMESTAMP(3),
    "firstResponseByUserId" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedByUserId" TEXT,
    "closedByApiKeyId" TEXT,
    "closedCategory" TEXT,
    "closedSummary" TEXT,
    "assignmentsCount" INTEGER NOT NULL DEFAULT 0,
    "incomingMessagesCount" INTEGER NOT NULL DEFAULT 0,
    "outgoingMessagesCount" INTEGER NOT NULL DEFAULT 0,
    "responsesCount" INTEGER NOT NULL DEFAULT 0,
    "openFlagCount" INTEGER NOT NULL DEFAULT 0,
    "activeTicketId" TEXT,
    "openTicketCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "senderUserId" TEXT,
    "body" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "origin" "MessageOrigin" NOT NULL DEFAULT 'api',
    "channel" "Channel" NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'sent',
    "statusErrorCode" INTEGER,
    "statusErrorTitle" TEXT,
    "statusErrorDetail" TEXT,
    "broadcastId" TEXT,
    "interactiveOptionId" TEXT,
    "interactiveOptionKind" TEXT,
    "reaction" TEXT,
    "agentReaction" TEXT,
    "feedback" TEXT,
    "structured" JSONB,
    "attribution" JSONB,
    "deletedAt" TIMESTAMP(3),
    "editedAt" TIMESTAMP(3),
    "rawPayload" JSONB,
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
    "mediaVoice" BOOLEAN,
    "mediaThumbnailKey" TEXT,
    "mediaThumbnailUrl" TEXT,
    "replyToMessageId" TEXT,
    "ticketId" TEXT,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundSendAttempt" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "attemptStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "externalId" TEXT,
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,

    CONSTRAINT "OutboundSendAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invite" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'agent',
    "tokenHash" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "organizationId" TEXT,

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageTemplate" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "wabaId" TEXT NOT NULL DEFAULT '',
    "externalId" TEXT,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "category" "TemplateCategory" NOT NULL,
    "correctCategory" "TemplateCategory",
    "status" "TemplateStatus" NOT NULL,
    "statusReason" TEXT,
    "messageSendTtlSeconds" INTEGER,
    "archivedAt" TIMESTAMP(3),
    "qualityScore" TEXT,
    "qualityScoreAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "libraryTemplateName" TEXT,
    "bodyParamTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bodyText" TEXT NOT NULL DEFAULT '',
    "components" JSONB NOT NULL,
    "variableBindings" JSONB NOT NULL DEFAULT '{}',
    "parameterFormat" TEXT NOT NULL DEFAULT 'positional',
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'slate',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudienceGroup" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
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
    "workspaceId" TEXT NOT NULL,
    "channelConnectionId" TEXT,
    "createdById" TEXT,
    "status" "BroadcastStatus" NOT NULL DEFAULT 'queued',
    "name" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "kind" "BroadcastKind" NOT NULL DEFAULT 'template',
    "targetMode" "BroadcastTargetMode" NOT NULL DEFAULT 'contact',
    "channel" "Channel" NOT NULL DEFAULT 'whatsapp',
    "templateId" TEXT,
    "templateName" TEXT,
    "templateLanguage" TEXT,
    "bodyText" TEXT,
    "variables" JSONB NOT NULL,
    "audienceMode" TEXT NOT NULL,
    "audienceTagIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "audienceGroupId" TEXT,
    "audienceGroupName" TEXT,
    "suppressedCount" INTEGER NOT NULL DEFAULT 0,
    "templateCategory" TEXT,
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "pausedAt" TIMESTAMP(3),
    "pausedReason" TEXT,
    "materializeRecipients" JSONB,
    "assignmentMode" "BroadcastAssignmentMode" NOT NULL DEFAULT 'none',
    "assignmentUserId" TEXT,
    "assignmentPolicyId" TEXT,
    "assignmentSplit" JSONB,
    "assignmentTrigger" TEXT NOT NULL DEFAULT 'on_reply',
    "assignmentLeftover" TEXT NOT NULL DEFAULT 'leave_unassigned',
    "assignmentOverwrite" BOOLEAN NOT NULL DEFAULT false,
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
    "customerId" TEXT,
    "conversationId" TEXT,
    "assignedUserId" TEXT,
    "status" "BroadcastRecipientStatus" NOT NULL DEFAULT 'queued',
    "externalId" TEXT,
    "errorMessage" TEXT,
    "sentAt" TIMESTAMP(3),
    "deliveryState" "BroadcastDeliveryState" NOT NULL DEFAULT 'pending',
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "metaErrorCode" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "repliedAt" TIMESTAMP(3),
    "repliedMessageId" TEXT,
    "repliedAttribution" TEXT,
    "clickedAt" TIMESTAMP(3),
    "clickedOptionId" TEXT,
    "optedOutAt" TIMESTAMP(3),
    "pricingCategory" TEXT,
    "pricingBillable" BOOLEAN,
    "pricingModel" TEXT,

    CONSTRAINT "BroadcastRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InternalNote" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "authorUserId" TEXT,
    "body" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InternalNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemplateAnalyticsDaily" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "templateExternalId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "delivered" INTEGER NOT NULL DEFAULT 0,
    "read" INTEGER,
    "clicked" INTEGER,
    "costAmountSpent" DECIMAL(14,6),
    "costPerDelivered" DECIMAL(14,6),
    "costPerUrlClick" DECIMAL(14,6),
    "currency" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TemplateAnalyticsDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxView" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'slate',
    "icon" TEXT NOT NULL DEFAULT 'filter',
    "visibility" "InboxViewVisibility" NOT NULL DEFAULT 'personal',
    "createdById" TEXT,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboxView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageFlagDefinition" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'slate',
    "description" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageFlagDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageFlag" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "status" "MessageFlagStatus" NOT NULL DEFAULT 'open',
    "source" TEXT NOT NULL DEFAULT 'human',
    "confidence" DOUBLE PRECISION,
    "note" TEXT,
    "createdById" TEXT,
    "assignedToId" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "conversationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "subject" TEXT,
    "status" "TicketStatus" NOT NULL DEFAULT 'new',
    "priority" "TicketPriority" NOT NULL DEFAULT 'normal',
    "assignedUserId" TEXT,
    "lastAssignedUserId" TEXT,
    "policyId" TEXT,
    "assignedTeamId" TEXT,
    "slaPolicyId" TEXT,
    "firstResponseDueAt" TIMESTAMP(3),
    "resolutionDueAt" TIMESTAMP(3),
    "firstResponseAt" TIMESTAMP(3),
    "firstResponseBreached" BOOLEAN NOT NULL DEFAULT false,
    "resolutionBreached" BOOLEAN NOT NULL DEFAULT false,
    "slaPausedMs" INTEGER NOT NULL DEFAULT 0,
    "slaPausedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolutionCode" TEXT,
    "resolutionNote" TEXT,
    "reopenCount" INTEGER NOT NULL DEFAULT 0,
    "lastSolvedAt" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'auto',
    "createdById" TEXT,
    "createdByApiKeyId" TEXT,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "kind" "TicketEventKind" NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "body" TEXT,
    "actorUserId" TEXT,
    "actorApiKeyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketSlaPolicy" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "priority" "TicketPriority" NOT NULL,
    "firstResponseMins" INTEGER,
    "resolutionMins" INTEGER,
    "pauseOnHold" BOOLEAN NOT NULL DEFAULT true,
    "pauseWhenPending" BOOLEAN NOT NULL DEFAULT false,
    "businessHoursOnly" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketSlaPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketFieldDefinition" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketFieldDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketNumberCounter" (
    "workspaceId" TEXT NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "TicketNumberCounter_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateTable
CREATE TABLE "Workflow" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
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
    "workspaceId" TEXT NOT NULL,
    "status" "WorkflowRunStatus" NOT NULL DEFAULT 'queued',
    "trigger" "WorkflowTriggerEvent" NOT NULL,
    "contactId" TEXT,
    "conversationId" TEXT,
    "eventPayload" JSONB NOT NULL,
    "graphSnapshot" JSONB,
    "currentStepId" TEXT,
    "waitUntil" TIMESTAMP(3),
    "jumpsUsed" INTEGER NOT NULL DEFAULT 0,
    "stepLog" JSONB NOT NULL DEFAULT '[]',
    "pendingAnswer" JSONB,
    "stepOutputs" JSONB NOT NULL DEFAULT '{}',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "WorkflowRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowAwaitingReply" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowAwaitingReply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowContactState" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "firedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowContactState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceApiKey" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "scopes" TEXT[] DEFAULT ARRAY['*']::TEXT[],

    CONSTRAINT "WorkspaceApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiIdempotencyKey" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "responseBody" JSONB NOT NULL,
    "responseStatus" INTEGER NOT NULL,
    "requestHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiIdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundWebhook" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
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
    "correlationId" TEXT,
    "chainDepth" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboundWebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationEvent" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT,
    "apiKeyId" TEXT,
    "workflowId" TEXT,
    "kind" "ConversationEventKind" NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamChannel" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "kind" "TeamChannelKind" NOT NULL DEFAULT 'channel',
    "visibility" "TeamChannelVisibility" NOT NULL DEFAULT 'private',
    "dmKey" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessagePreview" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "TeamChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamChannelMember" (
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedById" TEXT,

    CONSTRAINT "TeamChannelMember_pkey" PRIMARY KEY ("channelId","userId")
);

-- CreateTable
CREATE TABLE "TeamChannelMessage" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "authorUserId" TEXT,
    "body" TEXT NOT NULL,
    "clientTempId" TEXT,
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
    "workspaceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "dispatchedAt" TIMESTAMP(3),
    "chainDepth" INTEGER NOT NULL DEFAULT 0,
    "correlationId" TEXT,

    CONSTRAINT "OutboundEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Call" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "externalCallId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL DEFAULT 'whatsapp',
    "direction" "CallDirection" NOT NULL,
    "status" "CallStatus" NOT NULL DEFAULT 'ringing',
    "initiatedByUserId" TEXT,
    "answeredByUserId" TEXT,
    "ringingAt" TIMESTAMP(3) NOT NULL,
    "answeredAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "rawPayload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Call_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallPermissionRequest" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "externalRequestId" TEXT,
    "status" "CallPermissionStatus" NOT NULL DEFAULT 'pending',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "isPermanent" BOOLEAN NOT NULL DEFAULT false,
    "grantedAt" TIMESTAMP(3),
    "rateLimitedUntil" TIMESTAMP(3),

    CONSTRAINT "CallPermissionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiAssistantConfig" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "configVersion" INTEGER NOT NULL DEFAULT 1,
    "companyName" TEXT,
    "shortDescription" TEXT,
    "fullDescription" TEXT,
    "industry" TEXT,
    "website" TEXT,
    "phone" TEXT,
    "locations" JSONB NOT NULL DEFAULT '[]',
    "serviceAreas" JSONB NOT NULL DEFAULT '[]',
    "products" TEXT,
    "services" TEXT,
    "pricingNotes" TEXT,
    "paymentMethods" TEXT,
    "deliveryPolicy" TEXT,
    "returnPolicy" TEXT,
    "bookingRules" TEXT,
    "faqs" JSONB NOT NULL DEFAULT '[]',
    "restrictions" TEXT,
    "escalationInstructions" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Beirut',
    "weeklySchedule" JSONB NOT NULL DEFAULT '{}',
    "holidays" JSONB NOT NULL DEFAULT '[]',
    "scheduleExceptions" JSONB NOT NULL DEFAULT '[]',
    "afterHoursBehavior" TEXT,
    "supportedLanguages" JSONB NOT NULL DEFAULT '["ar", "en"]',
    "defaultLanguage" TEXT NOT NULL DEFAULT 'ar',
    "languagePolicy" "AiLanguagePolicy" NOT NULL DEFAULT 'match_customer',
    "specificLanguage" TEXT,
    "lebaneseDialect" BOOLEAN NOT NULL DEFAULT true,
    "lebaneseStyle" TEXT,
    "allowArabizi" BOOLEAN NOT NULL DEFAULT true,
    "scriptPolicy" TEXT NOT NULL DEFAULT 'match_customer',
    "codeSwitching" BOOLEAN NOT NULL DEFAULT true,
    "emojiPolicy" TEXT NOT NULL DEFAULT 'sparing',
    "tone" TEXT NOT NULL DEFAULT 'friendly',
    "matchCustomerTone" BOOLEAN NOT NULL DEFAULT true,
    "replyLength" TEXT NOT NULL DEFAULT 'balanced',
    "customInstructions" TEXT,
    "autoReplyMode" "AiAutoReplyMode" NOT NULL DEFAULT 'auto_send',
    "confidenceThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.55,
    "maxAutoRepliesPerConv" INTEGER NOT NULL DEFAULT 0,
    "humanTakeoverBehavior" TEXT NOT NULL DEFAULT 'cancel_and_yield',
    "replyWaitSeconds" INTEGER NOT NULL DEFAULT 0,
    "incomingTranscription" BOOLEAN NOT NULL DEFAULT true,
    "saveTranscript" BOOLEAN NOT NULL DEFAULT true,
    "replyChannelMode" "AiReplyChannelMode" NOT NULL DEFAULT 'text',
    "voiceId" TEXT,
    "voiceLanguage" TEXT NOT NULL DEFAULT 'ar',
    "voiceSpeed" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "maxVoiceDurationSec" INTEGER NOT NULL DEFAULT 60,
    "voiceTextFallback" BOOLEAN NOT NULL DEFAULT true,
    "replyModelTier" TEXT NOT NULL DEFAULT 'reply',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiAssistantConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiContextDocument" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "r2Key" TEXT NOT NULL,
    "status" "AiContextDocStatus" NOT NULL DEFAULT 'processing',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "tokenCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "AiContextDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiContextChunk" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "tokenCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiContextChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiConversationState" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "state" "AiConvAutomationState" NOT NULL DEFAULT 'ai_active',
    "pausedByUserId" TEXT,
    "pausedAt" TIMESTAMP(3),
    "stateChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "autoReplyCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiConversationState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationAutomationClaim" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "inboundMessageId" TEXT NOT NULL,
    "owner" "AiAutomationOwner" NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationAutomationClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationSessionSummary" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "sessionStartAt" TIMESTAMP(3) NOT NULL,
    "sessionEndAt" TIMESTAMP(3),
    "lastSummarizedMessageId" TEXT,
    "summaryVersion" INTEGER NOT NULL DEFAULT 0,
    "customerGoal" TEXT,
    "importantContext" TEXT,
    "questions" JSONB NOT NULL DEFAULT '[]',
    "answers" JSONB NOT NULL DEFAULT '[]',
    "commitments" JSONB NOT NULL DEFAULT '[]',
    "openQuestions" JSONB NOT NULL DEFAULT '[]',
    "requiredFollowUp" TEXT,
    "sentiment" TEXT,
    "language" TEXT,
    "tone" TEXT,
    "latestStatus" TEXT,
    "overallBrief" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationSessionSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiCustomerMemory" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "kind" "AiMemoryKind" NOT NULL,
    "value" VARCHAR(500) NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "AiMemoryStatus" NOT NULL DEFAULT 'candidate',
    "source" "AiMemorySource" NOT NULL DEFAULT 'system',
    "sourceConversationId" TEXT,
    "sourceMessageId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiCustomerMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiMessageMetadata" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "model" TEXT,
    "language" TEXT,
    "dialect" TEXT,
    "script" TEXT,
    "intent" TEXT,
    "confidence" DOUBLE PRECISION,
    "interactionId" TEXT,
    "hallucinationRisk" DOUBLE PRECISION,
    "hallucinationNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiMessageMetadata_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiMessageTranscription" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "status" "AiTranscriptionStatus" NOT NULL DEFAULT 'pending',
    "transcript" TEXT,
    "language" TEXT,
    "provider" TEXT,
    "durationMs" INTEGER,
    "correctedText" TEXT,
    "correctedByUserId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiMessageTranscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiAssistantInteraction" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "inboundMessageId" TEXT NOT NULL,
    "outboundMessageId" TEXT,
    "suggestionId" TEXT,
    "configVersion" INTEGER NOT NULL,
    "model" TEXT,
    "language" TEXT,
    "dialect" TEXT,
    "intent" TEXT,
    "confidence" DOUBLE PRECISION,
    "decision" "AiInteractionDecision" NOT NULL,
    "skipReason" TEXT,
    "selectedChunkIds" JSONB NOT NULL DEFAULT '[]',
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "cacheReadTokens" INTEGER,
    "latencyMs" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiAssistantInteraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiReplySuggestion" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "inboundMessageId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "replyLanguage" TEXT,
    "replyScript" TEXT,
    "channelMode" "AiReplyChannelMode" NOT NULL DEFAULT 'text',
    "audioR2Key" TEXT,
    "usedChunkIds" JSONB NOT NULL DEFAULT '[]',
    "state" "AiSuggestionState" NOT NULL DEFAULT 'pending',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "editedText" TEXT,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiReplySuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssignmentPolicy" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "strategy" "AssignmentStrategy" NOT NULL DEFAULT 'least_busy',
    "eligibility" "AssignmentEligibility" NOT NULL DEFAULT 'online_first',
    "eligibleRoles" "Role"[] DEFAULT ARRAY[]::"Role"[],
    "includeAllMembers" BOOLEAN NOT NULL DEFAULT true,
    "defaultMaxOpen" INTEGER,
    "overflow" "AssignmentOverflow" NOT NULL DEFAULT 'leave_unassigned',
    "fallbackUserId" TEXT,
    "fixedUserId" TEXT,
    "cursorUserId" TEXT,
    "preferPreviousAgent" BOOLEAN NOT NULL DEFAULT true,
    "previousAgentWindowDays" INTEGER NOT NULL DEFAULT 30,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssignmentPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssignmentPolicyMember" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "maxOpen" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "served" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssignmentPolicyMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssignmentRule" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssignmentRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssignmentSettings" (
    "workspaceId" TEXT NOT NULL,
    "autoAssignOnNewConversation" BOOLEAN NOT NULL DEFAULT false,
    "skipWhenAiHandling" BOOLEAN NOT NULL DEFAULT true,
    "autoAssignOnReopen" BOOLEAN NOT NULL DEFAULT false,
    "reassignOnOffline" BOOLEAN NOT NULL DEFAULT false,
    "reassignOfflineAfterMinutes" INTEGER NOT NULL DEFAULT 15,
    "reassignOfflineOnlyPending" BOOLEAN NOT NULL DEFAULT true,
    "reassignOnDeactivate" BOOLEAN NOT NULL DEFAULT true,
    "aiHandoffPolicyId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssignmentSettings_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateTable
CREATE TABLE "_ContactToTag" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_ContactToTag_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_TicketTags" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_TicketTags_AB_pkey" PRIMARY KEY ("A","B")
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
CREATE INDEX "Workspace_organizationId_idx" ON "Workspace"("organizationId");

-- CreateIndex
CREATE INDEX "WorkspaceMember_workspaceId_idx" ON "WorkspaceMember"("workspaceId");

-- CreateIndex
CREATE INDEX "WorkspaceMember_userId_idx" ON "WorkspaceMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMember_userId_workspaceId_key" ON "WorkspaceMember"("userId", "workspaceId");

-- CreateIndex
CREATE INDEX "ChannelConnection_workspaceId_channel_idx" ON "ChannelConnection"("workspaceId", "channel");

-- CreateIndex
CREATE INDEX "ChannelConnection_channel_externalAccountId_idx" ON "ChannelConnection"("channel", "externalAccountId");

-- CreateIndex
CREATE INDEX "ChannelConnection_portfolioId_idx" ON "ChannelConnection"("portfolioId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelConnection_workspaceId_channel_externalAccountId_key" ON "ChannelConnection"("workspaceId", "channel", "externalAccountId");

-- CreateIndex
CREATE INDEX "WhatsappPortfolio_workspaceId_idx" ON "WhatsappPortfolio"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappPortfolio_workspaceId_externalPortfolioId_key" ON "WhatsappPortfolio"("workspaceId", "externalPortfolioId");

-- CreateIndex
CREATE UNIQUE INDEX "WebchatWidget_publicKey_key" ON "WebchatWidget"("publicKey");

-- CreateIndex
CREATE INDEX "WebchatWidget_workspaceId_idx" ON "WebchatWidget"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "MetaConnection_workspaceId_key" ON "MetaConnection"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_organizationId_idx" ON "User"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_providerId_accountId_key" ON "Account"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "Verification_identifier_idx" ON "Verification"("identifier");

-- CreateIndex
CREATE INDEX "Snippet_workspaceId_label_idx" ON "Snippet"("workspaceId", "label");

-- CreateIndex
CREATE UNIQUE INDEX "Snippet_workspaceId_name_key" ON "Snippet"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "Contact_workspaceId_phoneNumber_idx" ON "Contact"("workspaceId", "phoneNumber");

-- CreateIndex
CREATE INDEX "Contact_workspaceId_source_idx" ON "Contact"("workspaceId", "source");

-- CreateIndex
CREATE INDEX "Contact_workspaceId_stageId_idx" ON "Contact"("workspaceId", "stageId");

-- CreateIndex
CREATE INDEX "Contact_workspaceId_identityChannel_bsuid_idx" ON "Contact"("workspaceId", "identityChannel", "bsuid");

-- CreateIndex
CREATE INDEX "Contact_customerId_idx" ON "Contact"("customerId");

-- CreateIndex
CREATE INDEX "Contact_workspaceId_deletedAt_idx" ON "Contact"("workspaceId", "deletedAt");

-- CreateIndex
CREATE INDEX "Contact_teamId_lastInboundAt_idx" ON "Contact"("workspaceId", "lastInboundAt" DESC);

-- CreateIndex
CREATE INDEX "Contact_workspaceId_createdAt_id_idx" ON "Contact"("workspaceId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Contact_name_trgm_idx" ON "Contact" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Contact_email_trgm_idx" ON "Contact" USING GIN ("email" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "Contact_workspaceId_identityChannel_externalContactId_key" ON "Contact"("workspaceId", "identityChannel", "externalContactId");

-- CreateIndex
CREATE INDEX "Customer_workspaceId_idx" ON "Customer"("workspaceId");

-- CreateIndex
CREATE INDEX "CustomerIdentityEvent_workspaceId_createdAt_idx" ON "CustomerIdentityEvent"("workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CustomerIdentityEvent_workspaceId_contactId_idx" ON "CustomerIdentityEvent"("workspaceId", "contactId");

-- CreateIndex
CREATE INDEX "ContactStage_workspaceId_position_idx" ON "ContactStage"("workspaceId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ContactStage_workspaceId_name_key" ON "ContactStage"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "ContactFieldDefinition_workspaceId_order_idx" ON "ContactFieldDefinition"("workspaceId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "ContactFieldDefinition_workspaceId_key_key" ON "ContactFieldDefinition"("workspaceId", "key");

-- CreateIndex
CREATE INDEX "ContactTransferJob_workspaceId_createdAt_idx" ON "ContactTransferJob"("workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ContactTransferJob_status_heartbeatAt_idx" ON "ContactTransferJob"("status", "heartbeatAt");

-- CreateIndex
CREATE INDEX "ContactTransferJob_expiresAt_idx" ON "ContactTransferJob"("expiresAt");

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_status_lastMessageAt_idx" ON "Conversation"("workspaceId", "status", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_assignedUserId_idx" ON "Conversation"("workspaceId", "assignedUserId");

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_assignedUserId_lastMessageAt_id_idx" ON "Conversation"("workspaceId", "assignedUserId", "lastMessageAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Conversation_assignedUserId_idx" ON "Conversation"("assignedUserId");

-- CreateIndex
CREATE INDEX "Conversation_contactId_idx" ON "Conversation"("contactId");

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_lastMessageAt_id_idx" ON "Conversation"("workspaceId", "lastMessageAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_workspaceId_contactId_key" ON "Conversation"("workspaceId", "contactId");

-- CreateIndex
CREATE INDEX "Message_replyToMessageId_idx" ON "Message"("replyToMessageId");

-- CreateIndex
CREATE INDEX "Message_ticketId_timestamp_idx" ON "Message"("ticketId", "timestamp");

-- CreateIndex
CREATE INDEX "Message_senderUserId_idx" ON "Message"("senderUserId");

-- CreateIndex
CREATE INDEX "Message_conversationId_timestamp_id_idx" ON "Message"("conversationId", "timestamp" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Message_body_trgm_idx" ON "Message" USING GIN ("body" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Message_teamId_timestamp_id_idx" ON "Message"("workspaceId", "timestamp" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Message_workspaceId_channel_externalId_key" ON "Message"("workspaceId", "channel", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundSendAttempt_jobId_key" ON "OutboundSendAttempt"("jobId");

-- CreateIndex
CREATE INDEX "OutboundSendAttempt_attemptStartedAt_idx" ON "OutboundSendAttempt"("attemptStartedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Invite_tokenHash_key" ON "Invite"("tokenHash");

-- CreateIndex
CREATE INDEX "Invite_workspaceId_email_idx" ON "Invite"("workspaceId", "email");

-- CreateIndex
CREATE INDEX "MessageTemplate_workspaceId_status_idx" ON "MessageTemplate"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MessageTemplate_workspaceId_wabaId_name_language_key" ON "MessageTemplate"("workspaceId", "wabaId", "name", "language");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_workspaceId_name_key" ON "Tag"("workspaceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "AudienceGroup_workspaceId_name_key" ON "AudienceGroup"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "Broadcast_workspaceId_createdAt_idx" ON "Broadcast"("workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Broadcast_workspaceId_status_idx" ON "Broadcast"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "Broadcast_workspaceId_scheduledAt_idx" ON "Broadcast"("workspaceId", "scheduledAt");

-- CreateIndex
CREATE INDEX "Broadcast_status_pausedAt_idx" ON "Broadcast"("status", "pausedAt");

-- CreateIndex
CREATE INDEX "Broadcast_channelConnectionId_idx" ON "Broadcast"("channelConnectionId");

-- CreateIndex
CREATE INDEX "BroadcastRecipient_broadcastId_status_idx" ON "BroadcastRecipient"("broadcastId", "status");

-- CreateIndex
CREATE INDEX "BroadcastRecipient_broadcastId_status_id_idx" ON "BroadcastRecipient"("broadcastId", "status", "id");

-- CreateIndex
CREATE INDEX "BroadcastRecipient_contactId_sentAt_idx" ON "BroadcastRecipient"("contactId", "sentAt" DESC);

-- CreateIndex
CREATE INDEX "BroadcastRecipient_broadcastId_deliveryState_id_idx" ON "BroadcastRecipient"("broadcastId", "deliveryState", "id");

-- CreateIndex
CREATE INDEX "BroadcastRecipient_broadcastId_deliveredAt_idx" ON "BroadcastRecipient"("broadcastId", "deliveredAt");

-- CreateIndex
CREATE INDEX "BroadcastRecipient_broadcastId_readAt_idx" ON "BroadcastRecipient"("broadcastId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "BroadcastRecipient_broadcastId_contactId_key" ON "BroadcastRecipient"("broadcastId", "contactId");

-- CreateIndex
CREATE INDEX "InternalNote_conversationId_timestamp_idx" ON "InternalNote"("conversationId", "timestamp");

-- CreateIndex
CREATE INDEX "InternalNote_authorUserId_idx" ON "InternalNote"("authorUserId");

-- CreateIndex
CREATE INDEX "InternalNote_body_trgm_idx" ON "InternalNote" USING GIN ("body" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "InternalNote_teamId_timestamp_id_idx" ON "InternalNote"("workspaceId", "timestamp" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "TemplateAnalyticsDaily_workspaceId_templateExternalId_date_idx" ON "TemplateAnalyticsDaily"("workspaceId", "templateExternalId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "TemplateAnalyticsDaily_workspaceId_templateExternalId_date_key" ON "TemplateAnalyticsDaily"("workspaceId", "templateExternalId", "date");

-- CreateIndex
CREATE INDEX "InboxView_workspaceId_visibility_idx" ON "InboxView"("workspaceId", "visibility");

-- CreateIndex
CREATE INDEX "InboxView_workspaceId_createdById_idx" ON "InboxView"("workspaceId", "createdById");

-- CreateIndex
CREATE UNIQUE INDEX "MessageFlagDefinition_workspaceId_name_key" ON "MessageFlagDefinition"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "MessageFlag_workspaceId_status_createdAt_id_idx" ON "MessageFlag"("workspaceId", "status", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "MessageFlag_workspaceId_assignedToId_status_idx" ON "MessageFlag"("workspaceId", "assignedToId", "status");

-- CreateIndex
CREATE INDEX "MessageFlag_messageId_idx" ON "MessageFlag"("messageId");

-- CreateIndex
CREATE INDEX "MessageFlag_conversationId_idx" ON "MessageFlag"("conversationId");

-- CreateIndex
CREATE INDEX "MessageFlag_definitionId_idx" ON "MessageFlag"("definitionId");

-- CreateIndex
CREATE INDEX "MessageFlag_createdById_idx" ON "MessageFlag"("createdById");

-- CreateIndex
CREATE INDEX "MessageFlag_assignedToId_idx" ON "MessageFlag"("assignedToId");

-- CreateIndex
CREATE INDEX "MessageFlag_resolvedById_idx" ON "MessageFlag"("resolvedById");

-- CreateIndex
CREATE UNIQUE INDEX "MessageFlag_messageId_definitionId_key" ON "MessageFlag"("messageId", "definitionId");

-- CreateIndex
CREATE INDEX "Ticket_workspaceId_status_createdAt_id_idx" ON "Ticket"("workspaceId", "status", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Ticket_workspaceId_assignedUserId_status_createdAt_id_idx" ON "Ticket"("workspaceId", "assignedUserId", "status", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Ticket_workspaceId_assignedTeamId_status_createdAt_id_idx" ON "Ticket"("workspaceId", "assignedTeamId", "status", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Ticket_assignedTeamId_idx" ON "Ticket"("assignedTeamId");

-- CreateIndex
CREATE INDEX "Ticket_workspaceId_priority_status_idx" ON "Ticket"("workspaceId", "priority", "status");

-- CreateIndex
CREATE INDEX "Ticket_conversationId_createdAt_idx" ON "Ticket"("conversationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Ticket_workspaceId_contactId_createdAt_idx" ON "Ticket"("workspaceId", "contactId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Ticket_assignedUserId_idx" ON "Ticket"("assignedUserId");

-- CreateIndex
CREATE INDEX "Ticket_resolvedById_idx" ON "Ticket"("resolvedById");

-- CreateIndex
CREATE INDEX "Ticket_slaPolicyId_idx" ON "Ticket"("slaPolicyId");

-- CreateIndex
CREATE INDEX "Ticket_contactId_idx" ON "Ticket"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_workspaceId_number_key" ON "Ticket"("workspaceId", "number");

-- CreateIndex
CREATE INDEX "TicketEvent_ticketId_createdAt_idx" ON "TicketEvent"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "TicketEvent_workspaceId_createdAt_idx" ON "TicketEvent"("workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "TicketEvent_actorUserId_idx" ON "TicketEvent"("actorUserId");

-- CreateIndex
CREATE UNIQUE INDEX "TicketSlaPolicy_workspaceId_priority_key" ON "TicketSlaPolicy"("workspaceId", "priority");

-- CreateIndex
CREATE INDEX "TicketFieldDefinition_workspaceId_order_idx" ON "TicketFieldDefinition"("workspaceId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "TicketFieldDefinition_workspaceId_key_key" ON "TicketFieldDefinition"("workspaceId", "key");

-- CreateIndex
CREATE INDEX "Workflow_workspaceId_trigger_published_idx" ON "Workflow"("workspaceId", "trigger", "published");

-- CreateIndex
CREATE UNIQUE INDEX "Workflow_workspaceId_name_key" ON "Workflow"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "WorkflowRun_workflowId_startedAt_idx" ON "WorkflowRun"("workflowId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "WorkflowRun_workspaceId_startedAt_idx" ON "WorkflowRun"("workspaceId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "WorkflowRun_status_waitUntil_idx" ON "WorkflowRun"("status", "waitUntil");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowAwaitingReply_runId_key" ON "WorkflowAwaitingReply"("runId");

-- CreateIndex
CREATE INDEX "WorkflowAwaitingReply_workspaceId_contactId_idx" ON "WorkflowAwaitingReply"("workspaceId", "contactId");

-- CreateIndex
CREATE INDEX "WorkflowAwaitingReply_contactId_idx" ON "WorkflowAwaitingReply"("contactId");

-- CreateIndex
CREATE INDEX "WorkflowAwaitingReply_expiresAt_idx" ON "WorkflowAwaitingReply"("expiresAt");

-- CreateIndex
CREATE INDEX "WorkflowContactState_workspaceId_idx" ON "WorkflowContactState"("workspaceId");

-- CreateIndex
CREATE INDEX "WorkflowContactState_contactId_idx" ON "WorkflowContactState"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowContactState_workflowId_contactId_key" ON "WorkflowContactState"("workflowId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceApiKey_tokenHash_key" ON "WorkspaceApiKey"("tokenHash");

-- CreateIndex
CREATE INDEX "WorkspaceApiKey_workspaceId_revokedAt_idx" ON "WorkspaceApiKey"("workspaceId", "revokedAt");

-- CreateIndex
CREATE INDEX "ApiIdempotencyKey_expiresAt_idx" ON "ApiIdempotencyKey"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApiIdempotencyKey_workspaceId_apiKeyId_key_key" ON "ApiIdempotencyKey"("workspaceId", "apiKeyId", "key");

-- CreateIndex
CREATE INDEX "OutboundWebhook_workspaceId_enabled_idx" ON "OutboundWebhook"("workspaceId", "enabled");

-- CreateIndex
CREATE INDEX "OutboundWebhookDelivery_webhookId_createdAt_idx" ON "OutboundWebhookDelivery"("webhookId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "OutboundWebhookDelivery_createdAt_idx" ON "OutboundWebhookDelivery"("createdAt");

-- CreateIndex
CREATE INDEX "ConversationEvent_conversationId_at_idx" ON "ConversationEvent"("conversationId", "at" DESC);

-- CreateIndex
CREATE INDEX "ConversationEvent_at_idx" ON "ConversationEvent"("at");

-- CreateIndex
CREATE INDEX "ConversationEvent_userId_idx" ON "ConversationEvent"("userId");

-- CreateIndex
CREATE INDEX "TeamChannel_workspaceId_lastMessageAt_idx" ON "TeamChannel"("workspaceId", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "TeamChannel_workspaceId_kind_lastMessageAt_idx" ON "TeamChannel"("workspaceId", "kind", "lastMessageAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "TeamChannel_workspaceId_name_key" ON "TeamChannel"("workspaceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "TeamChannel_workspaceId_dmKey_key" ON "TeamChannel"("workspaceId", "dmKey");

-- CreateIndex
CREATE INDEX "TeamChannelMember_userId_idx" ON "TeamChannelMember"("userId");

-- CreateIndex
CREATE INDEX "TeamChannelMessage_channelId_createdAt_id_idx" ON "TeamChannelMessage"("channelId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "TeamChannelMessage_threadRootId_createdAt_idx" ON "TeamChannelMessage"("threadRootId", "createdAt");

-- CreateIndex
CREATE INDEX "TeamChannelMessage_workspaceId_idx" ON "TeamChannelMessage"("workspaceId");

-- CreateIndex
CREATE INDEX "TeamChannelMessage_authorUserId_idx" ON "TeamChannelMessage"("authorUserId");

-- CreateIndex
CREATE INDEX "TeamChannelMessage_body_trgm_idx" ON "TeamChannelMessage" USING GIN ("body" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "TeamChannelMessage_send_idem_key" ON "TeamChannelMessage"("channelId", "authorUserId", "clientTempId");

-- CreateIndex
CREATE INDEX "TeamChannelMention_mentionedUserId_idx" ON "TeamChannelMention"("mentionedUserId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamChannelMention_messageId_mentionedUserId_key" ON "TeamChannelMention"("messageId", "mentionedUserId");

-- CreateIndex
CREATE INDEX "TeamChannelReaction_messageId_idx" ON "TeamChannelReaction"("messageId");

-- CreateIndex
CREATE INDEX "TeamChannelReaction_userId_idx" ON "TeamChannelReaction"("userId");

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
CREATE INDEX "Call_conversationId_ringingAt_idx" ON "Call"("conversationId", "ringingAt" DESC);

-- CreateIndex
CREATE INDEX "Call_initiatedByUserId_idx" ON "Call"("initiatedByUserId");

-- CreateIndex
CREATE INDEX "Call_answeredByUserId_idx" ON "Call"("answeredByUserId");

-- CreateIndex
CREATE INDEX "Call_workspaceId_status_ringingAt_idx" ON "Call"("workspaceId", "status", "ringingAt" DESC);

-- CreateIndex
CREATE INDEX "Call_workspaceId_idx" ON "Call"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Call_workspaceId_channel_externalCallId_key" ON "Call"("workspaceId", "channel", "externalCallId");

-- CreateIndex
CREATE INDEX "CallPermissionRequest_workspaceId_contactId_requestedAt_idx" ON "CallPermissionRequest"("workspaceId", "contactId", "requestedAt" DESC);

-- CreateIndex
CREATE INDEX "CallPermissionRequest_contactId_idx" ON "CallPermissionRequest"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "AiAssistantConfig_workspaceId_key" ON "AiAssistantConfig"("workspaceId");

-- CreateIndex
CREATE INDEX "AiContextDocument_workspaceId_createdAt_idx" ON "AiContextDocument"("workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AiContextChunk_workspaceId_idx" ON "AiContextChunk"("workspaceId");

-- CreateIndex
CREATE INDEX "AiContextChunk_documentId_ordinal_idx" ON "AiContextChunk"("documentId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "AiConversationState_conversationId_key" ON "AiConversationState"("conversationId");

-- CreateIndex
CREATE INDEX "AiConversationState_workspaceId_idx" ON "AiConversationState"("workspaceId");

-- CreateIndex
CREATE INDEX "ConversationAutomationClaim_workspaceId_conversationId_idx" ON "ConversationAutomationClaim"("workspaceId", "conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationAutomationClaim_workspaceId_inboundMessageId_key" ON "ConversationAutomationClaim"("workspaceId", "inboundMessageId");

-- CreateIndex
CREATE INDEX "ConversationSessionSummary_workspaceId_conversationId_sessi_idx" ON "ConversationSessionSummary"("workspaceId", "conversationId", "sessionStartAt" DESC);

-- CreateIndex
CREATE INDEX "AiCustomerMemory_workspaceId_customerId_status_idx" ON "AiCustomerMemory"("workspaceId", "customerId", "status");

-- CreateIndex
CREATE INDEX "AiCustomerMemory_workspaceId_customerId_kind_idx" ON "AiCustomerMemory"("workspaceId", "customerId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "AiCustomerMemory_workspaceId_customerId_kind_value_key" ON "AiCustomerMemory"("workspaceId", "customerId", "kind", "value");

-- CreateIndex
CREATE UNIQUE INDEX "AiMessageMetadata_messageId_key" ON "AiMessageMetadata"("messageId");

-- CreateIndex
CREATE INDEX "AiMessageMetadata_workspaceId_idx" ON "AiMessageMetadata"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AiMessageTranscription_messageId_key" ON "AiMessageTranscription"("messageId");

-- CreateIndex
CREATE INDEX "AiMessageTranscription_workspaceId_idx" ON "AiMessageTranscription"("workspaceId");

-- CreateIndex
CREATE INDEX "AiAssistantInteraction_workspaceId_conversationId_createdAt_idx" ON "AiAssistantInteraction"("workspaceId", "conversationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AiAssistantInteraction_workspaceId_createdAt_idx" ON "AiAssistantInteraction"("workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AiReplySuggestion_workspaceId_inboundMessageId_attempt_idx" ON "AiReplySuggestion"("workspaceId", "inboundMessageId", "attempt");

-- CreateIndex
CREATE INDEX "AiReplySuggestion_workspaceId_conversationId_state_idx" ON "AiReplySuggestion"("workspaceId", "conversationId", "state");

-- CreateIndex
CREATE INDEX "AssignmentPolicy_workspaceId_archivedAt_idx" ON "AssignmentPolicy"("workspaceId", "archivedAt");

-- CreateIndex
CREATE INDEX "AssignmentPolicy_workspaceId_isDefault_idx" ON "AssignmentPolicy"("workspaceId", "isDefault");

-- CreateIndex
CREATE INDEX "AssignmentPolicyMember_workspaceId_idx" ON "AssignmentPolicyMember"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AssignmentPolicyMember_policyId_userId_key" ON "AssignmentPolicyMember"("policyId", "userId");

-- CreateIndex
CREATE INDEX "AssignmentRule_workspaceId_enabled_position_idx" ON "AssignmentRule"("workspaceId", "enabled", "position");

-- CreateIndex
CREATE INDEX "_ContactToTag_B_index" ON "_ContactToTag"("B");

-- CreateIndex
CREATE INDEX "_TicketTags_B_index" ON "_TicketTags"("B");

-- CreateIndex
CREATE INDEX "_AudienceGroupTags_B_index" ON "_AudienceGroupTags"("B");

-- CreateIndex
CREATE INDEX "_AudienceGroupContacts_B_index" ON "_AudienceGroupContacts"("B");

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_aiHandoffAssigneeId_fkey" FOREIGN KEY ("aiHandoffAssigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelConnection" ADD CONSTRAINT "ChannelConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelConnection" ADD CONSTRAINT "ChannelConnection_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "WhatsappPortfolio"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappPortfolio" ADD CONSTRAINT "WhatsappPortfolio_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebchatWidget" ADD CONSTRAINT "WebchatWidget_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaConnection" ADD CONSTRAINT "MetaConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Snippet" ADD CONSTRAINT "Snippet_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Snippet" ADD CONSTRAINT "Snippet_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "ContactStage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerIdentityEvent" ADD CONSTRAINT "CustomerIdentityEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactStage" ADD CONSTRAINT "ContactStage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactFieldDefinition" ADD CONSTRAINT "ContactFieldDefinition_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactTransferJob" ADD CONSTRAINT "ContactTransferJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactTransferJob" ADD CONSTRAINT "ContactTransferJob_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_webchatWidgetId_fkey" FOREIGN KEY ("webchatWidgetId") REFERENCES "WebchatWidget"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_channelConnectionId_fkey" FOREIGN KEY ("channelConnectionId") REFERENCES "ChannelConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_activeTicketId_fkey" FOREIGN KEY ("activeTicketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_replyToMessageId_fkey" FOREIGN KEY ("replyToMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundSendAttempt" ADD CONSTRAINT "OutboundSendAttempt_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudienceGroup" ADD CONSTRAINT "AudienceGroup_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudienceGroup" ADD CONSTRAINT "AudienceGroup_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Broadcast" ADD CONSTRAINT "Broadcast_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Broadcast" ADD CONSTRAINT "Broadcast_channelConnectionId_fkey" FOREIGN KEY ("channelConnectionId") REFERENCES "ChannelConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Broadcast" ADD CONSTRAINT "Broadcast_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BroadcastRecipient" ADD CONSTRAINT "BroadcastRecipient_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "Broadcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BroadcastRecipient" ADD CONSTRAINT "BroadcastRecipient_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalNote" ADD CONSTRAINT "InternalNote_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalNote" ADD CONSTRAINT "InternalNote_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalNote" ADD CONSTRAINT "InternalNote_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemplateAnalyticsDaily" ADD CONSTRAINT "TemplateAnalyticsDaily_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxView" ADD CONSTRAINT "InboxView_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxView" ADD CONSTRAINT "InboxView_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageFlagDefinition" ADD CONSTRAINT "MessageFlagDefinition_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageFlag" ADD CONSTRAINT "MessageFlag_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageFlag" ADD CONSTRAINT "MessageFlag_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageFlag" ADD CONSTRAINT "MessageFlag_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageFlag" ADD CONSTRAINT "MessageFlag_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "MessageFlagDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageFlag" ADD CONSTRAINT "MessageFlag_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageFlag" ADD CONSTRAINT "MessageFlag_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageFlag" ADD CONSTRAINT "MessageFlag_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_assignedTeamId_fkey" FOREIGN KEY ("assignedTeamId") REFERENCES "AssignmentPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_slaPolicyId_fkey" FOREIGN KEY ("slaPolicyId") REFERENCES "TicketSlaPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketEvent" ADD CONSTRAINT "TicketEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketEvent" ADD CONSTRAINT "TicketEvent_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketEvent" ADD CONSTRAINT "TicketEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketSlaPolicy" ADD CONSTRAINT "TicketSlaPolicy_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketFieldDefinition" ADD CONSTRAINT "TicketFieldDefinition_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketNumberCounter" ADD CONSTRAINT "TicketNumberCounter_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowAwaitingReply" ADD CONSTRAINT "WorkflowAwaitingReply_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowAwaitingReply" ADD CONSTRAINT "WorkflowAwaitingReply_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowAwaitingReply" ADD CONSTRAINT "WorkflowAwaitingReply_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowAwaitingReply" ADD CONSTRAINT "WorkflowAwaitingReply_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowContactState" ADD CONSTRAINT "WorkflowContactState_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowContactState" ADD CONSTRAINT "WorkflowContactState_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceApiKey" ADD CONSTRAINT "WorkspaceApiKey_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiIdempotencyKey" ADD CONSTRAINT "ApiIdempotencyKey_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "WorkspaceApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundWebhook" ADD CONSTRAINT "OutboundWebhook_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundWebhookDelivery" ADD CONSTRAINT "OutboundWebhookDelivery_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "OutboundWebhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationEvent" ADD CONSTRAINT "ConversationEvent_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationEvent" ADD CONSTRAINT "ConversationEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationEvent" ADD CONSTRAINT "ConversationEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationEvent" ADD CONSTRAINT "ConversationEvent_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "WorkspaceApiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChannel" ADD CONSTRAINT "TeamChannel_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChannel" ADD CONSTRAINT "TeamChannel_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChannelMember" ADD CONSTRAINT "TeamChannelMember_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "TeamChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChannelMember" ADD CONSTRAINT "TeamChannelMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChannelMember" ADD CONSTRAINT "TeamChannelMember_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChannelMessage" ADD CONSTRAINT "TeamChannelMessage_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "TeamChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChannelMessage" ADD CONSTRAINT "TeamChannelMessage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
ALTER TABLE "OutboundEvent" ADD CONSTRAINT "OutboundEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_initiatedByUserId_fkey" FOREIGN KEY ("initiatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_answeredByUserId_fkey" FOREIGN KEY ("answeredByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallPermissionRequest" ADD CONSTRAINT "CallPermissionRequest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallPermissionRequest" ADD CONSTRAINT "CallPermissionRequest_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiAssistantConfig" ADD CONSTRAINT "AiAssistantConfig_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiContextDocument" ADD CONSTRAINT "AiContextDocument_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiContextChunk" ADD CONSTRAINT "AiContextChunk_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiContextChunk" ADD CONSTRAINT "AiContextChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "AiContextDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiConversationState" ADD CONSTRAINT "AiConversationState_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationAutomationClaim" ADD CONSTRAINT "ConversationAutomationClaim_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationSessionSummary" ADD CONSTRAINT "ConversationSessionSummary_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCustomerMemory" ADD CONSTRAINT "AiCustomerMemory_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiMessageMetadata" ADD CONSTRAINT "AiMessageMetadata_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiMessageTranscription" ADD CONSTRAINT "AiMessageTranscription_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiAssistantInteraction" ADD CONSTRAINT "AiAssistantInteraction_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiReplySuggestion" ADD CONSTRAINT "AiReplySuggestion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentPolicy" ADD CONSTRAINT "AssignmentPolicy_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentPolicyMember" ADD CONSTRAINT "AssignmentPolicyMember_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "AssignmentPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentPolicyMember" ADD CONSTRAINT "AssignmentPolicyMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentRule" ADD CONSTRAINT "AssignmentRule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentRule" ADD CONSTRAINT "AssignmentRule_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "AssignmentPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentSettings" ADD CONSTRAINT "AssignmentSettings_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ContactToTag" ADD CONSTRAINT "_ContactToTag_A_fkey" FOREIGN KEY ("A") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ContactToTag" ADD CONSTRAINT "_ContactToTag_B_fkey" FOREIGN KEY ("B") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_TicketTags" ADD CONSTRAINT "_TicketTags_A_fkey" FOREIGN KEY ("A") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_TicketTags" ADD CONSTRAINT "_TicketTags_B_fkey" FOREIGN KEY ("B") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AudienceGroupTags" ADD CONSTRAINT "_AudienceGroupTags_A_fkey" FOREIGN KEY ("A") REFERENCES "AudienceGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AudienceGroupTags" ADD CONSTRAINT "_AudienceGroupTags_B_fkey" FOREIGN KEY ("B") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AudienceGroupContacts" ADD CONSTRAINT "_AudienceGroupContacts_A_fkey" FOREIGN KEY ("A") REFERENCES "AudienceGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AudienceGroupContacts" ADD CONSTRAINT "_AudienceGroupContacts_B_fkey" FOREIGN KEY ("B") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- HAND-MAINTAINED — indexes Prisma's schema language CANNOT express.
--
-- DO NOT DELETE. `prisma migrate diff` cannot emit these and, just as
-- importantly, cannot SEE them: it reads schema.prisma, where there is no
-- syntax for a partial index (WHERE), an expression index (lower(), to_tsvector())
-- or an operator class (gin_trgm_ops). So a regenerated baseline silently drops
-- every one of them, and `migrate diff` then reports the result as identical.
-- The same blindness already destroyed six of these once, when a DROP COLUMN in
-- the org->workspace rename took them with it.
--
-- Four are UNIQUE constraints that backstop check-then-act races the application
-- deliberately does not lock for. Losing those does not fail loudly — it silently
-- permits the duplicate row the index existed to prevent:
--     Contact_workspaceId_phoneNumber_whatsapp_key  duplicate WhatsApp contact
--     ContactStage_workspaceId_isDefault_key        two default stages
--     ContactTransferJob_workspaceId_active_key     concurrent import/export runs
--     ChannelConnection_one_default_per_channel     two default accounts on a channel
--     AiReplySuggestion_one_pending_per_inbound     duplicate AI drafts
--     ConversationSessionSummary_one_open_per_conv  two open session summaries
--     InboxView_shared_name_key / _personal_name_key  case-insensitive name clash
--
-- Verified equivalent to the 106-migration history by building both databases
-- and diffing pg_indexes / columns / constraints / enums — not by trusting
-- `migrate diff`, which is blind here. apps/api/test/partial-indexes.spec.ts is
-- the standing tripwire; keep it in lockstep with this section.
-- ============================================================================

CREATE INDEX "AiContextChunk_content_fts_idx" ON public."AiContextChunk" USING gin (to_tsvector('simple'::regconfig, content));
CREATE UNIQUE INDEX "AiReplySuggestion_one_pending_per_inbound" ON public."AiReplySuggestion" USING btree ("workspaceId", "inboundMessageId") WHERE (state = 'pending'::"AiSuggestionState");
CREATE UNIQUE INDEX "ChannelConnection_one_default_per_channel" ON public."ChannelConnection" USING btree ("workspaceId", channel) WHERE "isDefault";
CREATE UNIQUE INDEX "ContactStage_workspaceId_isDefault_key" ON public."ContactStage" USING btree ("workspaceId") WHERE ("isDefault" = true);
CREATE UNIQUE INDEX "ContactTransferJob_workspaceId_active_key" ON public."ContactTransferJob" USING btree ("workspaceId") WHERE (status = ANY (ARRAY['pending'::"ContactTransferStatus", 'running'::"ContactTransferStatus"]));
CREATE INDEX "Contact_phoneNumber_trgm_idx" ON public."Contact" USING gin ("phoneNumber" gin_trgm_ops) WHERE ("phoneNumber" IS NOT NULL);
CREATE INDEX "Contact_workspaceId_marketingCapReachedAt_idx" ON public."Contact" USING btree ("workspaceId", "marketingCapReachedAt") WHERE ("marketingCapReachedAt" IS NOT NULL);
CREATE UNIQUE INDEX "Contact_workspaceId_phoneNumber_whatsapp_key" ON public."Contact" USING btree ("workspaceId", "phoneNumber") WHERE (("phoneNumber" IS NOT NULL) AND ("identityChannel" = 'whatsapp'::"Channel"));
CREATE UNIQUE INDEX "ConversationSessionSummary_one_open_per_conversation" ON public."ConversationSessionSummary" USING btree ("conversationId") WHERE ("sessionEndAt" IS NULL);
CREATE INDEX "Conversation_workspaceId_openFlag_idx" ON public."Conversation" USING btree ("workspaceId", "lastMessageAt" DESC, id DESC) WHERE ("openFlagCount" > 0);
CREATE INDEX "Conversation_workspaceId_unread_idx" ON public."Conversation" USING btree ("workspaceId") WHERE ("unreadCount" > 0);
CREATE UNIQUE INDEX "InboxView_personal_name_key" ON public."InboxView" USING btree ("workspaceId", "createdById", lower(name)) WHERE (visibility = 'personal'::"InboxViewVisibility");
CREATE UNIQUE INDEX "InboxView_shared_name_key" ON public."InboxView" USING btree ("workspaceId", lower(name)) WHERE (visibility = 'shared'::"InboxViewVisibility");
CREATE INDEX "Message_broadcastId_idx" ON public."Message" USING btree ("broadcastId") WHERE ("broadcastId" IS NOT NULL);
CREATE INDEX "Message_conversationId_timestamp_inbound_idx" ON public."Message" USING btree ("conversationId", "timestamp" DESC) WHERE (direction = 'in'::"MessageDirection");
CREATE INDEX "Message_inbound_media_pending_idx" ON public."Message" USING btree ("createdAt") WHERE ((direction = 'in'::"MessageDirection") AND ("mediaKind" IS NOT NULL) AND ("mediaUrl" IS NULL));
CREATE INDEX "Organization_isPlatform_idx" ON public."Organization" USING btree ("isPlatform") WHERE "isPlatform";
CREATE INDEX "OutboundEvent_drainer_pending_idx" ON public."OutboundEvent" USING btree ("createdAt") WHERE (("publishedAt" IS NULL) AND ("failedAt" IS NULL));
CREATE INDEX "OutboundEvent_retention_idx" ON public."OutboundEvent" USING btree ("publishedAt") WHERE (("publishedAt" IS NOT NULL) AND ("failedAt" IS NULL));
CREATE INDEX "OutboundWebhookDelivery_orphan_pending_idx" ON public."OutboundWebhookDelivery" USING btree ("createdAt") WHERE (("attemptCount" = 0) AND ("deliveredAt" IS NULL) AND ("failedAt" IS NULL));
CREATE INDEX "TeamChannelMessage_channel_toplevel_keyset_idx" ON public."TeamChannelMessage" USING btree ("channelId", "createdAt" DESC, id DESC) WHERE ("threadRootId" IS NULL);
CREATE INDEX "Ticket_first_response_due_idx" ON public."Ticket" USING btree ("firstResponseDueAt") WHERE (("firstResponseDueAt" IS NOT NULL) AND ("firstResponseBreached" = false) AND ("firstResponseAt" IS NULL) AND (status <> ALL (ARRAY['solved'::"TicketStatus", 'closed'::"TicketStatus"])));
CREATE INDEX "Ticket_resolution_due_idx" ON public."Ticket" USING btree ("resolutionDueAt") WHERE (("resolutionDueAt" IS NOT NULL) AND ("resolutionBreached" = false) AND (status <> ALL (ARRAY['solved'::"TicketStatus", 'closed'::"TicketStatus"])));
CREATE INDEX "WorkflowRun_active_startedAt_idx" ON public."WorkflowRun" USING btree ("startedAt") WHERE (status = ANY (ARRAY['queued'::"WorkflowRunStatus", 'running'::"WorkflowRunStatus", 'waiting'::"WorkflowRunStatus"]));
CREATE INDEX "WorkflowRun_terminal_startedAt_idx" ON public."WorkflowRun" USING btree ("startedAt") WHERE (status = ANY (ARRAY['completed'::"WorkflowRunStatus", 'failed'::"WorkflowRunStatus", 'skipped'::"WorkflowRunStatus"]));
