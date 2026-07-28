-- Origin attribution for user-initiated calls, echoed by Meta's
-- connect/terminate webhooks: the opaque `payload` from a call BUTTON we sent
-- (`cta_payload`) or the `biz_payload` from a wa.me/call deep link
-- (`deeplink_payload`). Previously parsed and then dropped at ingest — the
-- only trace was rawPayload forensics, so a call could never be tied back to
-- the campaign or surface that produced it.
ALTER TABLE "Call" ADD COLUMN "ctaPayload" TEXT;
ALTER TABLE "Call" ADD COLUMN "deeplinkPayload" TEXT;
