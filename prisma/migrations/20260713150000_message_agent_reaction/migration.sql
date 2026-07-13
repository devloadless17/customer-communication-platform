-- Business-side reaction: our team's reaction to a message, separate from the
-- customer's `reaction` so both can coexist on the same message (previously a
-- single column, so a customer reaction and an agent reaction clobbered each
-- other). Nullable, no backfill — null means "we haven't reacted".
ALTER TABLE "Message" ADD COLUMN "agentReaction" TEXT;
