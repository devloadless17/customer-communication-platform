-- Drop four btree indexes that are fully covered by an existing composite, so
-- every write to the hottest tables stops paying their maintenance. None can
-- be the sole server of any query — each is a leftmost-prefix or
-- scan-direction duplicate of a composite that stays. Survived the 2026-06-01
-- "pure write-overhead removal" cleanup; this finishes it.
--
--   1. Message_teamId_idx — leftmost prefix of BOTH the dedupe unique
--      (teamId, channel, externalId) and Message_teamId_timestamp_id_idx.
--   2. Message_conversationId_timestamp_idx — covered by the keyset
--      (conversationId, timestamp DESC, id DESC): a btree scans in either
--      direction, so the DESC,DESC index serves conversationId-equality +
--      ASC/range timestamp scans too.
--   3. InternalNote_teamId_idx — covered by InternalNote_teamId_timestamp_id_idx
--      (teamId-leading).
--   4. Contact_teamId_idx — covered by the teamId-leading composites
--      ([teamId, deletedAt], [teamId, source], [teamId, stageId], ...).
--
-- Message is the highest-write table (every webhook inbound, agent send, and
-- broadcast recipient row), so dropping two of its indexes is the bulk of the
-- win. IF EXISTS keeps it idempotent. No CONCURRENTLY — runs in the migrate
-- transaction; DROP INDEX takes only a brief lock and pilot tables are small.

DROP INDEX IF EXISTS "Message_teamId_idx";
DROP INDEX IF EXISTS "Message_conversationId_timestamp_idx";
DROP INDEX IF EXISTS "InternalNote_teamId_idx";
DROP INDEX IF EXISTS "Contact_teamId_idx";
