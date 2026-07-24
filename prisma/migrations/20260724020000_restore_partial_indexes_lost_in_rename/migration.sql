-- Restore the six hand-written PARTIAL indexes that the org→workspace rename
-- silently destroyed.
--
-- WHAT HAPPENED. `20260722160000_workspaces_org_restructure` renamed the tenant
-- column by `ALTER TABLE … DROP COLUMN "teamId"` + adding "workspaceId".
-- Dropping a column drops every index whose key references it — including the
-- raw-SQL partial indexes Prisma has no record of, because they cannot be
-- expressed in the schema DSL. The migration re-created the ones Prisma knows
-- about (they are regenerated from schema.prisma every time) and three it
-- re-issued by hand; the partials below were never re-created and have been
-- absent from every database that ran that migration.
--
-- The tell is exact: every raw partial index whose key included `teamId` is
-- gone, and every raw partial index that did NOT reference it
-- (ChannelConnection_one_default_per_channel,
-- ConversationSessionSummary_one_open_per_conversation,
-- OutboundEvent_drainer_pending_idx) is still there.
--
-- WHY IT MATTERS. Four of the six are UNIQUE — they are correctness, not speed,
-- and each backstops a documented check-then-act race that the application layer
-- deliberately does NOT hold a lock for:
--
--   * Contact_workspaceId_phoneNumber_whatsapp_key — two simultaneous first-time
--     WhatsApp inbounds from one number both insert a Contact, which splits the
--     person into two contacts and two threads. `lib/providers/ingest.ts` names
--     this index as its backstop and retries P2002 on the strength of it; with
--     the index gone there is no P2002 to retry and the duplicate simply lands.
--     This is the §7 "one conversation per contact" invariant.
--   * ContactTransferJob_workspaceId_active_key — two concurrent 100k imports for
--     one tenant, which is the memory spike the per-workspace cap exists to stop.
--   * ContactStage_workspaceId_isDefault_key — two default stages, so which one a
--     new contact lands in becomes whichever row sorts first.
--   * AiReplySuggestion_one_pending_per_inbound — two pending AI suggestions for
--     one inbound message.
--
-- The other two are the partial indexes the inbox sidebar's unread counts and the
-- flagged-conversation filter were written against.
--
-- IF THIS FAILS on a `CREATE UNIQUE INDEX`, the database already contains rows
-- that violate the constraint (they became possible the moment the index went
-- away). Find them with the matching query in each comment below, reconcile, and
-- re-run. `CONCURRENTLY` is deliberately NOT used: these tables are small at this
-- scale, and a non-concurrent build inside the migration transaction is the
-- honest choice over a build that can leave an INVALID index behind.

-- ---------------------------------------------------------------------------
-- 1. WhatsApp contact identity. Partial: WhatsApp rows with a phone only, so
--    Instagram/Messenger contacts that happen to carry the same digits are
--    unaffected, and the slot is held ACROSS `deletedAt` (a soft-deleted contact
--    is revived rather than duplicated).
--    Violations: SELECT "workspaceId","phoneNumber" FROM "Contact"
--      WHERE "phoneNumber" IS NOT NULL AND "identityChannel"='whatsapp'
--      GROUP BY 1,2 HAVING count(*)>1;
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "Contact_workspaceId_phoneNumber_whatsapp_key"
  ON "Contact" ("workspaceId", "phoneNumber")
  WHERE "phoneNumber" IS NOT NULL AND "identityChannel" = 'whatsapp';

-- ---------------------------------------------------------------------------
-- 2. At most ONE active (pending|running) contact transfer per workspace. The
--    service pre-checks with a COUNT; this is the backstop that makes the
--    pre-check safe under concurrency. It maps the P2002 to the same 409.
--    Violations: SELECT "workspaceId" FROM "ContactTransferJob"
--      WHERE status IN ('pending','running') GROUP BY 1 HAVING count(*)>1;
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "ContactTransferJob_workspaceId_active_key"
  ON "ContactTransferJob" ("workspaceId")
  WHERE status IN ('pending', 'running');

-- ---------------------------------------------------------------------------
-- 3. Exactly one default lifecycle stage per workspace. Ingest reads "the
--    default stage" for every brand-new contact; two defaults make that
--    non-deterministic.
--    Violations: SELECT "workspaceId" FROM "ContactStage"
--      WHERE "isDefault" GROUP BY 1 HAVING count(*)>1;
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "ContactStage_workspaceId_isDefault_key"
  ON "ContactStage" ("workspaceId")
  WHERE "isDefault" = true;

-- ---------------------------------------------------------------------------
-- 4. One PENDING AI reply suggestion per inbound message — the arbiter that
--    stops two orchestrator passes both offering an answer to the same message.
--    Violations: SELECT "workspaceId","inboundMessageId" FROM "AiReplySuggestion"
--      WHERE state='pending' GROUP BY 1,2 HAVING count(*)>1;
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "AiReplySuggestion_one_pending_per_inbound"
  ON "AiReplySuggestion" ("workspaceId", "inboundMessageId")
  WHERE state = 'pending';

-- ---------------------------------------------------------------------------
-- 5. Unread counts — the inbox sidebar's most-repeated DB work (5 filtered
--    COUNT()s per render). Partial because zero-unread rows dominate: a full
--    index on `unreadCount` would be mostly zeros and would bloat every
--    markRead write.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "Conversation_workspaceId_unread_idx"
  ON "Conversation" ("workspaceId")
  WHERE "unreadCount" > 0;

-- ---------------------------------------------------------------------------
-- 6. Flagged-conversation filter. `openFlagCount > 0` is a range predicate, so
--    putting it between workspaceId and the sort key would forfeit the ordered
--    index scan; partial keeps it to the flagged rows AND lets the planner walk
--    it in sort order and stop at LIMIT.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "Conversation_workspaceId_openFlag_idx"
  ON "Conversation" ("workspaceId", "lastMessageAt" DESC, "id" DESC)
  WHERE "openFlagCount" > 0;
