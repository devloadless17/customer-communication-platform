-- Move existing ticket comments into the thread.
--
-- COPY, never delete. `TicketAttachment.event` is onDelete: CASCADE, so
-- deleting a migrated `escalation_note` event destroys its attachment rows —
-- and 24h later the blob-orphan sweeper deletes the customer-uploaded files
-- those rows were protecting. That exact failure class is recorded four times
-- in CLAUDE.md §18. The source events stay; `listTicketEvents` excludes the
-- kind, so the log is clean and the file still renders exactly once (in the
-- thread, via `messageId`).
--
-- The message REUSES the event's id, which makes both statements idempotent
-- and re-runnable. Cuids are opaque; sharing one across two tables is harmless.

INSERT INTO "TicketMessage" (
    "id", "workspaceId", "ticketId", "authorWorkspaceId",
    "authorUserId", "authorApiKeyId", "body", "createdAt"
)
SELECT
    e."id", e."workspaceId", e."ticketId", e."actorWorkspaceId",
    e."actorUserId", e."actorApiKeyId", e."body", e."createdAt"
FROM "TicketEvent" e
WHERE e."kind" = 'escalation_note'
  AND e."body" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;

-- Re-point the files those comments carried. Guarded by EXISTS so an
-- attachment on a non-comment event (a raise-time file) is left alone.
UPDATE "TicketAttachment" a
SET "messageId" = a."eventId"
WHERE a."eventId" IS NOT NULL
  AND a."messageId" IS NULL
  AND EXISTS (SELECT 1 FROM "TicketMessage" m WHERE m."id" = a."eventId");
