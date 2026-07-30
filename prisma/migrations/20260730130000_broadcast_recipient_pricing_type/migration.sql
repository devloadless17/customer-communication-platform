-- Meta's `pricing.type` from the message status webhook: WHY a message was or
-- wasn't charged (`regular`, `free_customer_service`, `free_entry_point`,
-- `free_group_customer_service`).
--
-- Nullable with no default and no backfill, deliberately. Rows that landed
-- before this column existed genuinely do not know their pricing type, and Meta
-- cannot be re-asked per message — a default would assert `regular` for
-- historical free-window sends and misreport what they cost.
ALTER TABLE "BroadcastRecipient" ADD COLUMN "pricingType" TEXT;
