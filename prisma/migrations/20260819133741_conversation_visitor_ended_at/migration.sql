-- Webchat: the visitor ended the session from their side.
--
-- Their browser identity is rotated on "End chat", so this conversation can
-- never receive another inbound and the visitor will never see another
-- outbound. Distinct from `closedAt` (an agent closing a thread the visitor can
-- still reopen) and from a closed tab (which returns to waiting history).
ALTER TABLE "Conversation" ADD COLUMN "visitorEndedAt" TIMESTAMP(3);

