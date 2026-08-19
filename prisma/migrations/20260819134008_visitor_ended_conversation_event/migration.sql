-- The timeline line that explains why a webchat thread closed on its own: the
-- visitor pressed "End chat", which rotates their browser identity and makes the
-- thread permanently unreachable.
--
-- Its own migration rather than appended to the column's: that one is already
-- applied and recorded, and editing an applied migration breaks its checksum.
ALTER TYPE "ConversationEventKind" ADD VALUE IF NOT EXISTS 'visitor_ended_conversation';
