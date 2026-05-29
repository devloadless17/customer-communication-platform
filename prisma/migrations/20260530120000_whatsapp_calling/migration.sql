-- WhatsApp Business Calling — Phase 1 (WebRTC, multi-agent, history).
--
-- Adds two enums (CallStatus, CallDirection), two new tables (Call,
-- CallPermissionRequest), four ConversationEventKind values for the
-- timeline pills, and two columns on Contact mirroring Meta's automatic
-- permission revocation. Phase 2 (SIP recording + transcription) reuses
-- the recordingKey/recordingUrl/transcriptId nullable slots already in
-- the Call model — no further migration needed.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE "CallStatus" AS ENUM (
  'ringing',
  'in_progress',
  'completed',
  'missed',
  'rejected',
  'failed'
);

CREATE TYPE "CallDirection" AS ENUM ('in', 'out');

-- ConversationEventKind gets four new values — terminal call states the
-- audit subscriber writes as inline timeline pills.
ALTER TYPE "ConversationEventKind" ADD VALUE 'call_completed';
ALTER TYPE "ConversationEventKind" ADD VALUE 'call_missed';
ALTER TYPE "ConversationEventKind" ADD VALUE 'call_rejected';
ALTER TYPE "ConversationEventKind" ADD VALUE 'call_failed';

-- ---------------------------------------------------------------------------
-- Contact additions
-- ---------------------------------------------------------------------------
ALTER TABLE "Contact"
  ADD COLUMN "callPermissionRevokedUntil" TIMESTAMP(3),
  ADD COLUMN "consecutiveUnansweredOutCalls" INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Call: voice/video call rows
-- ---------------------------------------------------------------------------
CREATE TABLE "Call" (
  "id" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "externalCallId" TEXT NOT NULL,
  "channel" "Channel" NOT NULL DEFAULT 'whatsapp',
  "direction" "CallDirection" NOT NULL,
  "status" "CallStatus" NOT NULL DEFAULT 'ringing',
  "answeredByUserId" TEXT,
  "ringingAt" TIMESTAMP(3) NOT NULL,
  "answeredAt" TIMESTAMP(3),
  "endedAt" TIMESTAMP(3),
  "durationSeconds" INTEGER,
  "recordingKey" TEXT,
  "recordingUrl" TEXT,
  "transcriptId" TEXT,
  "rawPayload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Call_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Call_teamId_channel_externalCallId_key"
  ON "Call"("teamId", "channel", "externalCallId");

CREATE INDEX "Call_conversationId_ringingAt_idx"
  ON "Call"("conversationId", "ringingAt" DESC);

CREATE INDEX "Call_teamId_status_ringingAt_idx"
  ON "Call"("teamId", "status", "ringingAt" DESC);

CREATE INDEX "Call_teamId_idx" ON "Call"("teamId");

ALTER TABLE "Call"
  ADD CONSTRAINT "Call_teamId_fkey"
    FOREIGN KEY ("teamId") REFERENCES "Team"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "Call_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "Call_answeredByUserId_fkey"
    FOREIGN KEY ("answeredByUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- CallPermissionRequest: outbound permission-request audit + rate-limit mirror
-- ---------------------------------------------------------------------------
CREATE TABLE "CallPermissionRequest" (
  "id" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "externalRequestId" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "rateLimitedUntil" TIMESTAMP(3),

  CONSTRAINT "CallPermissionRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CallPermissionRequest_teamId_contactId_requestedAt_idx"
  ON "CallPermissionRequest"("teamId", "contactId", "requestedAt" DESC);

ALTER TABLE "CallPermissionRequest"
  ADD CONSTRAINT "CallPermissionRequest_teamId_fkey"
    FOREIGN KEY ("teamId") REFERENCES "Team"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CallPermissionRequest_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
