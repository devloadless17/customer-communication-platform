-- Instagram profile signals (follower_count, is_verified_user, follows-business,
-- business-follows) captured at ingest for the contact panel. One additive
-- nullable JSONB column; display-only, never queried/filtered.
ALTER TABLE "Contact" ADD COLUMN "socialProfile" JSONB;
