-- The report's "who replied" / "who clicked" drill-downs filter
-- WHERE broadcastId = ? AND repliedAt/clickedAt IS NOT NULL ORDER BY id.
-- Neither predicate is in any existing index, so on a 100k-recipient campaign
-- every drill-down page heap-scanned the whole campaign's rows and re-filtered
-- — and did it again per "Load more". Partial on the NOT NULL predicate: the
-- engaged subset is a small fraction of a large audience, and the trailing
-- `id` keeps each page a bounded range scan from the keyset cursor (the same
-- lesson as [broadcastId, status, id]).
--
-- Post-baseline partial indexes live in their own migration (see the note in
-- 0_init's hand-maintained section) and in apps/api/test/partial-indexes.spec.ts.
CREATE INDEX "BroadcastRecipient_replied_idx" ON "BroadcastRecipient" ("broadcastId", "id") WHERE "repliedAt" IS NOT NULL;
CREATE INDEX "BroadcastRecipient_clicked_idx" ON "BroadcastRecipient" ("broadcastId", "id") WHERE "clickedAt" IS NOT NULL;
