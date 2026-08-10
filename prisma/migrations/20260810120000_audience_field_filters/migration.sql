-- Select-field predicates on broadcast audiences.
--
-- AudienceGroup.fieldFilters — stored narrowing predicates ([{ key, optionIds }])
--   applied on every resolution of the group's membership.
-- Broadcast.audienceFieldFilters — the create-time snapshot for the audit trail,
--   sibling of audienceTagIds; never re-evaluated after create.
--
-- Both nullable Json, purely additive — no backfill needed (null = none).

ALTER TABLE "AudienceGroup" ADD COLUMN "fieldFilters" JSONB;

ALTER TABLE "Broadcast" ADD COLUMN "audienceFieldFilters" JSONB;
