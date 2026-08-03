-- Select-type custom fields: unlimited client-named "stage-like" dimensions.
--
-- Purely additive and backward-compatible: every existing definition becomes
-- `text` via the column default, and the option catalog starts empty. For
-- select fields the value stored in Contact.customFields[key] is the option
-- ID (rename-stable) — integrity is app-level (delete refuses while in use,
-- with a bulk-move), mirroring ContactStage.
CREATE TYPE "ContactFieldType" AS ENUM ('text', 'select');

ALTER TABLE "ContactFieldDefinition"
    ADD COLUMN "type" "ContactFieldType" NOT NULL DEFAULT 'text';

CREATE TABLE "ContactFieldOption" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'slate',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactFieldOption_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContactFieldOption_fieldId_name_key"
    ON "ContactFieldOption"("fieldId", "name");
CREATE INDEX "ContactFieldOption_workspaceId_idx"
    ON "ContactFieldOption"("workspaceId");
-- The picker's only read: a field's catalog in display order.
CREATE INDEX "ContactFieldOption_fieldId_position_idx"
    ON "ContactFieldOption"("fieldId", "position");

ALTER TABLE "ContactFieldOption" ADD CONSTRAINT "ContactFieldOption_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactFieldOption" ADD CONSTRAINT "ContactFieldOption_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "ContactFieldDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
