-- The ticket CAUSE/description: why this ticket exists, in the raising agent's
-- words. Read by whoever the ticket is handed to. Nullable free text.
ALTER TABLE "Ticket" ADD COLUMN "description" TEXT;

-- Audit parity with subject_changed, so editing the cause reads cleanly on the
-- ticket timeline instead of the generic "field_changed". PostgreSQL 12+ allows
-- ADD VALUE inside the migration transaction as long as the value is not USED in
-- the same transaction (it isn't — only referenced by application code later).
ALTER TYPE "TicketEventKind" ADD VALUE 'description_changed';
