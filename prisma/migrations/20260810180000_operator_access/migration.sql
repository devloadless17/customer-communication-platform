-- OPERATOR MODE: the append-only record of the platform operator entering a
-- customer's workspace.
--
-- A LOG, NOT A GATE. Access itself is granted by `User.isSuperAdmin` through the
-- operator branch of `makeCanAccessBeyondMembership`
-- (packages/shared/src/auth/active-workspace.ts); this table records that the
-- grant was exercised, on which tenant, and when. See the model's TENANCY
-- EXCEPTION note in schema.prisma before changing either half.
--
-- `userId` and `enteredWorkspaceId` are plain ids with NO foreign key, matching
-- `Organization.statusUpdatedById`: deleting the operator account, or the
-- workspace they visited, must not cascade away the record of the visit.
-- `organizationId` DOES cascade — when a tenant is deleted there is no tenant
-- left to have been entered.
CREATE TABLE "OperatorAccess" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "enteredWorkspaceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperatorAccess_pkey" PRIMARY KEY ("id")
);

-- The platform org page's audit panel: recent entries into THIS org, newest first.
CREATE INDEX "OperatorAccess_organizationId_createdAt_idx"
    ON "OperatorAccess"("organizationId", "createdAt" DESC);
-- "Everywhere this operator has been, newest first" — the platform-wide view.
CREATE INDEX "OperatorAccess_userId_createdAt_idx"
    ON "OperatorAccess"("userId", "createdAt" DESC);

ALTER TABLE "OperatorAccess" ADD CONSTRAINT "OperatorAccess_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
