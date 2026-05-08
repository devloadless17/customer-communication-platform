-- AlterTable
ALTER TABLE "Team" ADD COLUMN     "metaAccessToken" TEXT,
ADD COLUMN     "metaAppSecret" TEXT,
ADD COLUMN     "metaDisplayPhoneNumber" TEXT,
ADD COLUMN     "metaPhoneNumberId" TEXT,
ADD COLUMN     "metaVerifyToken" TEXT,
ADD COLUMN     "metaWabaId" TEXT;

-- CreateTable
CREATE TABLE "Invite" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'agent',
    "tokenHash" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invite_tokenHash_key" ON "Invite"("tokenHash");

-- CreateIndex
CREATE INDEX "Invite_teamId_email_idx" ON "Invite"("teamId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Team_metaPhoneNumberId_key" ON "Team"("metaPhoneNumberId");

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

