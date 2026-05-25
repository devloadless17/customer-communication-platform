-- Contact phone-number substring search. All three search paths match phone
-- with a leading-wildcard LIKE/ILIKE ('%digits%'):
--   - contacts list      (apps/api/src/lib/queries/contacts.ts: ILIKE)
--   - conversation list  (apps/api/src/lib/queries/conversations.ts: contains)
--   - global contact tab (apps/api/src/lib/queries/global-search.ts: contains)
-- The btree `Contact_teamId_phoneNumber_idx` can serve a prefix match but NOT
-- a leading wildcard, so EXPLAIN showed a full Seq Scan on Contact for every
-- phone search. A pg_trgm GIN turns that into a Bitmap Index Scan (verified
-- with EXPLAIN on the dev DB before/after).
--
-- Partial (WHERE phoneNumber IS NOT NULL): non-phone-channel contacts
-- (Instagram/Telegram) carry NULL here and never match a phone search, so
-- excluding them keeps the index smaller. pg_trgm is already enabled (0_init).
-- IF NOT EXISTS for idempotency against a hotfixed DB.
CREATE INDEX IF NOT EXISTS "Contact_phoneNumber_trgm_idx"
  ON "Contact" USING GIN ("phoneNumber" gin_trgm_ops)
  WHERE "phoneNumber" IS NOT NULL;
