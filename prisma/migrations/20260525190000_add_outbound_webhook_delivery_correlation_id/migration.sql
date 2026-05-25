-- F6 (docs/architecture-review-2026-05-25.md): trace an outbound webhook
-- delivery back to the request that caused it. Nullable, additive, no backfill
-- needed (existing rows simply carry NULL and ship no X-CCP-Trace-Id header).
ALTER TABLE "OutboundWebhookDelivery" ADD COLUMN "correlationId" TEXT;
