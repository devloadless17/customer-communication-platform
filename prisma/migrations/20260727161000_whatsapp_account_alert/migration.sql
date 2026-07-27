-- Account-level alert slot: the last `account_update` event we have no
-- dedicated field for (the class where "app removed from WABA" will land) or
-- `account_alerts` envelope. These used to be warn-logged at info severity and
-- lost — the one webhook class that explains an integration going dark left no
-- queryable trace. One JSON slot, last-writer-wins, policyViolation-style.
--
-- Additive nullable column only — no index, no raw-index section impact.
ALTER TABLE "ChannelConnection" ADD COLUMN "lastAccountAlert" JSONB;
