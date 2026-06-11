-- Per-org hard cap on active member accounts. Default 2; a superAdmin can raise
-- it from the platform org-detail page. Existing orgs adopt the default 2 (they
-- can be raised individually if already larger — the cap only blocks NEW adds).
ALTER TABLE "Team" ADD COLUMN "maxMembers" INTEGER NOT NULL DEFAULT 2;
