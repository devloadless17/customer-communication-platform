-- Portfolio verification status.
--
-- Meta scopes the TEMPLATE limit to the parent business portfolio: unverified
-- caps each WABA under it at 250 templates, verified raises that to up to
-- 6,000. Nothing read that status, so the app could not tell an operator how
-- much template headroom they actually had.
--
-- Additive + nullable: existing rows keep working (null reads as "unverified",
-- the conservative 250) and the next health sweep fills it in.
ALTER TABLE "WhatsappPortfolio" ADD COLUMN "verificationStatus" TEXT;
