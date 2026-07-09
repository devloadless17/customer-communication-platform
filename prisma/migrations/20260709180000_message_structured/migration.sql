-- Structured non-media message content (shared location pin / contact card) that
-- gets a dedicated bubble. Shape = MessageStructured (kind: location | contacts).
ALTER TABLE "Message" ADD COLUMN "structured" JSONB;
