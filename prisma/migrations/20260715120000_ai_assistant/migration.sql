-- Native AI Assistant subsystem (additive only). No existing table is altered:
-- the Team relations added in schema.prisma are virtual back-references whose
-- FK columns live on the new child tables below.
--
-- Apply with `prisma migrate deploy`. Alternatively, `prisma migrate dev
-- --name ai_assistant` regenerates an equivalent migration from schema.prisma.

-- CreateEnum
CREATE TYPE "AiAutoReplyMode" AS ENUM ('auto_send', 'draft', 'hybrid');
CREATE TYPE "AiLanguagePolicy" AS ENUM ('match_customer', 'default_language', 'specific');
CREATE TYPE "AiReplyChannelMode" AS ENUM ('text', 'voice', 'match_customer', 'text_and_voice');
CREATE TYPE "AiContextDocStatus" AS ENUM ('processing', 'ready', 'failed', 'disabled');
CREATE TYPE "AiConvAutomationState" AS ENUM ('ai_active', 'human_active', 'ai_paused', 'disabled');
CREATE TYPE "AiAutomationOwner" AS ENUM ('native_ai', 'autopilot', 'workflow');
CREATE TYPE "AiMemoryKind" AS ENUM ('preferred_language', 'dialect', 'script', 'tone', 'communication_style', 'interest', 'recurring_need', 'preference');
CREATE TYPE "AiMemoryStatus" AS ENUM ('candidate', 'confirmed', 'rejected');
CREATE TYPE "AiMemorySource" AS ENUM ('system', 'agent');
CREATE TYPE "AiInteractionDecision" AS ENUM ('replied', 'suggested', 'skipped', 'escalated', 'cancelled', 'failed');
CREATE TYPE "AiSuggestionState" AS ENUM ('pending', 'accepted', 'edited', 'rejected', 'expired');
CREATE TYPE "AiTranscriptionStatus" AS ENUM ('pending', 'ready', 'failed');

-- CreateTable AiAssistantConfig
CREATE TABLE "AiAssistantConfig" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
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
CREATE UNIQUE INDEX "AiAssistantConfig_teamId_key" ON "AiAssistantConfig"("teamId");

-- CreateTable AiContextDocument
CREATE TABLE "AiContextDocument" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
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
CREATE INDEX "AiContextDocument_teamId_createdAt_idx" ON "AiContextDocument"("teamId", "createdAt" DESC);

-- CreateTable AiContextChunk
CREATE TABLE "AiContextChunk" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "tokenCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiContextChunk_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AiContextChunk_teamId_idx" ON "AiContextChunk"("teamId");
CREATE INDEX "AiContextChunk_documentId_ordinal_idx" ON "AiContextChunk"("documentId", "ordinal");
-- Keyword/full-text retrieval fallback (pgvector can replace this later).
CREATE INDEX "AiContextChunk_content_fts_idx" ON "AiContextChunk" USING GIN (to_tsvector('simple', "content"));

-- CreateTable AiConversationState
CREATE TABLE "AiConversationState" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "state" "AiConvAutomationState" NOT NULL DEFAULT 'ai_active',
    "pausedByUserId" TEXT,
    "pausedAt" TIMESTAMP(3),
    "stateChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "autoReplyCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiConversationState_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AiConversationState_conversationId_key" ON "AiConversationState"("conversationId");
CREATE INDEX "AiConversationState_teamId_idx" ON "AiConversationState"("teamId");

-- CreateTable ConversationAutomationClaim
CREATE TABLE "ConversationAutomationClaim" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "inboundMessageId" TEXT NOT NULL,
    "owner" "AiAutomationOwner" NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConversationAutomationClaim_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ConversationAutomationClaim_teamId_inboundMessageId_key" ON "ConversationAutomationClaim"("teamId", "inboundMessageId");
CREATE INDEX "ConversationAutomationClaim_teamId_conversationId_idx" ON "ConversationAutomationClaim"("teamId", "conversationId");

-- CreateTable ConversationSessionSummary
CREATE TABLE "ConversationSessionSummary" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ConversationSessionSummary_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ConversationSessionSummary_teamId_conversationId_sessionStartAt_idx" ON "ConversationSessionSummary"("teamId", "conversationId", "sessionStartAt" DESC);

-- CreateTable AiCustomerMemory
CREATE TABLE "AiCustomerMemory" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "kind" "AiMemoryKind" NOT NULL,
    "value" TEXT NOT NULL,
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
CREATE INDEX "AiCustomerMemory_teamId_customerId_status_idx" ON "AiCustomerMemory"("teamId", "customerId", "status");
CREATE INDEX "AiCustomerMemory_teamId_customerId_kind_idx" ON "AiCustomerMemory"("teamId", "customerId", "kind");

-- CreateTable AiMessageMetadata
CREATE TABLE "AiMessageMetadata" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "model" TEXT,
    "language" TEXT,
    "dialect" TEXT,
    "script" TEXT,
    "intent" TEXT,
    "confidence" DOUBLE PRECISION,
    "interactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiMessageMetadata_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AiMessageMetadata_messageId_key" ON "AiMessageMetadata"("messageId");
CREATE INDEX "AiMessageMetadata_teamId_idx" ON "AiMessageMetadata"("teamId");

-- CreateTable AiMessageTranscription
CREATE TABLE "AiMessageTranscription" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
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
CREATE UNIQUE INDEX "AiMessageTranscription_messageId_key" ON "AiMessageTranscription"("messageId");
CREATE INDEX "AiMessageTranscription_teamId_idx" ON "AiMessageTranscription"("teamId");

-- CreateTable AiAssistantInteraction
CREATE TABLE "AiAssistantInteraction" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
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
CREATE INDEX "AiAssistantInteraction_teamId_conversationId_createdAt_idx" ON "AiAssistantInteraction"("teamId", "conversationId", "createdAt" DESC);
CREATE INDEX "AiAssistantInteraction_teamId_createdAt_idx" ON "AiAssistantInteraction"("teamId", "createdAt" DESC);

-- CreateTable AiReplySuggestion
CREATE TABLE "AiReplySuggestion" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "inboundMessageId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "replyLanguage" TEXT,
    "replyScript" TEXT,
    "channelMode" "AiReplyChannelMode" NOT NULL DEFAULT 'text',
    "audioR2Key" TEXT,
    "usedChunkIds" JSONB NOT NULL DEFAULT '[]',
    "state" "AiSuggestionState" NOT NULL DEFAULT 'pending',
    "editedText" TEXT,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiReplySuggestion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AiReplySuggestion_teamId_inboundMessageId_key" ON "AiReplySuggestion"("teamId", "inboundMessageId");
CREATE INDEX "AiReplySuggestion_teamId_conversationId_state_idx" ON "AiReplySuggestion"("teamId", "conversationId", "state");

-- AddForeignKey (all cascade from Team; AiContextChunk also cascades from its document)
ALTER TABLE "AiAssistantConfig" ADD CONSTRAINT "AiAssistantConfig_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiContextDocument" ADD CONSTRAINT "AiContextDocument_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiContextChunk" ADD CONSTRAINT "AiContextChunk_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiContextChunk" ADD CONSTRAINT "AiContextChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "AiContextDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiConversationState" ADD CONSTRAINT "AiConversationState_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationAutomationClaim" ADD CONSTRAINT "ConversationAutomationClaim_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationSessionSummary" ADD CONSTRAINT "ConversationSessionSummary_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiCustomerMemory" ADD CONSTRAINT "AiCustomerMemory_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiMessageMetadata" ADD CONSTRAINT "AiMessageMetadata_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiMessageTranscription" ADD CONSTRAINT "AiMessageTranscription_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiAssistantInteraction" ADD CONSTRAINT "AiAssistantInteraction_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiReplySuggestion" ADD CONSTRAINT "AiReplySuggestion_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
