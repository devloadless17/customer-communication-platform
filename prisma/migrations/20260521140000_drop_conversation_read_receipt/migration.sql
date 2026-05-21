-- Inbox unread is team-wide ONLY. The per-agent `ConversationReadReceipt`
-- table was never surfaced in the UI (the list always rendered against the
-- team-wide `Conversation.unreadCount`), so it is removed. Team chat keeps its
-- own per-user read state in `TeamChannelReadReceipt`.

-- DropForeignKey
ALTER TABLE "ConversationReadReceipt" DROP CONSTRAINT "ConversationReadReceipt_conversationId_fkey";

-- DropForeignKey
ALTER TABLE "ConversationReadReceipt" DROP CONSTRAINT "ConversationReadReceipt_userId_fkey";

-- DropTable
DROP TABLE "ConversationReadReceipt";
