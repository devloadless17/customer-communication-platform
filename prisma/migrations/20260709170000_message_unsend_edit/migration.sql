-- Message unsend / edit (WhatsApp revoke + Messenger/Instagram unsend + WhatsApp
-- edit). `deletedAt` tombstones a customer-removed message (row kept for audit +
-- dedup; bubble renders "deleted"); `editedAt` marks a customer-edited body.
ALTER TABLE "Message" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Message" ADD COLUMN "editedAt" TIMESTAMP(3);
