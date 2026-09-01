-- AI assistant: generalise the one-off "ask for an email" switch into an
-- ORDERED list of contact details the assistant may collect.
--
-- Both replaced columns carry their value FORWARD before being dropped, so no
-- workspace loses a setting and no customer gets re-asked something they were
-- already asked. The order below is load-bearing: back-fill, then drop.

-- 1. AiAssistantConfig: collectCustomerEmail (bool) -> collectFields (ordered list)
ALTER TABLE "AiAssistantConfig"
  ADD COLUMN "collectFields" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "collectTiming" TEXT NOT NULL DEFAULT 'natural';

UPDATE "AiAssistantConfig"
   SET "collectFields" = '[{"target":"email"}]'::jsonb
 WHERE "collectCustomerEmail" = true;

ALTER TABLE "AiAssistantConfig" DROP COLUMN "collectCustomerEmail";

-- 2. AiConversationState: emailRequestedAt (timestamp) -> requestedDetails (map)
--
-- A thread that was already asked keeps its marker under the `email` key, so
-- the assistant does not re-ask a customer who has already declined once.
ALTER TABLE "AiConversationState"
  ADD COLUMN "requestedDetails" JSONB NOT NULL DEFAULT '{}';

UPDATE "AiConversationState"
   SET "requestedDetails" = jsonb_build_object(
         'email',
         to_char("emailRequestedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       )
 WHERE "emailRequestedAt" IS NOT NULL;

ALTER TABLE "AiConversationState" DROP COLUMN "emailRequestedAt";
