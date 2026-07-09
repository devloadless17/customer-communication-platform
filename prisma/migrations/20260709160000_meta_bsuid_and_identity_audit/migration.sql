-- Contact: WhatsApp BSUID forward-compat (Meta 2026 privacy rollout) + @username.
-- Nullable — every contact is NULL today (phone stays the identity). The sparse
-- index resolves a WhatsApp contact by its business-scoped id when a webhook
-- omits the phone.
ALTER TABLE "Contact" ADD COLUMN "bsuid" TEXT;
ALTER TABLE "Contact" ADD COLUMN "username" TEXT;

CREATE INDEX "Contact_teamId_identityChannel_bsuid_idx" ON "Contact"("teamId", "identityChannel", "bsuid");

-- Persisted audit for the manual, reversible customer merge/split (§6).
CREATE TYPE "CustomerIdentityAction" AS ENUM ('link', 'unlink');

CREATE TABLE "CustomerIdentityEvent" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "action" "CustomerIdentityAction" NOT NULL,
    "fromCustomerId" TEXT,
    "toCustomerId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerIdentityEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CustomerIdentityEvent_teamId_createdAt_idx" ON "CustomerIdentityEvent"("teamId", "createdAt" DESC);

CREATE INDEX "CustomerIdentityEvent_teamId_contactId_idx" ON "CustomerIdentityEvent"("teamId", "contactId");

ALTER TABLE "CustomerIdentityEvent" ADD CONSTRAINT "CustomerIdentityEvent_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
