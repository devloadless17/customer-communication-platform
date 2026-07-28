-- Backfill Conversation.channelConnectionId for threads created before every
-- create path stamped it.
--
-- WHY THESE ROWS ARE NULL. Inbound-created threads always got the account from
-- the webhook. The nulls are the OUTBOUND-FIRST threads — opened by a
-- broadcast, a workflow send, a forward, a /v1 conversation start, or an
-- inbound CALL — none of which stamped it. That was invisible while
-- `getSendConfig(null)` silently fell back to the channel default; once the
-- account-unresolved guard landed, a workspace with two active accounts on the
-- channel could not send on those threads AT ALL, and the inbox showed them
-- with no account.
--
-- WHY THE DEFAULT ACCOUNT IS THE RIGHT VALUE. Null already MEANT "the channel
-- default" everywhere in the code — that is precisely what the fallback did —
-- so writing it down is behaviour-preserving for single-account workspaces and
-- restores exactly the previous behaviour for multi-account ones, instead of
-- leaving the thread unusable.
--
-- THE ONE IMPRECISION, stated plainly: a thread opened by an inbound CALL to a
-- NON-default number is set here to the default, which may not be the number
-- the customer actually rang. It is not made worse than it was (null behaved as
-- default too), and it self-heals — ingest re-stamps the thread the moment that
-- customer sends a message, and call ingest now stamps and re-stamps as well.
-- Only rows that are still NULL are touched, so this is safe to re-run and
-- cannot overwrite a known-good account.
UPDATE "Conversation" c
SET "channelConnectionId" = cc.id
FROM "ChannelConnection" cc
WHERE c."channelConnectionId" IS NULL
  AND cc."workspaceId" = c."workspaceId"
  AND cc.channel = c.channel
  AND cc."isDefault" = true
  AND cc."isActive" = true;
