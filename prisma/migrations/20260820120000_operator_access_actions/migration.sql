-- OPERATOR MODE: the log grows from "the operator was here" to "the operator
-- did THIS" — entry rows keep action='enter' (the column default backfills
-- them), and the high-blast-radius actions (broadcast_send, api_key_create,
-- outbound_webhook_create, contact_export) now write their own rows, because
-- spending a tenant's money or minting a lasting credential deserves its own
-- line in the audit panel, not just the entry that preceded it.
-- `recordOperatorAction` (apps/api/src/lib/workspaces/operator-log.ts) is the
-- one writer; the record is awaited BEFORE the irreversible step, same
-- reasoning as the entry route.
ALTER TABLE "OperatorAccess" ADD COLUMN "action" TEXT NOT NULL DEFAULT 'enter';
ALTER TABLE "OperatorAccess" ADD COLUMN "detail" JSONB;
