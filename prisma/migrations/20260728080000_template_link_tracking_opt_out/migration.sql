-- Meta's per-template button-click tracking opt-out
-- (`cta_url_link_tracking_opted_out`). Captured at catalog sync and toggled
-- via the API so the insights UI can say "click tracking is off for this
-- template" instead of rendering an empty click series that reads as broken.
-- Nullable: null = Meta hasn't reported the flag (older Graph), distinct from
-- an explicit false.
ALTER TABLE "MessageTemplate" ADD COLUMN "linkTrackingOptedOut" BOOLEAN;
