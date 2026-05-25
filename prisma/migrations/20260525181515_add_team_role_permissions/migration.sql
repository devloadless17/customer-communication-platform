-- Per-role capability overrides set by a team admin. Sparse JSON of the shape
-- `{ manager?: { "<capability>": boolean }, agent?: {...} }`. Missing key falls
-- back to the default in packages/shared/src/auth/permissions.ts, which
-- reproduces pre-feature behavior — so existing teams (default '{}') are
-- unchanged until an admin toggles a capability off. admin/superAdmin are never
-- stored here (always-allowed, not editable), mirroring the existing
-- `contactPanelBuiltins` sparse-map pattern on this table.

ALTER TABLE "Team" ADD COLUMN "rolePermissions" JSONB NOT NULL DEFAULT '{}';
