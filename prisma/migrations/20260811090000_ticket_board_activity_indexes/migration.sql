-- Ticket board: the assignee- and team-filtered views sort by the SAME key the
-- unfiltered board does (`lastActivityAt`, with the keyset cursor keyed on it),
-- but the only assignee/team composites were keyed on `createdAt`. Postgres
-- therefore matched the index prefix and sorted that agent's ENTIRE ticket set
-- in memory on every "My tickets" page — fine at seed volume, a cliff at a real
-- tenant's. `Conversation` has carried the equivalent
-- (workspaceId, assignedUserId, lastMessageAt DESC, id DESC) since it moved to
-- keyset paging; Ticket was missing its counterpart. (Audit 2026-08-11.)
--
-- Plain CREATE INDEX (not CONCURRENTLY): Prisma runs migrations in a
-- transaction, which CONCURRENTLY forbids. The brief write lock is the correct
-- trade HERE and NOW — the table is small today, and this is precisely the
-- change that gets expensive to make later.
CREATE INDEX IF NOT EXISTS "Ticket_workspaceId_assignedUserId_lastActivityAt_id_idx"
  ON "Ticket" ("workspaceId", "assignedUserId", "lastActivityAt" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "Ticket_workspaceId_assignedTeamId_lastActivityAt_id_idx"
  ON "Ticket" ("workspaceId", "assignedTeamId", "lastActivityAt" DESC, "id" DESC);
