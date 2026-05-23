-- DropIndex
DROP INDEX "Contact_customFields_gin_idx";

-- AlterTable
ALTER TABLE "ApiIdempotencyKey" ADD COLUMN     "requestHash" TEXT;
