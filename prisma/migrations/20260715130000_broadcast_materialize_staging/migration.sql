-- Staging area for a large broadcast's resolved recipients while it is
-- `materializing`. The create request resolves the audience (locking the
-- snapshot) and stores the { contactId, customerId? }[] here; the
-- broadcast-materialize worker chunk-inserts BroadcastRecipient rows off the
-- request path, then NULLs this column and flips the row to `queued`. Nullable,
-- no default — only large in-flight broadcasts ever carry a value.
ALTER TABLE "Broadcast" ADD COLUMN "materializeRecipients" JSONB;
