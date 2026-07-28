-- Customer call-permission decisions as visible timeline pills. Additive enum
-- values only (PG 16 allows ADD VALUE inside a transaction as long as the new
-- value isn't used in the same transaction — and this migration only adds).
ALTER TYPE "ConversationEventKind" ADD VALUE IF NOT EXISTS 'callback_requested';
ALTER TYPE "ConversationEventKind" ADD VALUE IF NOT EXISTS 'call_permission_granted';
ALTER TYPE "ConversationEventKind" ADD VALUE IF NOT EXISTS 'call_permission_declined';
