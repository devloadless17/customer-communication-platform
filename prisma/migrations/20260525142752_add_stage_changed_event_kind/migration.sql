-- Extend ConversationEventKind with `stage_changed` so the contact-lifecycle
-- transition (Lead → Customer → Churned, etc.) lands in the in-conversation
-- audit timeline alongside assignment and status changes.
--
-- Why this lives on ConversationEvent (the conversation audit table) even
-- though the underlying mutation is on Contact.stageId: every Contact has at
-- most one Conversation (DB-enforced `@@unique([teamId, contactId])`), so the
-- audit "lives where the agent will look for it" — inside the conversation
-- view, not a separate contact-history page. The audit subscriber resolves
-- conversationId via the 1:1 lookup when writing the row.
--
-- ALTER TYPE ... ADD VALUE has historically been transaction-unsafe in
-- Postgres < 12, but is fine standalone on the versions we run (16.x). No
-- IF NOT EXISTS needed — Prisma's migration table prevents re-application.

ALTER TYPE "ConversationEventKind" ADD VALUE 'stage_changed';
