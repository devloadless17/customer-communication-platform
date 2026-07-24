-- Template archival.
--
-- Meta auto-archives a template after 12 months of inactivity (no create, edit,
-- send, appeal or unarchive) and DELETES it 28 days later. Archival cannot be
-- opted out of, and the deletion is unrecoverable.
--
-- `archived` becomes its own status because collapsing it into `disabled` — as
-- the status mapper did — hid the two facts that matter: it is RECOVERABLE, and
-- only for 28 days. An operator saw a dead template with no clock and no way
-- back, and lost it permanently when the window ran out.
ALTER TYPE "TemplateStatus" ADD VALUE IF NOT EXISTS 'archived';

-- When the archived state was OBSERVED, which starts the 28-day countdown.
-- Exact when the status webhook delivered it; approximate when a catalog sync
-- found a template already archived — Meta never states an archival date, which
-- is why the UI says "about N days".
ALTER TABLE "MessageTemplate" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- Last actual SEND — the activity that resets Meta's 12-month clock. Lets the
-- app warn before a template is archived instead of only reporting it after.
ALTER TABLE "MessageTemplate" ADD COLUMN "lastUsedAt" TIMESTAMP(3);
