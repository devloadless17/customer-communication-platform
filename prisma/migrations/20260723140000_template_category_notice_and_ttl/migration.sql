-- Template category notice, rejection reason, and time-to-live.
--
-- correctCategory: Meta announces a recategorization IN ADVANCE (the template
-- node's `correct_category`, and the notice form of the
-- `template_category_update` webhook) and only applies it on the first of the
-- following month. Folding that into `category` — which the webhook parser used
-- to do — relabelled and MISPRICED a utility template as marketing for up to a
-- month before Meta actually charged marketing rates. It gets its own column so
-- `category` can stay the billed truth.
--
-- statusReason: Meta's `reason` on a status update. "REJECTED" alone is not
-- actionable; "REJECTED / INCORRECT_CATEGORY" tells the author to resubmit under
-- a different category instead of rewriting the copy.
--
-- messageSendTtlSeconds: Meta's `message_send_ttl_seconds`. Nullable and never
-- defaulted locally — absent means "use Meta's per-category default", which is
-- Meta's to define and change.
--
-- All three are additive + nullable, so every existing row keeps working and the
-- next catalog sync fills them in.
ALTER TABLE "MessageTemplate" ADD COLUMN "correctCategory" "TemplateCategory";
ALTER TABLE "MessageTemplate" ADD COLUMN "statusReason" TEXT;
ALTER TABLE "MessageTemplate" ADD COLUMN "messageSendTtlSeconds" INTEGER;

-- Backfill `wabaId`, which no code path has ever written.
--
-- `20260722170000_multi_account_channels` put `wabaId` into the uniqueness key
-- and the sync/create upserts started LOOKING UP rows by the connection's real
-- WABA id — but neither upsert's `create` block ever SET the column, so every
-- row landed with the `''` default. The lookup therefore missed its own row on
-- every subsequent run and tried to insert a duplicate, so the second press of
-- "Sync" failed the whole transaction with a unique violation. The write is
-- fixed in code; these rows still carry the wrong id, and without this backfill
-- the corrected sync would create a parallel set under the real WABA and leave
-- the '' rows orphaned in the picker forever.
--
-- Scoped to workspaces with exactly ONE distinct WABA among their WhatsApp
-- connections: with two, a '' row is genuinely ambiguous and is left alone for
-- the sync to reconcile rather than guessed at. Any workspace that predates
-- multi-account had exactly one, which is every row this can affect.
UPDATE "MessageTemplate" t
SET "wabaId" = w."wabaId"
FROM (
  SELECT "workspaceId", MIN("wabaId") AS "wabaId"
  FROM "ChannelConnection"
  WHERE channel = 'whatsapp' AND "wabaId" IS NOT NULL AND "wabaId" <> ''
  GROUP BY "workspaceId"
  HAVING COUNT(DISTINCT "wabaId") = 1
) w
WHERE t."workspaceId" = w."workspaceId"
  AND t."wabaId" = ''
  -- Never create a collision: skip when the destination key is already taken.
  AND NOT EXISTS (
    SELECT 1 FROM "MessageTemplate" x
    WHERE x."workspaceId" = t."workspaceId"
      AND x."wabaId" = w."wabaId"
      AND x."name" = t."name"
      AND x."language" = t."language"
  );
