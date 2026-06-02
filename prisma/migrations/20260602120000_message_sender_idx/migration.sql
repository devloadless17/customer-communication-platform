-- FK index for Message.senderUserId (the `sender` relation, onDelete: SetNull).
-- Without it, hard-deleting a teammate seq-scans the Message table to NULL their
-- authored rows — a latent lock/slow at scale. Matches the Prisma-generated name
-- for `@@index([senderUserId])` so schema and DB stay drift-free. IF NOT EXISTS
-- keeps it idempotent.
CREATE INDEX IF NOT EXISTS "Message_senderUserId_idx" ON "Message"("senderUserId");
