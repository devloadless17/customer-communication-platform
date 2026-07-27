-- The message_template_status_update webhook's rich sub-objects
-- (rejection_info explanation + fix recommendation, other_info pause
-- instance, disable_info.disable_date), which the coarse statusReason
-- string cannot carry.
ALTER TABLE "MessageTemplate" ADD COLUMN "statusDetail" JSONB;
