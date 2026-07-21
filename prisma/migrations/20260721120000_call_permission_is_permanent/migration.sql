-- Call permissions can be PERMANENT ("always allow calls from this business"),
-- not just a bounded window. This was previously faked by writing an expiresAt
-- a century into the future, which the UI could only render as a countdown to
-- the year 2126 rather than "always allowed".
--
-- Existing rows default to false: a temporary grant is the conservative
-- assumption, and the next permission read from the provider corrects any row
-- that is actually permanent.
ALTER TABLE "CallPermissionRequest"
  ADD COLUMN "isPermanent" BOOLEAN NOT NULL DEFAULT false;
