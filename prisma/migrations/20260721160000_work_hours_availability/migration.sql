-- Working-hours-driven availability.
--
-- Additive and behavior-neutral on deploy: every team starts with
-- "Team"."workHours" NULL and every user with workHoursMode = 'inherit', so no
-- schedule applies to anyone and availability stays exactly as manual as it was
-- until an admin configures hours.

-- Org-default schedule ({ timezone, weekly, exceptions }); NULL = none.
ALTER TABLE "Team" ADD COLUMN "workHours" JSONB;

-- The manual pick behind the (now effective) availabilityStatus/Message pair.
ALTER TABLE "User" ADD COLUMN "availabilityManualStatus" TEXT;
ALTER TABLE "User" ADD COLUMN "availabilityManualMessage" TEXT;
ALTER TABLE "User" ADD COLUMN "availabilitySource" TEXT DEFAULT 'manual';
ALTER TABLE "User" ADD COLUMN "availabilitySetByUserId" TEXT;
ALTER TABLE "User" ADD COLUMN "availabilityOverrideUntil" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "workHoursMode" TEXT NOT NULL DEFAULT 'inherit';
ALTER TABLE "User" ADD COLUMN "workHours" JSONB;

-- Seed the manual pair from the existing status: what every user is showing
-- today IS their manual pick. Without this, the first sweeper tick for a team
-- that later enables hours would resolve their manual status as "never picked"
-- (= available) and silently discard a note they had set.
UPDATE "User"
SET "availabilityManualStatus"  = "availabilityStatus",
    "availabilityManualMessage" = "availabilityMessage";
