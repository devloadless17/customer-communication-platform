-- Provider-level contact blocking (WhatsApp Block Users API).
-- `Contact.blockedAt` mirrors the business number's blocklist entry for this
-- contact: Meta stops their inbounds and rejects every outbound, so the send
-- internals refuse up front and broadcasts skip them. The actor + timeline
-- live on ConversationEvent via the two new kinds.
--
-- Additive nullable column + enum values only — no index (the send-path read
-- is by contact id; broadcasts read it alongside the existing recipient
-- select), no raw-index section impact.
ALTER TABLE "Contact" ADD COLUMN "blockedAt" TIMESTAMP(3);

ALTER TYPE "ConversationEventKind" ADD VALUE 'contact_blocked';
ALTER TYPE "ConversationEventKind" ADD VALUE 'contact_unblocked';
