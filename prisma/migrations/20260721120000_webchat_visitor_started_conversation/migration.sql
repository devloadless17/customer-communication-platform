-- AlterEnum
-- A website-widget visitor deliberately started a new conversation. One ADD VALUE,
-- not used in this migration, so it commits fine inside the migration transaction.
ALTER TYPE "ConversationEventKind" ADD VALUE 'visitor_started_conversation';
