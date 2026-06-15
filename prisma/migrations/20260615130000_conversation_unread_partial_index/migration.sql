-- Partial index serving the 5 unread-filtered COUNT()s in conversations.service
-- counts() (the inbox sidebar's most-repeated DB work). Hand-written because
-- Prisma can't model the `WHERE unreadCount > 0` predicate. Tiny — zero-unread
-- rows dominate, so the index holds only the small actively-unread working set;
-- a NON-partial unreadCount index would be mostly zeros and bloat every markRead
-- write. BitmapAnds with the (teamId,status,...) / (teamId,assignedUserId) indexes
-- for the uMine/uUnassigned/uActive/uClosed variants and serves uAll directly.
-- See migration 0_init's partial-index inventory; migrate-dev will flag this as
-- drift and try to DROP it — strip that spurious DROP (same as the other partials).
CREATE INDEX IF NOT EXISTS "Conversation_teamId_unread_idx"
  ON "Conversation" ("teamId")
  WHERE "unreadCount" > 0;
