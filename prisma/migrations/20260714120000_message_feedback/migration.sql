-- The customer's 👍/👎 "message feedback" on a business-sent Messenger message
-- (Meta `response_feedback`) — a distinct helpful/not-helpful signal, NOT an
-- emoji reaction. Nullable, no backfill. "positive" | "negative".
ALTER TABLE "Message" ADD COLUMN "feedback" TEXT;
