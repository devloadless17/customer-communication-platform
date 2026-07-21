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

  // Message flags — per-message triage markers ("Complaint", "Refund request")
  // and their open/resolved lifecycle. Their own scope rather than folding into
  // read/write:messages, because this is the surface an EXTERNAL system polls
  // or receives to pick up work: a partner that should see complaints must not
  // thereby gain the ability to send billed messages. The flag CATALOG (which
  // flags exist) stays under read/write:catalog with every other catalog.
  "read:flags",
  "write:flags",

  // Catalogs — tags / stages / contact fields / templates / snippets etc.
  // Most partners only need read here; the bulk of mutations come through
  // the contacts/messages/conversations surfaces above.
  "read:catalog",
  "write:catalog",

  // Broadcast campaigns — read-only. Clients pull campaign results into their
  // own BI/reporting. Deliberately no `write:broadcasts`: creating or firing a
  // campaign via API is a separate feature with its own idempotency and
  // abuse-surface questions, and billed template sends are irreversible.
  "read:broadcasts",

  // Calls — history, and a contact's current calling-permission state.
  "read:calls",
  // Asking a customer for calling permission, and sending them a call button.
  //
  // Deliberately NOT "place a call": a call needs an SDP offer from a live
  // WebRTC peer and a browser to carry the audio, so an API client has nothing
  // to place a call WITH. Everything here is the part an integration can
  // genuinely drive — teeing up a call a human then makes or takes.
  "write:calls",

  // Team members — setting a teammate's availability or working hours. Read
  // stays under "read:catalog" (where GET /v1/users already lives); this is
  // write-only so a workforce-management integration can push shift changes
  // without also being able to edit tags, stages or templates.
  //
  // Deliberately NOT "create/delete users": inviting and removing members is
  // an auth-boundary action with its own email flow and seat-cap enforcement.
  "write:users",
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** True iff the granted set covers the required scope. */
export function hasScope(granted: readonly string[], required: ApiKeyScope): boolean {
  if (granted.includes("*")) return true;
  return granted.includes(required);
}
