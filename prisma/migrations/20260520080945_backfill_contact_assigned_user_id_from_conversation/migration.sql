-- Backfill Contact.assignedUserId from the most recently updated conversation
-- per contact. The inbox assigns at the conversation level; nothing in the UI
-- ever wrote to Contact.assignedUserId, so the external `/v1` API returned
-- null even when the inbox plainly showed an assignee. Going forward
-- conversations.service.assign() + the assign-to workflow step mirror the
-- write onto the contact. This one-shot fills in everything that was assigned
-- before the mirror landed.
--
-- Strategy: for each contact, take the assignedUserId of the most-recently-
-- updated conversation that has one. NULL-assigned conversations don't
-- overwrite a previously-set value. Idempotent — running again on a clean
-- state is a no-op.

UPDATE "Contact" c
SET "assignedUserId" = sub."assignedUserId"
FROM (
  SELECT DISTINCT ON ("contactId")
    "contactId",
    "assignedUserId"
  FROM "Conversation"
  WHERE "assignedUserId" IS NOT NULL
  ORDER BY "contactId", "lastAssignedAt" DESC NULLS LAST, "lastMessageAt" DESC
) sub
WHERE c."id" = sub."contactId"
  AND c."assignedUserId" IS DISTINCT FROM sub."assignedUserId";
