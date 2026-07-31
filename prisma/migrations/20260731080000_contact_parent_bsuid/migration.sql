-- BSUID readiness: parent BSUID (cross-portfolio join key) + which portfolio
-- issued the stored bsuid. Purely additive, no backfill — NULL means
-- unknown/legacy and is treated as compatible by the send-side guard.
ALTER TABLE "Contact" ADD COLUMN "parentBsuid" TEXT;
ALTER TABLE "Contact" ADD COLUMN "bsuidPortfolioId" TEXT;

ALTER TABLE "Contact" ADD CONSTRAINT "Contact_bsuidPortfolioId_fkey"
  FOREIGN KEY ("bsuidPortfolioId") REFERENCES "WhatsappPortfolio"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Contact_workspaceId_identityChannel_parentBsuid_idx"
  ON "Contact"("workspaceId", "identityChannel", "parentBsuid");
