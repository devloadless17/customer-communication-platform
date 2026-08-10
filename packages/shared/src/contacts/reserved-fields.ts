/**
 * Built-in Contact columns + their common aliases. Custom fields whose
 * slugified label collapses to any of these are rejected at create/update
 * time — without that guard, a user-created "location" field shadows the
 * built-in `Contact.location` column and the contact panel renders two
 * fields with the same label that write to different storage.
 *
 * Module-private — only `isReservedFieldKey` (the single public entry point)
 * reads this list + the normalizer below. Previously both were exported "so
 * the CSV import recognizer and Zod schemas can reference them", but nothing
 * ever did; de-exported to keep the public surface to the one function callers
 * actually use.
 */
const RESERVED_FIELD_KEYS: ReadonlyArray<string> = [
  // Identity
  "id",
  "phone",
  "phone_number",
  "phonenumber",
  // Name fields
  "name",
  "full_name",
  "fullname",
  "first_name",
  "firstname",
  "last_name",
  "lastname",
  // Contact details
  "email",
  "email_address",
  "location",
  "city",
  "language",
  "country",
  "country_code",
  // Channel / system
  "channel",
  // `source` is deliberately NOT reserved. `Contact.source` is the inbound/manual
  // acquisition enum (the "Added by you" badge), not a panel column, so a custom
  // "Source" field shadows nothing an agent sees twice — and "Source" is exactly
  // the stage-like dimension name the select-field feature was built for. Every
  // collision surface is already handled: CSV export emits colliding labels as
  // `custom:<key>` (fieldHeader, apps/api/src/lib/contact-transfer/columns.ts) and
  // the builtin `source` transfer column is export-only (importable: false); the
  // `$var.contact.*` builtin token keys don't include `source`, so the token
  // resolves from customFields; webchat prechat's BUILTIN_FIELD_BY_SLUG doesn't
  // map it either.
  "avatar",
  "avatar_url",
  "tags",
  "tag",
  "stage",
  "stage_id",
  "assigned",
  "assigned_to",
  "assigned_user_id",
  "created_at",
  "createdat",
  "last_inbound_at",
  "last_outbound_at",
  "first_contacted",
  "firstcontacted",
];

const RESERVED_SET = new Set(RESERVED_FIELD_KEYS);

/**
 * Normalize a custom-field label to the same shape used by the slugifier
 * (lowercase, underscored) so collision checks aren't fooled by case or
 * inner whitespace ("First Name" → "first_name").
 */
function normalizeFieldKey(label: string): string {
  return label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function isReservedFieldKey(label: string): boolean {
  const key = normalizeFieldKey(label);
  if (!key) return false;
  if (RESERVED_SET.has(key)) return true;
  // Catch the bare-no-separator variants too: "PhoneNumber" → "phonenumber".
  return RESERVED_SET.has(key.replace(/_/g, ""));
}
