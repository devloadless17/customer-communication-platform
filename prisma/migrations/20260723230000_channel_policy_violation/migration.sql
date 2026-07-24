-- WhatsApp Business POLICY violations, from the `account_update` webhook.
--
-- We already parsed `ACCOUNT_VIOLATION` but kept only the CALLING ones; every
-- other violation type (ALCOHOL, etc.) was parsed and then dropped. Meta names
-- this webhook as the notification channel for policy violations, and an
-- account restriction follows if the violation isn't addressed — so dropping it
-- meant the first thing a tenant learned was the restriction itself.
ALTER TABLE "ChannelConnection" ADD COLUMN "policyViolationType" TEXT;
ALTER TABLE "ChannelConnection" ADD COLUMN "policyViolationAt" TIMESTAMP(3);
