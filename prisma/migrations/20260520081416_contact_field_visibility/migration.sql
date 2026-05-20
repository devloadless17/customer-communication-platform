-- NOTE: Prisma's migrate-dev emitter again wanted to DROP INDEX
-- "Contact_customFields_gin_idx" here. Same drift quirk as in the prior
-- two migrations — the index is hand-managed in the init migration's
-- raw-SQL section. Stripped manually so this migration doesn't drop a
-- live, hand-managed index.

-- AlterTable
ALTER TABLE "ContactFieldDefinition" ADD COLUMN     "isVisible" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Team" ADD COLUMN     "contactPanelBuiltins" JSONB NOT NULL DEFAULT '{}';
