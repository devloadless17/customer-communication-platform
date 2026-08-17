/**
 * Built-in contact columns a pre-chat question can fill.
 *
 * The webchat pre-chat form binds each question to a destination by KEY. Most
 * keys name a `ContactFieldDefinition` row, but a workspace's contact schema also
 * includes columns that are NOT definitions — first/last name, location, language,
 * country. They belong in the picker for the same reason they appear on the
 * Contact fields page: from the admin's seat they are simply contact fields, and
 * leaving them out made the picker look broken for a workspace that hasn't
 * created any custom fields yet.
 *
 * Shared because both halves must agree: the settings UI renders these as options,
 * and the API's save-time validator has to accept them alongside real definitions
 * (they resolve to columns, so a definition lookup would reject them).
 *
 * The keys match `BUILTIN_FIELD_BY_SLUG` in
 * `apps/api/src/lib/identity/webchat-prechat.ts`, which is what actually routes a
 * submitted answer onto its column — keep the two in step.
 *
 * Name / email / phone are deliberately ABSENT: they are identity fields with
 * merge semantics, carried by the question's `type` (`name` | `email` | `phone`)
 * rather than by a key.
 */
export const PRECHAT_BUILTIN_TARGETS = [
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
  { key: "location", label: "Location" },
  { key: "language", label: "Language" },
  { key: "country", label: "Country" },
] as const;

export type PrechatBuiltinKey = (typeof PRECHAT_BUILTIN_TARGETS)[number]["key"];

/** Fast membership test for the save-time validator. */
export const PRECHAT_BUILTIN_KEYS: ReadonlySet<string> = new Set(
  PRECHAT_BUILTIN_TARGETS.map((t) => t.key),
);
