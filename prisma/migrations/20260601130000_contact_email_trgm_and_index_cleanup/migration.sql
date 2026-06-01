-- Dim 12 index work from the deep production audit (2026-06-01).
--
-- 1. Contact_email_trgm_idx — the email OR-arm of team-wide contact search
--    (global-search.ts: `email contains query` → ILIKE '%..%') had no trgm
--    index, so it degraded to a seq-scan of the team's contact partition while
--    name/phone rode their trgm indexes. Non-partial GIN: NULL emails extract
--    no trigrams, so they're skipped without a WHERE clause. Prisma-DSL
--    expressible (declared as @@index in schema.prisma, same as the name trgm).
--
-- 2. WorkflowContactState_contactId_idx — the (workflowId, contactId) unique
--    leads with workflowId, so a contactId-only lookup (reconciling rows after
--    a contact hard-purge) seq-scanned. Btree on contactId. Prisma-DSL
--    expressible.
--
-- 3+4. Drop Tag_teamId_idx / AudienceGroup_teamId_idx — both redundant with
--    their (teamId, name) unique, which already serves teamId-prefix lookups.
--    Pure write-overhead removal.
--
-- CONCURRENTLY skipped: runs at migration time inside the migrate transaction.
-- A brief write lock on the pilot-scale Contact table is acceptable (see the
-- populated-DB migration smoke note in .github/workflows/deploy.yml).

CREATE INDEX IF NOT EXISTS "Contact_email_trgm_idx"
  ON public."Contact" USING gin (email public.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "WorkflowContactState_contactId_idx"
  ON public."WorkflowContactState" ("contactId");

DROP INDEX IF EXISTS "Tag_teamId_idx";
DROP INDEX IF EXISTS "AudienceGroup_teamId_idx";
