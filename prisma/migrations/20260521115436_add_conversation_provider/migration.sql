-- NOTE: spurious DROP INDEX "Contact_customFields_gin_idx" stripped — the
-- index is hand-managed in the init migration's raw-SQL section. Same drift
-- quirk as the prior migrations; see schema.prisma's Contact model comment.

-- AlterTable: channel ownership moves to the conversation (source of truth for
-- "which channel"). Existing rows backfill to meta_cloud via the default —
-- correct since every conversation today is WhatsApp.
ALTER TABLE "Conversation" ADD COLUMN     "provider" "ProviderName" NOT NULL DEFAULT 'meta_cloud';
