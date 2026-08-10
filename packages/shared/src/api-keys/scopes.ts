/**
 * Capability catalog for external API keys.
 *
 * Keys are stored in the DB on `WorkspaceApiKey.scopes` as a `string[]`. An empty
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

  // Tickets — the unit of WORK on a conversation. Their own scope for the same
  // reason flags have one: a helpdesk or BI system that should read and resolve
  // work items must not thereby gain the ability to send billed messages.
  // (Ticket CONFIGURATION — SLA promises, custom fields, behaviour toggles —
  // moved to `admin:settings` 2026-07-27: editing an SLA changes what every
  // future ticket promises, which is admin authority, not work-item authority.)
  "read:tickets",
  "write:tickets",

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

  // LEGACY as of 2026-07-27 — grants nothing on its own.
  //
  // It used to cover setting a teammate's availability / working hours, but
  // those routes are admin-gated internally, so they moved to
  // `admin:settings` (existing keys holding this were granted that scope by
  // the grandfather migration). The value stays in the enum so those keys and
  // their specs keep validating; do NOT advertise it as granting anything.
  //
  // Deliberately NOT "create/delete users": inviting and removing members is
  // an auth-boundary action with its own email flow and seat-cap enforcement.
  "write:users",

  // Workspace performance reports — the aggregates behind the /reports
  // dashboard (volume, response/resolution times, per-agent, ticket SLA, AI
  // share). Read-only by nature; its own scope so a BI integration can pull
  // metrics without being able to read message CONTENT (read:messages) or
  // anything else.
  "read:reports",

  // Connected channel accounts — which WhatsApp numbers / Pages / IG handles a
  // workspace has, which is the default, and their health. Read-only on
  // purpose: adding or disconnecting an account moves real credentials and
  // silently changes which number a customer hears from, so it stays a
  // deliberate action in Settings rather than something an integration can do.
  "read:channels",

  // Admin-grade workspace CONFIGURATION (2026-07-27) — the routes whose
  // internal twin is gated on the admin role or a manager+ capability:
  // assignment policies/rules/settings, ticket settings + SLA policies +
  // ticket field definitions, the WhatsApp business profile + QR codes, and
  // setting OTHER teammates' availability/working hours. These used to ride on
  // the generic write scopes (`write:catalog` / `write:tickets` /
  // `write:users`), which meant an api key minted for ordinary integration
  // work could silently rewrite routing rules or SLA promises no agent-role
  // session ever could. Existing keys holding any of those three scopes were
  // grandfathered this scope by migration, so no partner integration broke;
  // NEW keys ask for it explicitly.
  "admin:settings",

  // Create / cancel / retry / delete BROADCAST campaigns.
  //
  // Its own scope, and the most dangerous one in this list: a create sends
  // billed template messages to an entire audience, and there is no unsend.
  // `read:broadcasts` deliberately does NOT imply it — a reporting
  // integration must never be one typo away from launching a campaign. Sends
  // through this scope require an `Idempotency-Key` for the same reason.
  "write:broadcasts",

  // Fire a manual_trigger workflow from outside the app.
  //
  // Its own scope rather than riding `write:catalog`, because a run is not a
  // catalog edit: it executes real step actions, including BILLED Meta sends.
  // Reading and EDITING workflows stays under read:catalog / admin:settings —
  // publishing changes automation for everyone in the workspace, which is an
  // admin act; firing an already-published manual workflow is an operational
  // one an integration legitimately does per contact.
  "write:workflows",
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** True iff the granted set covers the required scope. */
export function hasScope(granted: readonly string[], required: ApiKeyScope): boolean {
  if (granted.includes("*")) return true;
  return granted.includes(required);
}
