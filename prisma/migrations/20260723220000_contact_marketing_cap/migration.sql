-- Meta's PER-USER marketing cap (error 131049), recorded per contact.
--
-- Distinct from `marketingOptOutAt`: the person made no choice about us.
-- WhatsApp limits how many marketing templates a user receives from ANY
-- business based on their own read rate and inbox activity, and it clears on
-- its own.
--
-- Stamped so a new marketing campaign can skip them for 24 hours. Meta: resend
-- sooner and you get more of the same error, and a WABA that repeatedly retries
-- capped users can have delivery to those users cut off for up to 24 hours.
ALTER TABLE "Contact" ADD COLUMN "marketingCapReachedAt" TIMESTAMP(3);

-- Partial index: the audience builder asks "who on this workspace is currently
-- capped", which is a small, recent slice of the table. Matches the shape of the
-- opt-out lookup it sits beside.
CREATE INDEX "Contact_workspaceId_marketingCapReachedAt_idx"
  ON "Contact" ("workspaceId", "marketingCapReachedAt")
  WHERE "marketingCapReachedAt" IS NOT NULL;
