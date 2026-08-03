-- Ask a customer once for their email address and store it on the Contact.
--
-- `collectCustomerEmail` defaults TRUE so the behaviour is on for existing
-- workspaces without an admin having to find the switch; it is a contact-detail
-- capture, not an identity key (see docs/identity.md), so turning it on for
-- everyone changes no merge behaviour.
--
-- `emailRequestedAt` is NULL everywhere, which reads as "never asked" — exactly
-- right for threads that predate this.
ALTER TABLE "AiAssistantConfig"
  ADD COLUMN "collectCustomerEmail" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "AiConversationState"
  ADD COLUMN "emailRequestedAt" TIMESTAMP(3);
