/**
 * Capability catalog for external API keys.
 *
 * Keys are stored in the DB on `TeamApiKey.scopes` as a `string[]`. An empty
 * array means "no access" (deny by default — a freshly created key with no
 * boxes ticked can't do anything). The literal `"*"` is a single-element
 * wildcard that grants every scope; existing rows from before this feature
 * landed are backfilled to `["*"]` so partner integrations don't break.
 *
 * Per-route enforcement: each controller route declares the scope it needs
 * via `@RequireScope("write:contacts")` etc. (apps/api/src/auth/scope.guard
 * + scope.decorator). The guard reads `req.apiKey.scopes` and admits the
 * request iff `"*"` is present OR the required scope is listed exactly.
 *
 * Wire-format stability: these strings are public API; renaming one breaks
 * every partner that hard-coded them. Add new ones, don't rename.
 *
 * Read scopes are NOT required for the corresponding write scope (so a
 * "write-only" key for a one-way push integration is possible). If you
 * grant write, you typically grant read too in the UI — but the policy
 * is "no implicit upgrade" for least-surprise.
 */

export const API_KEY_SCOPES = [
  // Wildcard — used by the backfill migration so pre-existing keys keep
  // every capability they had before the scope system shipped. New keys
  // created from the settings UI should ask for specific scopes instead.
  "*",

  // Contacts
  "read:contacts",
  "write:contacts",
  "delete:contacts",

  // Conversations (status, assignment, status timeline)
  "read:conversations",
  "write:conversations",

  // Messages — covers send-text, send-template, send-media. Read covers
  // listing per-conversation history.
  "read:messages",
  "write:messages",

  // Internal notes (non-customer-facing comments on a conversation)
  "read:notes",
  "write:notes",

  // Catalogs — tags / stages / contact fields / templates / snippets etc.
  // Most partners only need read here; the bulk of mutations come through
  // the contacts/messages/conversations surfaces above.
  "read:catalog",
  "write:catalog",
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** True iff the granted set covers the required scope. */
export function hasScope(granted: readonly string[], required: ApiKeyScope): boolean {
  if (granted.includes("*")) return true;
  return granted.includes(required);
}

/** Strip unknown entries (defense against legacy/typo data in the DB). */
export function normalizeScopes(raw: readonly string[]): ApiKeyScope[] {
  const valid = new Set(API_KEY_SCOPES as readonly string[]);
  return raw.filter((s): s is ApiKeyScope => valid.has(s));
}
