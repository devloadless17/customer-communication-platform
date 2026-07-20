-- Trust-on-first-use for widget origin locking.
--
-- Records the host of the first non-loopback page that embeds a widget, so
-- Settings can offer a one-click "lock to this domain" instead of demanding a
-- domain during onboarding (which would break every widget before its first
-- message). Nullable + write-once; never gates a connection on its own.
ALTER TABLE "WebchatWidget" ADD COLUMN "firstSeenOrigin" TEXT;
