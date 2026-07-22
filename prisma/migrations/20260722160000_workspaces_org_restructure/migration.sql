-- Org → Workspace restructure.
-- Team becomes Workspace (the data-isolation boundary); a new Organization root
-- above it holds plan / maxMembers / the approval gate. Roles move to
-- WorkspaceMember (per-workspace); superAdmin becomes User.isSuperAdmin.
--
-- Two hand-fixes to the generated diff, both ordering bugs in the AlterEnum block
-- that narrows Role by removing 'superAdmin':
--   1. It converted WorkspaceMember.role before that table is created later in
--      this same script — removed (the table is created already correctly typed).
--   2. It dropped the old Role type while User.role still existed (that column is
--      dropped further down) — added the User.role conversion before the rename.
-- Generated pre-launch against an EMPTY database.

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('owner', 'admin', 'member');

-- CreateEnum
CREATE TYPE "OrgStatus" AS ENUM ('pending', 'active', 'suspended');

-- AlterEnum
BEGIN;
CREATE TYPE "Role_new" AS ENUM ('admin', 'manager', 'agent');
ALTER TABLE "public"."AssignmentPolicy" ALTER COLUMN "eligibleRoles" DROP DEFAULT;
ALTER TABLE "public"."Invite" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "public"."User" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "Invite" ALTER COLUMN "role" TYPE "Role_new" USING ("role"::text::"Role_new");
ALTER TABLE "AssignmentPolicy" ALTER COLUMN "eligibleRoles" TYPE "Role_new"[] USING ("eligibleRoles"::text::"Role_new"[]);
ALTER TABLE "public"."User" ALTER COLUMN "role" TYPE "Role_new" USING ("role"::text::"Role_new");
ALTER TYPE "Role" RENAME TO "Role_old";
ALTER TYPE "Role_new" RENAME TO "Role";
DROP TYPE "public"."Role_old";
ALTER TABLE "AssignmentPolicy" ALTER COLUMN "eligibleRoles" SET DEFAULT ARRAY[]::"Role"[];
ALTER TABLE "Invite" ALTER COLUMN "role" SET DEFAULT 'agent';
COMMIT;

-- DropForeignKey
ALTER TABLE "AiAssistantConfig" DROP CONSTRAINT "AiAssistantConfig_teamId_fkey";

-- DropForeignKey
ALTER TABLE "AiAssistantInteraction" DROP CONSTRAINT "AiAssistantInteraction_teamId_fkey";

-- DropForeignKey
ALTER TABLE "AiContextChunk" DROP CONSTRAINT "AiContextChunk_teamId_fkey";

-- DropForeignKey
ALTER TABLE "AiContextDocument" DROP CONSTRAINT "AiContextDocument_teamId_fkey";

-- DropForeignKey
ALTER TABLE "AiConversationState" DROP CONSTRAINT "AiConversationState_teamId_fkey";

-- DropForeignKey
ALTER TABLE "AiCustomerMemory" DROP CONSTRAINT "AiCustomerMemory_teamId_fkey";

-- DropForeignKey
ALTER TABLE "AiMessageMetadata" DROP CONSTRAINT "AiMessageMetadata_teamId_fkey";

-- DropForeignKey
ALTER TABLE "AiMessageTranscription" DROP CONSTRAINT "AiMessageTranscription_teamId_fkey";

-- DropForeignKey
ALTER TABLE "AiReplySuggestion" DROP CONSTRAINT "AiReplySuggestion_teamId_fkey";

-- DropForeignKey
ALTER TABLE "ApiIdempotencyKey" DROP CONSTRAINT "ApiIdempotencyKey_apiKeyId_fkey";

-- DropForeignKey
ALTER TABLE "AssignmentPolicy" DROP CONSTRAINT "AssignmentPolicy_teamId_fkey";

-- DropForeignKey
ALTER TABLE "AssignmentRule" DROP CONSTRAINT "AssignmentRule_teamId_fkey";

-- DropForeignKey
ALTER TABLE "AssignmentSettings" DROP CONSTRAINT "AssignmentSettings_teamId_fkey";

-- DropForeignKey
ALTER TABLE "AudienceGroup" DROP CONSTRAINT "AudienceGroup_teamId_fkey";

-- DropForeignKey
ALTER TABLE "Broadcast" DROP CONSTRAINT "Broadcast_teamId_fkey";

-- DropForeignKey
ALTER TABLE "Call" DROP CONSTRAINT "Call_teamId_fkey";

-- DropForeignKey
ALTER TABLE "CallPermissionRequest" DROP CONSTRAINT "CallPermissionRequest_teamId_fkey";

-- DropForeignKey
ALTER TABLE "ChannelConnection" DROP CONSTRAINT "ChannelConnection_teamId_fkey";

-- DropForeignKey
ALTER TABLE "Contact" DROP CONSTRAINT "Contact_teamId_fkey";

-- DropForeignKey
ALTER TABLE "ContactFieldDefinition" DROP CONSTRAINT "ContactFieldDefinition_teamId_fkey";

-- DropForeignKey
ALTER TABLE "ContactStage" DROP CONSTRAINT "ContactStage_teamId_fkey";

-- DropForeignKey
ALTER TABLE "ContactTransferJob" DROP CONSTRAINT "ContactTransferJob_teamId_fkey";

-- DropForeignKey
ALTER TABLE "Conversation" DROP CONSTRAINT "Conversation_teamId_fkey";

-- DropForeignKey
ALTER TABLE "ConversationAutomationClaim" DROP CONSTRAINT "ConversationAutomationClaim_teamId_fkey";

-- DropForeignKey
ALTER TABLE "ConversationEvent" DROP CONSTRAINT "ConversationEvent_apiKeyId_fkey";

-- DropForeignKey
ALTER TABLE "ConversationEvent" DROP CONSTRAINT "ConversationEvent_teamId_fkey";

-- DropForeignKey
ALTER TABLE "ConversationSessionSummary" DROP CONSTRAINT "ConversationSessionSummary_teamId_fkey";

-- DropForeignKey
ALTER TABLE "Customer" DROP CONSTRAINT "Customer_teamId_fkey";

-- DropForeignKey
ALTER TABLE "CustomerIdentityEvent" DROP CONSTRAINT "CustomerIdentityEvent_teamId_fkey";

-- DropForeignKey
ALTER TABLE "InternalNote" DROP CONSTRAINT "InternalNote_teamId_fkey";

-- DropForeignKey
ALTER TABLE "Invite" DROP CONSTRAINT "Invite_teamId_fkey";

-- DropForeignKey
ALTER TABLE "Message" DROP CONSTRAINT "Message_teamId_fkey";

-- DropForeignKey
ALTER TABLE "MessageFlag" DROP CONSTRAINT "MessageFlag_teamId_fkey";

-- DropForeignKey
ALTER TABLE "MessageFlagDefinition" DROP CONSTRAINT "MessageFlagDefinition_teamId_fkey";

-- DropForeignKey
ALTER TABLE "MessageTemplate" DROP CONSTRAINT "MessageTemplate_teamId_fkey";

-- DropForeignKey
ALTER TABLE "MetaConnection" DROP CONSTRAINT "MetaConnection_teamId_fkey";

-- DropForeignKey
ALTER TABLE "OutboundEvent" DROP CONSTRAINT "OutboundEvent_teamId_fkey";

-- DropForeignKey
ALTER TABLE "OutboundSendAttempt" DROP CONSTRAINT "OutboundSendAttempt_teamId_fkey";

-- DropForeignKey
ALTER TABLE "OutboundWebhook" DROP CONSTRAINT "OutboundWebhook_teamId_fkey";

-- DropForeignKey
ALTER TABLE "Snippet" DROP CONSTRAINT "Snippet_teamId_fkey";

-- DropForeignKey
ALTER TABLE "Tag" DROP CONSTRAINT "Tag_teamId_fkey";

-- DropForeignKey
ALTER TABLE "Team" DROP CONSTRAINT "Team_aiHandoffAssigneeId_fkey";

-- DropForeignKey
ALTER TABLE "TeamApiKey" DROP CONSTRAINT "TeamApiKey_teamId_fkey";

-- DropForeignKey
ALTER TABLE "TeamChannel" DROP CONSTRAINT "TeamChannel_teamId_fkey";

-- DropForeignKey
ALTER TABLE "TeamChannelMessage" DROP CONSTRAINT "TeamChannelMessage_teamId_fkey";

-- DropForeignKey
ALTER TABLE "User" DROP CONSTRAINT "User_teamId_fkey";

-- DropForeignKey
ALTER TABLE "WebchatWidget" DROP CONSTRAINT "WebchatWidget_teamId_fkey";

-- DropForeignKey
ALTER TABLE "Workflow" DROP CONSTRAINT "Workflow_teamId_fkey";

-- DropForeignKey
ALTER TABLE "WorkflowAwaitingReply" DROP CONSTRAINT "WorkflowAwaitingReply_teamId_fkey";

-- DropForeignKey
ALTER TABLE "WorkflowContactState" DROP CONSTRAINT "WorkflowContactState_teamId_fkey";

-- DropForeignKey
ALTER TABLE "WorkflowRun" DROP CONSTRAINT "WorkflowRun_teamId_fkey";

-- DropIndex
DROP INDEX "AiAssistantConfig_teamId_key";

-- DropIndex
DROP INDEX "AiAssistantInteraction_teamId_conversationId_createdAt_idx";

-- DropIndex
DROP INDEX "AiAssistantInteraction_teamId_createdAt_idx";

-- DropIndex
DROP INDEX "AiContextChunk_teamId_idx";

-- DropIndex
DROP INDEX "AiContextDocument_teamId_createdAt_idx";

-- DropIndex
DROP INDEX "AiConversationState_teamId_idx";

-- DropIndex
DROP INDEX "AiCustomerMemory_teamId_customerId_kind_idx";

-- DropIndex
DROP INDEX "AiCustomerMemory_teamId_customerId_kind_value_key";

-- DropIndex
DROP INDEX "AiCustomerMemory_teamId_customerId_status_idx";

-- DropIndex
DROP INDEX "AiMessageMetadata_teamId_idx";

-- DropIndex
DROP INDEX "AiMessageTranscription_teamId_idx";

-- DropIndex
DROP INDEX "AiReplySuggestion_teamId_conversationId_state_idx";

-- DropIndex
DROP INDEX "AiReplySuggestion_teamId_inboundMessageId_attempt_idx";

-- DropIndex
DROP INDEX "ApiIdempotencyKey_teamId_apiKeyId_key_key";

-- DropIndex
DROP INDEX "AssignmentPolicy_teamId_archivedAt_idx";

-- DropIndex
DROP INDEX "AssignmentPolicy_teamId_isDefault_idx";

-- DropIndex
DROP INDEX "AssignmentPolicyMember_teamId_idx";

-- DropIndex
DROP INDEX "AssignmentRule_teamId_enabled_position_idx";

-- DropIndex
DROP INDEX "AudienceGroup_teamId_name_key";

-- DropIndex
DROP INDEX "Broadcast_teamId_createdAt_idx";

-- DropIndex
DROP INDEX "Broadcast_teamId_scheduledAt_idx";

-- DropIndex
DROP INDEX "Broadcast_teamId_status_idx";

-- DropIndex
DROP INDEX "Call_teamId_channel_externalCallId_key";

-- DropIndex
DROP INDEX "Call_teamId_idx";

-- DropIndex
DROP INDEX "Call_teamId_status_ringingAt_idx";

-- DropIndex
DROP INDEX "CallPermissionRequest_teamId_contactId_requestedAt_idx";

-- DropIndex
DROP INDEX "ChannelConnection_teamId_channel_key";

-- DropIndex
DROP INDEX "Contact_teamId_createdAt_id_idx";

-- DropIndex
DROP INDEX "Contact_teamId_deletedAt_idx";

-- DropIndex
DROP INDEX "Contact_teamId_identityChannel_bsuid_idx";

-- DropIndex
DROP INDEX "Contact_teamId_identityChannel_externalContactId_key";

-- DropIndex
DROP INDEX "Contact_teamId_lastInboundAt_idx";

-- DropIndex
DROP INDEX "Contact_teamId_phoneNumber_idx";

-- DropIndex
DROP INDEX "Contact_teamId_source_idx";

-- DropIndex
DROP INDEX "Contact_teamId_stageId_idx";

-- DropIndex
DROP INDEX "ContactFieldDefinition_teamId_key_key";

-- DropIndex
DROP INDEX "ContactFieldDefinition_teamId_order_idx";

-- DropIndex
DROP INDEX "ContactStage_teamId_name_key";

-- DropIndex
DROP INDEX "ContactStage_teamId_position_idx";

-- DropIndex
DROP INDEX "ContactTransferJob_teamId_createdAt_idx";

-- DropIndex
DROP INDEX "Conversation_teamId_assignedUserId_idx";

-- DropIndex
DROP INDEX "Conversation_teamId_assignedUserId_lastMessageAt_id_idx";

-- DropIndex
DROP INDEX "Conversation_teamId_contactId_key";

-- DropIndex
DROP INDEX "Conversation_teamId_lastMessageAt_id_idx";

-- DropIndex
DROP INDEX "Conversation_teamId_status_lastMessageAt_idx";

-- DropIndex
DROP INDEX "ConversationAutomationClaim_teamId_conversationId_idx";

-- DropIndex
DROP INDEX "ConversationAutomationClaim_teamId_inboundMessageId_key";

-- DropIndex
DROP INDEX "ConversationSessionSummary_teamId_conversationId_sessionSta_idx";

-- DropIndex
DROP INDEX "Customer_teamId_idx";

-- DropIndex
DROP INDEX "CustomerIdentityEvent_teamId_contactId_idx";

-- DropIndex
DROP INDEX "CustomerIdentityEvent_teamId_createdAt_idx";

-- DropIndex
DROP INDEX "InternalNote_teamId_timestamp_id_idx";

-- DropIndex
DROP INDEX "Invite_teamId_email_idx";

-- DropIndex
DROP INDEX "Message_teamId_channel_externalId_key";

-- DropIndex
DROP INDEX "Message_teamId_timestamp_id_idx";

-- DropIndex
DROP INDEX "MessageFlag_teamId_assignedToId_status_idx";

-- DropIndex
DROP INDEX "MessageFlag_teamId_status_createdAt_id_idx";

-- DropIndex
DROP INDEX "MessageFlagDefinition_teamId_name_key";

-- DropIndex
DROP INDEX "MessageTemplate_teamId_name_language_key";

-- DropIndex
DROP INDEX "MessageTemplate_teamId_status_idx";

-- DropIndex
DROP INDEX "MetaConnection_teamId_key";

-- DropIndex
DROP INDEX "OutboundWebhook_teamId_enabled_idx";

-- DropIndex
DROP INDEX "Snippet_teamId_label_idx";

-- DropIndex
DROP INDEX "Snippet_teamId_name_key";

-- DropIndex
DROP INDEX "Tag_teamId_name_key";

-- DropIndex
DROP INDEX "TeamChannel_teamId_dmKey_key";

-- DropIndex
DROP INDEX "TeamChannel_teamId_kind_lastMessageAt_idx";

-- DropIndex
DROP INDEX "TeamChannel_teamId_lastMessageAt_idx";

-- DropIndex
DROP INDEX "TeamChannel_teamId_name_key";

-- DropIndex
DROP INDEX "TeamChannelMessage_teamId_idx";

-- DropIndex
DROP INDEX "User_teamId_idx";

-- DropIndex
DROP INDEX "WebchatWidget_teamId_idx";

-- DropIndex
DROP INDEX "Workflow_teamId_name_key";

-- DropIndex
DROP INDEX "Workflow_teamId_trigger_published_idx";

-- DropIndex
DROP INDEX "WorkflowAwaitingReply_teamId_contactId_idx";

-- DropIndex
DROP INDEX "WorkflowContactState_teamId_idx";

-- DropIndex
DROP INDEX "WorkflowRun_teamId_startedAt_idx";

-- AlterTable
ALTER TABLE "AiAssistantConfig" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "AiAssistantInteraction" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "AiContextChunk" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "AiContextDocument" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "AiConversationState" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "AiCustomerMemory" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "AiMessageMetadata" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "AiMessageTranscription" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "AiReplySuggestion" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "ApiIdempotencyKey" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "AssignmentPolicy" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "AssignmentPolicyMember" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "AssignmentRule" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "AssignmentSettings" DROP CONSTRAINT "AssignmentSettings_pkey",
DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL,
ADD CONSTRAINT "AssignmentSettings_pkey" PRIMARY KEY ("workspaceId");

-- AlterTable
ALTER TABLE "AudienceGroup" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Broadcast" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Call" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "CallPermissionRequest" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "ChannelConnection" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Contact" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "ContactFieldDefinition" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "ContactStage" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "ContactTransferJob" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Conversation" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "ConversationAutomationClaim" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "ConversationEvent" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "ConversationSessionSummary" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Customer" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "CustomerIdentityEvent" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "InternalNote" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Invite" DROP COLUMN "teamId",
ADD COLUMN     "organizationId" TEXT,
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Message" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "MessageFlag" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "MessageFlagDefinition" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "MessageTemplate" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "MetaConnection" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "OutboundEvent" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "OutboundSendAttempt" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "OutboundWebhook" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "activeWorkspaceId" TEXT;

-- AlterTable
ALTER TABLE "Snippet" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Tag" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "TeamChannel" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "TeamChannelMessage" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "role",
DROP COLUMN "teamId",
ADD COLUMN     "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "orgRole" "OrgRole" NOT NULL DEFAULT 'member',
ADD COLUMN     "organizationId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "WebchatWidget" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Workflow" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "WorkflowAwaitingReply" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "WorkflowContactState" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "WorkflowRun" DROP COLUMN "teamId",
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- DropTable
DROP TABLE "Team";

-- DropTable
DROP TABLE "TeamApiKey";

-- DropEnum
DROP TYPE "TeamStatus";

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "plan" "Plan" NOT NULL DEFAULT 'starter',
    "maxMembers" INTEGER NOT NULL DEFAULT 2,
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

-- CreateIndex
CREATE INDEX "Workspace_organizationId_idx" ON "Workspace"("organizationId");

-- CreateIndex
CREATE INDEX "WorkspaceMember_workspaceId_idx" ON "WorkspaceMember"("workspaceId");

-- CreateIndex
CREATE INDEX "WorkspaceMember_userId_idx" ON "WorkspaceMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMember_userId_workspaceId_key" ON "WorkspaceMember"("userId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceApiKey_tokenHash_key" ON "WorkspaceApiKey"("tokenHash");

-- CreateIndex
CREATE INDEX "WorkspaceApiKey_workspaceId_revokedAt_idx" ON "WorkspaceApiKey"("workspaceId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiAssistantConfig_workspaceId_key" ON "AiAssistantConfig"("workspaceId");

-- CreateIndex
CREATE INDEX "AiAssistantInteraction_workspaceId_conversationId_createdAt_idx" ON "AiAssistantInteraction"("workspaceId", "conversationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AiAssistantInteraction_workspaceId_createdAt_idx" ON "AiAssistantInteraction"("workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AiContextChunk_workspaceId_idx" ON "AiContextChunk"("workspaceId");

-- CreateIndex
CREATE INDEX "AiContextDocument_workspaceId_createdAt_idx" ON "AiContextDocument"("workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AiConversationState_workspaceId_idx" ON "AiConversationState"("workspaceId");

-- CreateIndex
CREATE INDEX "AiCustomerMemory_workspaceId_customerId_status_idx" ON "AiCustomerMemory"("workspaceId", "customerId", "status");

-- CreateIndex
CREATE INDEX "AiCustomerMemory_workspaceId_customerId_kind_idx" ON "AiCustomerMemory"("workspaceId", "customerId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "AiCustomerMemory_workspaceId_customerId_kind_value_key" ON "AiCustomerMemory"("workspaceId", "customerId", "kind", "value");

-- CreateIndex
CREATE INDEX "AiMessageMetadata_workspaceId_idx" ON "AiMessageMetadata"("workspaceId");

-- CreateIndex
CREATE INDEX "AiMessageTranscription_workspaceId_idx" ON "AiMessageTranscription"("workspaceId");

-- CreateIndex
CREATE INDEX "AiReplySuggestion_workspaceId_inboundMessageId_attempt_idx" ON "AiReplySuggestion"("workspaceId", "inboundMessageId", "attempt");

-- CreateIndex
CREATE INDEX "AiReplySuggestion_workspaceId_conversationId_state_idx" ON "AiReplySuggestion"("workspaceId", "conversationId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "ApiIdempotencyKey_workspaceId_apiKeyId_key_key" ON "ApiIdempotencyKey"("workspaceId", "apiKeyId", "key");

-- CreateIndex
CREATE INDEX "AssignmentPolicy_workspaceId_archivedAt_idx" ON "AssignmentPolicy"("workspaceId", "archivedAt");

-- CreateIndex
CREATE INDEX "AssignmentPolicy_workspaceId_isDefault_idx" ON "AssignmentPolicy"("workspaceId", "isDefault");

-- CreateIndex
CREATE INDEX "AssignmentPolicyMember_workspaceId_idx" ON "AssignmentPolicyMember"("workspaceId");

-- CreateIndex
CREATE INDEX "AssignmentRule_workspaceId_enabled_position_idx" ON "AssignmentRule"("workspaceId", "enabled", "position");

-- CreateIndex
CREATE UNIQUE INDEX "AudienceGroup_workspaceId_name_key" ON "AudienceGroup"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "Broadcast_workspaceId_createdAt_idx" ON "Broadcast"("workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Broadcast_workspaceId_status_idx" ON "Broadcast"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "Broadcast_workspaceId_scheduledAt_idx" ON "Broadcast"("workspaceId", "scheduledAt");

-- CreateIndex
CREATE INDEX "Call_workspaceId_status_ringingAt_idx" ON "Call"("workspaceId", "status", "ringingAt" DESC);

-- CreateIndex
CREATE INDEX "Call_workspaceId_idx" ON "Call"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Call_workspaceId_channel_externalCallId_key" ON "Call"("workspaceId", "channel", "externalCallId");

-- CreateIndex
CREATE INDEX "CallPermissionRequest_workspaceId_contactId_requestedAt_idx" ON "CallPermissionRequest"("workspaceId", "contactId", "requestedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ChannelConnection_workspaceId_channel_key" ON "ChannelConnection"("workspaceId", "channel");

-- CreateIndex
CREATE INDEX "Contact_workspaceId_phoneNumber_idx" ON "Contact"("workspaceId", "phoneNumber");

-- CreateIndex
CREATE INDEX "Contact_workspaceId_source_idx" ON "Contact"("workspaceId", "source");

-- CreateIndex
CREATE INDEX "Contact_workspaceId_stageId_idx" ON "Contact"("workspaceId", "stageId");

-- CreateIndex
CREATE INDEX "Contact_workspaceId_identityChannel_bsuid_idx" ON "Contact"("workspaceId", "identityChannel", "bsuid");

-- CreateIndex
CREATE INDEX "Contact_workspaceId_deletedAt_idx" ON "Contact"("workspaceId", "deletedAt");

-- CreateIndex
CREATE INDEX "Contact_teamId_lastInboundAt_idx" ON "Contact"("workspaceId", "lastInboundAt" DESC);

-- CreateIndex
CREATE INDEX "Contact_workspaceId_createdAt_id_idx" ON "Contact"("workspaceId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Contact_workspaceId_identityChannel_externalContactId_key" ON "Contact"("workspaceId", "identityChannel", "externalContactId");

-- CreateIndex
CREATE INDEX "ContactFieldDefinition_workspaceId_order_idx" ON "ContactFieldDefinition"("workspaceId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "ContactFieldDefinition_workspaceId_key_key" ON "ContactFieldDefinition"("workspaceId", "key");

-- CreateIndex
CREATE INDEX "ContactStage_workspaceId_position_idx" ON "ContactStage"("workspaceId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ContactStage_workspaceId_name_key" ON "ContactStage"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "ContactTransferJob_workspaceId_createdAt_idx" ON "ContactTransferJob"("workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_status_lastMessageAt_idx" ON "Conversation"("workspaceId", "status", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_assignedUserId_idx" ON "Conversation"("workspaceId", "assignedUserId");

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_assignedUserId_lastMessageAt_id_idx" ON "Conversation"("workspaceId", "assignedUserId", "lastMessageAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_lastMessageAt_id_idx" ON "Conversation"("workspaceId", "lastMessageAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_workspaceId_contactId_key" ON "Conversation"("workspaceId", "contactId");

-- CreateIndex
CREATE INDEX "ConversationAutomationClaim_workspaceId_conversationId_idx" ON "ConversationAutomationClaim"("workspaceId", "conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationAutomationClaim_workspaceId_inboundMessageId_key" ON "ConversationAutomationClaim"("workspaceId", "inboundMessageId");

-- CreateIndex
CREATE INDEX "ConversationSessionSummary_workspaceId_conversationId_sessi_idx" ON "ConversationSessionSummary"("workspaceId", "conversationId", "sessionStartAt" DESC);

-- CreateIndex
CREATE INDEX "Customer_workspaceId_idx" ON "Customer"("workspaceId");

-- CreateIndex
CREATE INDEX "CustomerIdentityEvent_workspaceId_createdAt_idx" ON "CustomerIdentityEvent"("workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CustomerIdentityEvent_workspaceId_contactId_idx" ON "CustomerIdentityEvent"("workspaceId", "contactId");

-- CreateIndex
CREATE INDEX "InternalNote_teamId_timestamp_id_idx" ON "InternalNote"("workspaceId", "timestamp" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Invite_workspaceId_email_idx" ON "Invite"("workspaceId", "email");

-- CreateIndex
CREATE INDEX "Message_teamId_timestamp_id_idx" ON "Message"("workspaceId", "timestamp" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Message_workspaceId_channel_externalId_key" ON "Message"("workspaceId", "channel", "externalId");

-- CreateIndex
CREATE INDEX "MessageFlag_workspaceId_status_createdAt_id_idx" ON "MessageFlag"("workspaceId", "status", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "MessageFlag_workspaceId_assignedToId_status_idx" ON "MessageFlag"("workspaceId", "assignedToId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MessageFlagDefinition_workspaceId_name_key" ON "MessageFlagDefinition"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "MessageTemplate_workspaceId_status_idx" ON "MessageTemplate"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MessageTemplate_workspaceId_name_language_key" ON "MessageTemplate"("workspaceId", "name", "language");

-- CreateIndex
CREATE UNIQUE INDEX "MetaConnection_workspaceId_key" ON "MetaConnection"("workspaceId");

-- CreateIndex
CREATE INDEX "OutboundWebhook_workspaceId_enabled_idx" ON "OutboundWebhook"("workspaceId", "enabled");

-- CreateIndex
CREATE INDEX "Snippet_workspaceId_label_idx" ON "Snippet"("workspaceId", "label");

-- CreateIndex
CREATE UNIQUE INDEX "Snippet_workspaceId_name_key" ON "Snippet"("workspaceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_workspaceId_name_key" ON "Tag"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "TeamChannel_workspaceId_lastMessageAt_idx" ON "TeamChannel"("workspaceId", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "TeamChannel_workspaceId_kind_lastMessageAt_idx" ON "TeamChannel"("workspaceId", "kind", "lastMessageAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "TeamChannel_workspaceId_name_key" ON "TeamChannel"("workspaceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "TeamChannel_workspaceId_dmKey_key" ON "TeamChannel"("workspaceId", "dmKey");

-- CreateIndex
CREATE INDEX "TeamChannelMessage_workspaceId_idx" ON "TeamChannelMessage"("workspaceId");

-- CreateIndex
CREATE INDEX "User_organizationId_idx" ON "User"("organizationId");

-- CreateIndex
CREATE INDEX "WebchatWidget_workspaceId_idx" ON "WebchatWidget"("workspaceId");

-- CreateIndex
CREATE INDEX "Workflow_workspaceId_trigger_published_idx" ON "Workflow"("workspaceId", "trigger", "published");

-- CreateIndex
CREATE UNIQUE INDEX "Workflow_workspaceId_name_key" ON "Workflow"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "WorkflowAwaitingReply_workspaceId_contactId_idx" ON "WorkflowAwaitingReply"("workspaceId", "contactId");

-- CreateIndex
CREATE INDEX "WorkflowContactState_workspaceId_idx" ON "WorkflowContactState"("workspaceId");

-- CreateIndex
CREATE INDEX "WorkflowRun_workspaceId_startedAt_idx" ON "WorkflowRun"("workspaceId", "startedAt" DESC);

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
ALTER TABLE "WebchatWidget" ADD CONSTRAINT "WebchatWidget_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaConnection" ADD CONSTRAINT "MetaConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Snippet" ADD CONSTRAINT "Snippet_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundSendAttempt" ADD CONSTRAINT "OutboundSendAttempt_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudienceGroup" ADD CONSTRAINT "AudienceGroup_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Broadcast" ADD CONSTRAINT "Broadcast_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalNote" ADD CONSTRAINT "InternalNote_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageFlagDefinition" ADD CONSTRAINT "MessageFlagDefinition_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageFlag" ADD CONSTRAINT "MessageFlag_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowAwaitingReply" ADD CONSTRAINT "WorkflowAwaitingReply_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowContactState" ADD CONSTRAINT "WorkflowContactState_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceApiKey" ADD CONSTRAINT "WorkspaceApiKey_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiIdempotencyKey" ADD CONSTRAINT "ApiIdempotencyKey_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "WorkspaceApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundWebhook" ADD CONSTRAINT "OutboundWebhook_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationEvent" ADD CONSTRAINT "ConversationEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationEvent" ADD CONSTRAINT "ConversationEvent_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "WorkspaceApiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChannel" ADD CONSTRAINT "TeamChannel_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChannelMessage" ADD CONSTRAINT "TeamChannelMessage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundEvent" ADD CONSTRAINT "OutboundEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallPermissionRequest" ADD CONSTRAINT "CallPermissionRequest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiAssistantConfig" ADD CONSTRAINT "AiAssistantConfig_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiContextDocument" ADD CONSTRAINT "AiContextDocument_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiContextChunk" ADD CONSTRAINT "AiContextChunk_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
ALTER TABLE "AssignmentRule" ADD CONSTRAINT "AssignmentRule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentSettings" ADD CONSTRAINT "AssignmentSettings_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

