-- Starter message-flag definitions for every existing org.
--
-- The flags feature is invisible until a definition exists: the message "…"
-- menu hides "Flag as" when the catalog is empty, so a team that never visited
-- Settings → Message flags had no way to discover the feature at all — the
-- only hint was an empty-state page they had to find first.
--
-- Seeded ONLY for teams with zero definitions, so this cannot disturb an org
-- that has already set its own up. It also cannot resurrect deleted flags on a
-- later deploy: a migration runs once, and new orgs get the same set at
-- creation instead (registration).
INSERT INTO "MessageFlagDefinition" ("id", "teamId", "name", "color", "description", "sortOrder", "updatedAt")
SELECT
  'mfd_' || substr(md5(random()::text || t."id" || d.name), 1, 20),
  t."id",
  d.name,
  d.color,
  d.description,
  d.sort_order,
  NOW()
FROM "Team" t
CROSS JOIN (VALUES
  ('Complaint',      'rose',   'The customer is unhappy — needs a follow-up.',        0),
  ('Refund request', 'amber',  'The customer asked for money back.',                  1),
  ('Follow up',      'sky',    'Come back to this one later.',                        2),
  ('Urgent',         'orange', 'Needs attention before anything else in the queue.',  3)
) AS d(name, color, description, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM "MessageFlagDefinition" existing WHERE existing."teamId" = t."id"
);
