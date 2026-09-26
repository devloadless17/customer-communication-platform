-- AI assistant: generalise the one-off "ask for an email" switch into an
-- ORDERED list of contact details the assistant may collect.
--
-- Both replaced columns carry their value FORWARD, so no workspace loses a
-- setting and no customer gets re-asked something they were already asked.
--
-- EXPAND ONLY — the replaced columns are deliberately NOT dropped here. The
-- deploy applies migrations while the PREVIOUS release is still serving, and
-- auto-rollback swaps code images, never the schema (see the ship step in
-- .github/workflows/deploy.yml). That release reads both columns: Prisma names
-- every column of its schema in a `findUnique` with no `select`, so dropping
-- them failed every AI reply with P2022 for the length of the swap — and for
-- good if the health gate rolled back. They are RETIRED in schema.prisma; a
-- later release drops them (the contract step).

-- 1. AiAssistantConfig: collectCustomerEmail (bool) -> collectFields (ordered list)
ALTER TABLE "AiAssistantConfig"
  ADD COLUMN "collectFields" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "collectTiming" TEXT NOT NULL DEFAULT 'natural';

UPDATE "AiAssistantConfig"
   SET "collectFields" = '[{"target":"email"}]'::jsonb
 WHERE "collectCustomerEmail" = true;

-- 2. AiConversationState: emailRequestedAt (timestamp) -> requestedDetails (map)
--
-- A thread that was already asked keeps its marker under the `email` key, so
-- the assistant does not re-ask a customer who has already declined once.
-- The column is a `timestamp` holding UTC wall time, so it is formatted as-is:
-- `AT TIME ZONE 'UTC'` would turn it into a timestamptz that `to_char` then
-- renders in the SESSION's zone.
ALTER TABLE "AiConversationState"
  ADD COLUMN "requestedDetails" JSONB NOT NULL DEFAULT '{}';

UPDATE "AiConversationState"
   SET "requestedDetails" = jsonb_build_object(
         'email',
         to_char("emailRequestedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       )
 WHERE "emailRequestedAt" IS NOT NULL;
