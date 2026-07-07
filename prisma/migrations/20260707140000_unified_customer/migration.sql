-- Unified Customer (§6 / docs/identity.md): the person-layer above channel-
-- scoped Contacts. Additive + backfilled 1:1, so every existing contact keeps
-- behaving exactly as before — it just now rolls up to a Customer.

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Customer_teamId_idx" ON "Customer"("teamId");

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "customerId" TEXT;

-- CreateIndex
CREATE INDEX "Contact_customerId_idx" ON "Contact"("customerId");

-- Backfill: one Customer per existing Contact, linked 1:1. We reuse the
-- contact's id as the customer id so the mapping is guaranteed 1:1 with a pure
-- set-based statement (no join key, no per-row loop). Customer and Contact are
-- separate tables, so sharing a string id is harmless; post-migration the app
-- mints fresh cuids for new customers. `updatedAt` is set to now() since a
-- Contact has no updatedAt column.
INSERT INTO "Customer" ("id", "teamId", "name", "createdAt", "updatedAt")
SELECT "id", "teamId", "name", "createdAt", now() FROM "Contact";
UPDATE "Contact" SET "customerId" = "id";

-- AddForeignKey (after backfill — the links are already satisfied)
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
