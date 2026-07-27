-- admin:settings scope (2026-07-27). Twenty /v1 routes whose internal twin is
-- admin-gated (assignment config, ticket settings/SLA/fields, WhatsApp
-- profile + QR codes, others' availability) moved from the generic write
-- scopes onto the new `admin:settings` scope.
--
-- GRANDFATHER: every live key that holds any of the three scopes those routes
-- used to ride on keeps exactly its current reach — existing partner
-- integrations must not 403 after this deploy. Only NEW keys are
-- least-privilege by default. Wildcard keys pass hasScope("*") and need
-- nothing; revoked keys stay untouched (their scopes are already inert).
UPDATE "WorkspaceApiKey"
SET    "scopes" = array_append("scopes", 'admin:settings')
WHERE  "revokedAt" IS NULL
  AND  NOT ('*' = ANY("scopes"))
  AND  NOT ('admin:settings' = ANY("scopes"))
  AND  ("scopes" && ARRAY['write:catalog','write:tickets','write:users']);
