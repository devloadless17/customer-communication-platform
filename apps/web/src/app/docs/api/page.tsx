import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import {
  PUBLIC_EVENT_GROUPS,
  toWirePayload,
  type WireChannelBase,
} from "@ccp/shared/outbound-webhooks/public-events";

import { CopyCurlButton } from "@/features/docs/components/copy-curl-button";

/** Illustrative channel block for the docs samples (epoch = a fixed date). */
const SAMPLE_CHANNEL: WireChannelBase = {
  id: "cmpchan_01",
  name: "whatsapp",
  source: "whatsapp_business",
  created_at: 1773145944,
  // WHICH account the event happened on, in terms a receiver can route on —
  // `id` alone is an opaque cuid. Shown in the samples so integrators see the
  // fields exist without having to fire a real event to discover them.
  account_label: "Sales",
  account_address: "+15550100001",
  account_external_id: "109876543210987",
};

export const metadata = { title: "API reference" };

/** Every scope a key can hold, and what it gates. "Full access" = all of them. */
const SCOPES: ReadonlyArray<{ scope: string; grants: string }> = [
  { scope: "read:contacts", grants: "read contacts + their channels" },
  { scope: "write:contacts", grants: "create / update / tag / stage / upsert contacts" },
  { scope: "delete:contacts", grants: "soft-delete contacts" },
  { scope: "read:conversations", grants: "read conversations" },
  { scope: "write:conversations", grants: "assign · status · AI Autopilot toggle" },
  { scope: "read:messages", grants: "read messages" },
  { scope: "write:messages", grants: "send text / media / template" },
  { scope: "write:notes", grants: "add internal notes" },
  { scope: "read:flags", grants: "read message triage flags + the flag queue" },
  { scope: "read:tickets", grants: "read tickets, SLA policies + ticket fields" },
  { scope: "write:tickets", grants: "open / assign / solve tickets" },
  { scope: "write:flags", grants: "raise / resolve / dismiss / remove message flags" },
  { scope: "read:catalog", grants: "read tags · fields · stages · channels · users" },
  { scope: "read:channels", grants: "read the accounts connected under each channel" },
  { scope: "write:catalog", grants: "create / edit tags + custom fields" },
  { scope: "read:broadcasts", grants: "read broadcast campaigns + delivery reports" },
  { scope: "read:calls", grants: "read call history + calling-permission state" },
  { scope: "read:reports", grants: "read performance reports (no message content)" },
  { scope: "write:calls", grants: "request calling permission · send call buttons" },
  {
    scope: "write:broadcasts",
    grants:
      "create / cancel / retry / delete campaigns. The most dangerous scope here — a create sends billed messages to a whole audience and there is no unsend, so read:broadcasts deliberately does not imply it.",
  },
  {
    scope: "write:workflows",
    grants:
      "fire a published manual-trigger workflow for a contact. Its own scope because a run executes real step actions, including billed sends — reading and editing workflows stay under read:catalog / admin:settings.",
  },
  {
    scope: "write:users",
    grants:
      "legacy — grants nothing on its own. Availability + working-hours writes moved to admin:settings on 2026-07-27; keys minted before then were granted admin:settings automatically.",
  },
  {
    scope: "admin:settings",
    grants:
      "admin-grade configuration: assignment policies/rules · ticket settings + SLA + fields · WhatsApp profile + QR codes · teammates' availability (keys created before 2026-07-27 with the older write scopes were grandfathered)",
  },
];

/**
 * Single-page reference of every `/api/external/v1` endpoint + every
 * outbound webhook event type. Kept deliberately public — there's no
 * sensitive info on this page, and partners may want to read it before
 * signing up. Every endpoint exposes a one-click "Copy curl" so it can
 * be pasted straight into Postman / n8n.
 */
export default function ApiDocsPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 md:py-10">
      <Link
        href="/settings/integrations"
        className="mb-6 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3" />
        Back to Integrations
      </Link>

      <header className="mb-8">
        <h1 className="text-2xl font-semibold">API reference</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Stable surface for integrations. Authenticate with{" "}
          <code className="rounded bg-muted px-1 text-xs">
            Authorization: Bearer ccp_…
          </code>{" "}
          from a key you generated in{" "}
          <Link
            href="/settings/integrations"
            className="text-primary hover:underline"
          >
            Settings → Integrations
          </Link>
          . Every endpoint has a <code className="rounded bg-muted px-1 text-xs">curl</code>{" "}
          button — paste into Postman or n8n and replace{" "}
          <code className="rounded bg-muted px-1 text-xs">$CCP_TOKEN</code> with
          your key.
        </p>
      </header>

      <div className="mb-8 rounded-md border border-border bg-card p-4 text-xs">
        <h2 className="mb-3 text-base font-semibold">Conventions &amp; security</h2>
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="font-semibold text-foreground">Base path &amp; auth</dt>
            <dd className="text-muted-foreground">
              <code>/api/external/v1</code> over HTTPS.{" "}
              <code>Authorization: Bearer ccp_…</code> on every request — one key =
              one organization, every call auto-scoped to your org. Missing/invalid
              key → <code>401</code>.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-foreground">Rate limits</dt>
            <dd className="text-muted-foreground">
              <strong>60 req/min per key</strong> across all routes; sends carry an
              extra <strong>30/min per conversation</strong> loop-guard. Over →{" "}
              <code>429 rate_limited</code>. (Bad/missing keys: 30/min per IP.)
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-foreground">Idempotency</dt>
            <dd className="text-muted-foreground">
              The send routes (<code>POST /messages</code>,{" "}
              <code>POST /conversations/:id/messages</code>,{" "}
              <code>POST /conversations/:id/interactive</code>){" "}
              <strong>require</strong> an <code>Idempotency-Key</code> header —
              reuse it on a retry and we never double-send (the inbound message
              id is a good key). Other mutations accept it optionally.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-foreground">Pagination</dt>
            <dd className="text-muted-foreground">
              List routes take <code>?limit=</code> &amp; <code>?cursor=</code>; the
              response carries <code>nextCursor</code> (<code>null</code> when done)
              — pass it back as <code>cursor</code>. Natural-key lookups
              (<code>?phone=</code>/<code>?email=</code>) return at most one row, no
              cursor.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-foreground">Errors</dt>
            <dd className="text-muted-foreground">
              Non-2xx → <code>{`{ error, detail }`}</code>. Common:{" "}
              <code>403 insufficient_scope</code>, <code>404</code>,{" "}
              <code>409 duplicate_phone</code>, <code>422</code> validation,{" "}
              <code>429 rate_limited</code>.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-foreground">
              <code>silent</code> &amp; loop safety
            </dt>
            <dd className="text-muted-foreground">
              Any mutating route accepts <code>{`"silent": true`}</code> to suppress
              the webhook/automation echo for that write. If a webhook handler calls
              back into this API, forward the <code>X-CCP-Depth</code> header
              verbatim — we reject at depth 8 (<code>429 chain_depth_exceeded</code>),
              which breaks accidental webhook → API → webhook loops.
            </dd>
          </div>
        </dl>

        <div className="mt-4 border-t border-border pt-3">
          <p className="font-semibold text-foreground">Scopes</p>
          <p className="mt-1 text-muted-foreground">
            A key grants only the scopes you pick when you create it
            (<strong>Full access</strong> = all of them). A call outside its scopes
            returns <code>403 insufficient_scope</code>. Each endpoint below needs
            the matching scope from its section.
          </p>
          <div className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
            {SCOPES.map((s) => (
              <div key={s.scope} className="flex gap-2">
                <code className="shrink-0 font-mono text-3xs text-foreground">
                  {s.scope}
                </code>
                <span className="text-muted-foreground">{s.grants}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <Section title="Contacts">
        <Endpoint method="GET" path="/api/external/v1/contacts?phone=%2B15555550100">
          List or find contacts. <strong>Natural-key lookups</strong> short-circuit
          with at most one row (no cursor):{" "}
          <code>?phone=</code> (E.164, server-normalized),{" "}
          <code>?email=</code> (case-insensitive exact), or{" "}
          <code>?externalContactId=</code> (your CRM id, stamped at create time).
          <strong> Browsing</strong>:{" "}
          <code>?search=</code> for fuzzy across name / phone / email,{" "}
          <code>?stageId=</code>, <code>?tagIds=</code>,{" "}
          <code>?accountId=</code>, <code>?cursor=</code>, <code>?limit=</code>.
          <br />
          Every contact row carries <code>channelConnectionId</code> — which of
          your accounts that person&apos;s thread is on — so a partner can route
          on the number without a second call. Null when they have no thread
          yet, or when the account was disconnected.
          <br />
          <code>?accountId=</code> narrows to people who have a conversation on
          ONE of your channel accounts — a specific WhatsApp number, Page or
          Instagram handle (ids from <code>GET /v1/channel-accounts</code>). It
          ANDs with the other filters. The same parameter narrows{" "}
          <code>/v1/conversations</code>, <code>/v1/calls</code>,{" "}
          <code>/v1/tickets</code> and <code>/v1/broadcasts</code> — on
          broadcasts it means the account the campaign SENT FROM.
          <br />
          <strong>Directory scope.</strong> Both lookup and browsing return only{" "}
          <em>directory</em> contacts. Anonymous website-widget visitors are
          excluded: their identity is a per-browser session token, not a durable
          address, so they are neither listable nor addressable. A visitor who
          submits a phone or email in the pre-chat form is promoted and appears
          normally from then on.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/contacts/:id">
          Fetch a single contact (including custom fields, tags, stage). Unlike
          the list, this resolves an anonymous widget visitor too — the thread is
          live and you may hold its id from a <code>message.received</code>{" "}
          webhook.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/contacts"
          body={{ phoneNumber: "+15555550100", name: "Jane Doe" }}
        >
          Create a contact. Requires <code>phoneNumber</code> (E.164). Returns 409
          on duplicate.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/contacts/upsert"
          body={{ phoneNumber: "+15555550100", name: "Jane Doe" }}
        >
          Find-or-create by <code>phoneNumber</code>. Returns{" "}
          <code>{`{ contact, created: boolean }`}</code>.
        </Endpoint>
        <Endpoint
          method="PATCH"
          path="/api/external/v1/contacts/:id"
          body={{ name: "Jane Doe", email: "jane@example.com" }}
        >
          Partial update — name, email, location, customFields, stageId. Phone is
          immutable.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/contacts/:id/stage"
          body={{ stageId: "stage_..." }}
        >
          Move a contact along the lifecycle pipeline (Lead → Customer → …) — the
          discoverable sibling of assign/status. Look ids up via{" "}
          <code>GET /stages</code>. Fires the <em>On Contact Lifecycle updated</em>{" "}
          workflow trigger, the in-conversation stage pill, and the{" "}
          <code>contact.lifecycle_changed</code> webhook — full parity with the UI
          stage picker. (Clearing a stage: <code>PATCH</code> with{" "}
          <code>{`{ stageId: null }`}</code>.)
        </Endpoint>
        <Endpoint method="DELETE" path="/api/external/v1/contacts/:id">
          Removes the contact from the directory (soft delete). Conversation
          history, messages, and media are preserved, and a returning contact is
          revived on the next inbound message or create-by-phone. The{" "}
          <code>contact.deleted</code> webhook carries an empty{" "}
          <code>conversation_ids</code> for this reason. For erasure / GDPR
          requests, contact us for a hard purge.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/contacts/:id/channels">
          List a contact's channels (today: one WhatsApp row per contact).
        </Endpoint>
        <Endpoint method="POST" path="/api/external/v1/contacts/:id/block">
          Block the contact at the provider (WhatsApp Block Users API): they can
          no longer message you, and every send to them is rejected until
          unblocked. The provider is called first and the contact&apos;s{" "}
          <code>blockedAt</code> only flips on success. WhatsApp constraints
          surface as typed 400s: <code>reengagement_required</code> (they
          haven&apos;t messaged you in the last 24 hours — Meta refuses the
          block), <code>blocklist_full</code> (the number&apos;s 64,000-entry
          cap), <code>blocking_not_supported</code> (non-WhatsApp channel).
          Blocked contacts are excluded from broadcast audiences automatically.
          Scope <code>write:contacts</code>; full parity with the inbox&apos;s
          Block action.
        </Endpoint>
        <Endpoint method="POST" path="/api/external/v1/contacts/:id/unblock">
          Lift the provider block (no 24-hour constraint). The contact can
          message you again and sends resume; <code>blockedAt</code> returns to{" "}
          <code>null</code> on the contact payload and the{" "}
          <code>contact.updated</code> webhook.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/contacts/:id/tags"
          body={{ tagIds: ["tag_..."] }}
        >
          Add tag(s) to a single contact. Body: <code>{`{ tagIds: string[] }`}</code>.
        </Endpoint>
        <Endpoint method="DELETE" path="/api/external/v1/contacts/:id/tags/:tagId">
          Remove a tag from a contact.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/contacts/:id/tags/remove"
          body={{ tagIds: ["tag_..."] }}
        >
          Bulk-remove multiple tags from one contact in a single call.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/contacts/tags/add"
          body={{ contactIds: ["contact_..."], tagIds: ["tag_..."] }}
        >
          Bulk add tags. Body: <code>{`{ contactIds: string[], tagIds: string[] }`}</code>.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/contacts/tags/remove"
          body={{ contactIds: ["contact_..."], tagIds: ["tag_..."] }}
        >
          Bulk remove tags. Same body shape as <code>add</code>.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/contacts/export"
          body={{ format: "xlsx", filters: { stageId: "stage_...", tagIds: ["tag_..."] } }}
        >
          Queue a CSV or Excel export and get back a <code>jobId</code>. Omit{" "}
          <code>filters</code> for the whole directory, or pass{" "}
          <code>ids: string[]</code> for an explicit set. Poll{" "}
          <code>/contacts/transfers/:id</code>, then download. Handles 100,000+
          contacts. 5/min.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/contacts/import/upload"
          headers={{ "Content-Type": "multipart/form-data" }}
        >
          Upload a <code>file</code> (CSV or .xlsx, up to 50&nbsp;MB). Returns an{" "}
          <code>uploadKey</code> plus the detected <code>headers</code>,{" "}
          <code>sampleRows</code> and a <code>suggestedMapping</code>. Format is
          detected from the file&apos;s content, not its name. 10/min.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/contacts/import"
          headers={{ "Idempotency-Key": "<uuid>" }}
          body={{
            uploadKey: "...",
            format: "xlsx",
            mode: "create_and_update",
            tagMode: "merge",
            fireAutomations: true,
            mapping: { Mobile: "phone_number", "Company Name": "field:company" },
          }}
        >
          Queue the import. <code>mode</code>: <code>create_only</code> (default),{" "}
          <code>create_and_update</code>, <code>update_only</code>. Contacts are
          matched on phone number; <strong>blank cells never erase existing
          values</strong>; an imported email is never used to merge two people.
          Above 5,000 rows <code>fireAutomations</code> is forced off (a 100k
          import would otherwise queue 100k workflow runs). Idempotency-Key
          required. 5/min.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/contacts/transfers/:id">
          Job status and counters — <code>status</code>, <code>processedRows</code>,{" "}
          <code>created</code>, <code>updated</code>, <code>revived</code>,{" "}
          <code>skipped</code>, <code>failed</code>, <code>automationsSkipped</code>.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/contacts/transfers">
          Recent import/export jobs. <code>?limit=20&amp;kind=export</code>.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/contacts/transfers/:id/download">
          302 to a short-lived signed URL for the produced file. Follow the
          redirect, or read the <code>Location</code> header.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/contacts/transfers/:id/errors">
          302 to the failed-rows report: your original columns plus{" "}
          <code>_row</code> and <code>_error</code>, in the format you uploaded.
          Fix it and re-import that file directly.
        </Endpoint>
        <Endpoint method="POST" path="/api/external/v1/contacts/transfers/:id/cancel">
          Stop a queued or running job. Rows already imported stay imported.
          Files are deleted after 7 days.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/contacts/:id/assign"
          body={{ assignedUserId: "user_..." }}
        >
          Assign (or unassign with <code>null</code>) the contact's most-recent
          conversation. Resolves the conversation server-side.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/contacts/:id/status"
          body={{ status: "open" }}
        >
          Open / pending / close the contact's most-recent conversation.
        </Endpoint>
      </Section>

      <Section title="Custom field definitions">
        <Endpoint method="GET" path="/api/external/v1/contact-fields">
          List every custom field definition (id, key, label, order).
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/contact-fields/:idOrKey">
          Find a field by id or by stable key (e.g. <code>amount_usd</code>).
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/contact-fields"
          body={{ label: "Amount (USD)" }}
        >
          Create a new field. Body: <code>{`{ label: string }`}</code>. Key is
          auto-derived from the label.
        </Endpoint>
      </Section>

      <Section title="Tags & stages">
        <Endpoint method="GET" path="/api/external/v1/tags">
          List the tag catalog.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/tags"
          body={{ name: "VIP", color: "emerald" }}
        >
          Create a tag. Body: <code>{`{ name: string, color?: string }`}</code>.
        </Endpoint>
        <Endpoint
          method="PATCH"
          path="/api/external/v1/tags/:id"
          body={{ name: "VIP", color: "emerald" }}
        >
          Rename / recolor a tag.
        </Endpoint>
        <Endpoint method="DELETE" path="/api/external/v1/tags/:id">
          Delete a tag (also removes it from every contact).
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/stages">
          Lifecycle stage catalog. Assign one to a contact with{" "}
          <code>POST /contacts/:id/stage</code> (above).
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/channels">
          Read-only list of the channels this workspace has connected.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/channels/:channel/accounts">
          The accounts under one channel — <code>whatsapp</code>,{" "}
          <code>messenger</code> or <code>instagram</code>. A channel can hold more
          than one account (two numbers, two Pages). Each row carries the
          provider&apos;s own <code>externalAccountId</code> (phone-number id / Page
          id / IG id) so you can correlate a webhook you receive from Meta directly
          with the account it belongs to, plus <code>label</code>,{" "}
          <code>isDefault</code> (used only when a send doesn&apos;t name an
          account — replies always go out the account the customer messaged) and{" "}
          <code>needsReconnect</code>. Scope <code>read:channels</code>. Read-only:
          connecting or disconnecting an account moves real credentials and changes
          which number a customer hears from, so it stays an in-app admin action.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/conversations?accountId=">
          Narrow the conversation list to ONE connected account — a specific
          WhatsApp number, Page or Instagram handle. The id comes from{" "}
          <code>GET /channel-accounts</code>, and every conversation carries the same
          id as <code>channelConnectionId</code>. ANDed with{" "}
          <code>status</code> / <code>phone</code> / <code>viewId</code> rather than
          replacing them. This is parity with the inbox&apos;s account picker.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/channel-accounts">
          Every account across <em>every</em> channel in one call, display fields
          only: <code>id</code>, <code>channel</code>, <code>name</code> (the
          admin&apos;s label when set, else the provider&apos;s own name, else the raw
          id — never blank), <code>providerName</code>, <code>isDefault</code>,{" "}
          <code>isActive</code>. This is the lookup for a conversation&apos;s{" "}
          <code>channelConnectionId</code>, which names the account a thread is on
          and therefore the number a reply goes out from. Carries no credentials, so
          scope <code>read:catalog</code> rather than <code>read:channels</code>.
        </Endpoint>
      </Section>

      <Section title="Users">
        <Endpoint method="GET" path="/api/external/v1/users">
          List team members. Use this to populate an n8n assignment dropdown.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/users/:idOrEmail">
          Find a user by id or by email. Both reads include{" "}
          <code>availabilityStatus</code>, <code>availabilityMessage</code>,{" "}
          <code>availabilitySource</code> (<code>manual</code> ·{" "}
          <code>admin</code> · <code>schedule</code>), <code>availabilityUntil</code>{" "}
          and <code>workHoursMode</code>.
        </Endpoint>
        <Endpoint method="PATCH" path="/api/external/v1/users/:id/availability">
          Set a member&apos;s status: <code>{`{ "status": "busy", "message": "On a call" }`}</code>.
          While working hours are configured the pick expires automatically at their next
          shift boundary (at local midnight if their schedule never closes, and it is
          re-anchored if their schedule changes) — so a status set mid-shift can&apos;t
          outlive the day. With no schedule it holds until changed. Send{" "}
          <code>{`{ "followSchedule": true }`}</code> to drop the override immediately and
          hand them back to their schedule. Needs <code>admin:settings</code> (pre-2026-07-27 <code>write:users</code> keys were grandfathered).
        </Endpoint>
        <Endpoint method="PUT" path="/api/external/v1/users/:id/work-hours">
          Set a member&apos;s schedule:{" "}
          <code>{`{ "mode": "inherit" | "custom" | "off", "workHours": { "timezone": "Asia/Beirut", "weekly": { "mon": [{ "open": "09:00", "close": "17:00" }] } } }`}</code>.
          <code>custom</code> requires <code>workHours</code>; the other modes ignore it.
          Outside their hours a member shows as away and is skipped by round-robin
          assignment. Needs <code>admin:settings</code>.
        </Endpoint>
      </Section>

      <Section title="Broadcasts (campaign reporting)">
        <Endpoint method="GET" path="/api/external/v1/broadcasts">
          Paginated campaign list, newest first. <code>?status=</code>,{" "}
          <code>?since=</code> (ISO) for incremental sync, <code>?cursor=</code>.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/broadcasts/:id">
          One campaign: counters, template, timing, <code>suppressedCount</code>.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/broadcasts/:id/report">
          Delivery funnel, rates, failure breakdown (bucketed retryable /
          permanent / suppress), cost by pricing category, benchmark and
          diagnostics. This is the SAME object the in-app report renders, so API
          and dashboard can never disagree.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/broadcasts/:id/recipients">
          Per-recipient outcomes. <code>?outcome=</code> accepts{" "}
          <code>never_received</code>, <code>delivered</code>, <code>read</code>,{" "}
          <code>replied</code>, <code>clicked</code>, <code>failed</code>,{" "}
          <code>undelivered</code>, <code>pending</code>; plus{" "}
          <code>?errorCode=</code> and <code>?updatedSince=</code> (delivery and
          read receipts arrive for hours, so incremental sync avoids re-pulling
          everything). Report on <code>deliveryState</code>, not{" "}
          <code>sendStatus</code> — the latter is the send-side outcome and does
          not change when a message is later found undeliverable.
          <br />
          <br />
          <code>billable</code> is <strong>Meta&apos;s own per-message flag</strong>,
          stored verbatim — never computed here — so expect it to vary{" "}
          <em>within</em> one campaign. Meta bills per recipient: a{" "}
          <code>utility</code> template is <strong>free</strong> when it lands
          inside that contact&apos;s open 24-hour customer service window and
          charged when it doesn&apos;t. Marketing and authentication templates
          always bill, so only utility campaigns come back mixed. Pair it with{" "}
          <code>pricingCategory</code>; we deliberately store no amount, because
          rates are per-country cards that change.
        </Endpoint>
      </Section>

      <Section title="Reports">
        <Endpoint method="GET" path="/api/external/v1/reports/overview">
          Workspace performance report — the same aggregates (and the same
          response shape) as the in-app Reports dashboard: message volume with
          per-day buckets, per-channel split, first-response and resolution
          times (average + median, seconds), per-agent activity, ticket-SLA
          attainment, and the AI share of replies. Required{" "}
          <code>?from=</code>/<code>?to=</code> (ISO instants, exclusive upper
          bound, up to 366 days); optional <code>?tz=</code> (IANA zone daily
          buckets flip in, default UTC) and <code>?accountId=</code>.
          <br />
          <code>?accountId=</code> scopes EVERY panel to one channel account —
          a specific WhatsApp number, Page or Instagram handle (ids from{" "}
          <code>GET /v1/channel-accounts</code>). A workspace running a Sales
          and a Support line is two operations sharing a medium, and a blended
          first-response time hides one drowning behind the other. Omit it for
          the whole workspace. An id from another workspace is rejected rather
          than silently returning an empty report. The response echoes the
          scope back as <code>range.accountId</code>, and the new{" "}
          <code>accounts[]</code> panel gives the per-account split without a
          filter (traffic on a since-disconnected account is reported with a
          null <code>accountId</code>, never dropped). Durations are <code>null</code> when
          the range holds no qualifying rows — &ldquo;no data&rdquo; is not
          zero seconds. Scope: <code>read:reports</code> (grants no access to
          message content).
        </Endpoint>
      </Section>

      <Section title="Calls">
        <p className="mb-3 text-sm text-muted-foreground">
          There is deliberately no &ldquo;place a call&rdquo; endpoint. A
          WhatsApp call needs an SDP offer from a live WebRTC peer and a browser
          to carry the audio, so an API client has nothing to place one with.
          What&apos;s here is the part an integration can genuinely drive:
          teeing up a call a human then makes or takes.
        </p>
        <Endpoint method="GET" path="/api/external/v1/calls">
          Call history, newest first. <code>?conversationId=</code>,{" "}
          <code>?from=</code>/<code>?to=</code> (ISO), <code>?cursor=</code>.
          Report on <code>connected</code>, not <code>status</code> — a call can
          complete without anyone picking up, and an agent can hang up a call
          that did connect. Inbound calls placed from a call button or a{" "}
          <code>wa.me/call</code> deep link carry your opaque tag back as{" "}
          <code>ctaPayload</code> / <code>deeplinkPayload</code>, so a campaign
          can be credited for the calls it produced (<code>cta_payload</code> /{" "}
          <code>deeplink_payload</code>). <code>has_recording</code> /{" "}
          <code>has_transcript</code> flip true once each artifact has been
          stored, and <code>transcript_language</code> carries the
          auto-detected spoken language (ISO 639, e.g. <code>ar</code>).
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/calls/:callId/recording">
          Stream a call&apos;s stored recording (OGG/OPUS audio). 404 until{" "}
          <code>has_recording</code> is true. In the WhatsApp built-in method
          recordings land about a minute after the call (with the spoken
          consent announcement); in the in-app method they appear the moment
          the call ends.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/calls/:callId/transcript">
          The call&apos;s transcript as JSON: speaker-attributed segments
          (Business / Customer) with word-level timings and confidences, plus{" "}
          <code>transcript.language</code> — the auto-detected spoken language
          (Arabic supported). 404 until <code>has_transcript</code> is true on
          the call.
        </Endpoint>
        <Endpoint
          method="GET"
          path="/api/external/v1/conversations/:id/call-permission"
        >
          The customer&apos;s current calling permission, read live from
          WhatsApp rather than from our records — permission can be granted in
          ways that leave no trace on our side (the customer calling you, or
          granting it from your business profile). Check{" "}
          <code>can_start_call</code> rather than counting calls yourself: it is
          WhatsApp&apos;s own verdict with every limit applied, and the
          per-customer limit has changed three times in a year.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/conversations/:id/call-permission"
        >
          Ask the customer to allow calls. Sends a real, billable message, so an{" "}
          <code>Idempotency-Key</code> is required. Returns the existing grant
          without sending anything if permission is already live. A{" "}
          <code>409</code> means WhatsApp&apos;s request cap is spent (1/day,
          2/week, both reset by any connected call).
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/conversations/:id/call-button"
          body={{
            bodyText: "Questions about your order? Call us on WhatsApp.",
            displayText: "Call us",
            ttlMinutes: 1440,
            payload: "order-1522",
          }}
        >
          A tappable button that starts a WhatsApp call <em>to you</em>. Needs
          no permission at all, and a customer who uses it grants you callback
          permission as a side effect — often the better move for a cold
          contact. <code>payload</code> comes back on the call webhooks so you
          can trace an inbound call to what produced the button; older WhatsApp
          clients drop it, so treat its absence as normal.
        </Endpoint>
      </Section>

      <Section title="Conversations">
        <Endpoint method="GET" path="/api/external/v1/conversations">
          Paginated. <code>?status=</code>, <code>?phone=</code>,{" "}
          <code>?viewId=</code> (a saved inbox view — see below),{" "}
          <code>?cursor=</code>. A view&apos;s criteria are <strong>ANDed</strong> with
          the other filters, not substituted for them.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/conversations/:id">
          Fetch one + its contact.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/conversations/:id/assign"
          body={{ autoAssign: true }}
        >
          Assign to a teammate with{" "}
          <code>{`{ assignedUserId: string }`}</code>, unassign with{" "}
          <code>{`{ assignedUserId: null }`}</code>, or let your routing decide
          with <code>{`{ autoAssign: true }`}</code> — optionally pinned to a
          named policy via <code>policyId</code>. Auto-routing runs the same
          engine the inbox and the AI handoff use, so strategy, shares,
          per-agent limits and eligibility all apply. Add{" "}
          <code>{`{ overwrite: false }`}</code> to only fill an empty assignee.
          When nobody is eligible the call still returns 200 and the
          conversation stays in the Unassigned queue — that&apos;s the
          policy&apos;s configured outcome, not an error.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/conversations/:id/status"
          body={{ status: "open" }}
        >
          Body: <code>{`{ status: "open" | "pending" | "closed" }`}</code>.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/conversations/:id/ai"
          body={{ aiEnabled: false }}
        >
          Toggle AI Autopilot for the thread. Body:{" "}
          <code>{`{ aiEnabled: boolean }`}</code>. Set <code>false</code> to hand off
          to a human — every later <code>message.received</code> webhook then
          carries <code>ai_enabled: false</code> so your automation can skip it.
        </Endpoint>
      </Section>

      <Section title="Campaign analytics & WhatsApp health">
        <p className="text-sm text-muted-foreground">
          Two sources, reported <strong>side by side and never merged</strong>.
          The delivery funnel on <code>/broadcasts/:id/report</code> is
          per-recipient truth from status webhooks and the only source of{" "}
          <code>replied</code> and opt-outs. <code>metaAnalytics</code> on the
          same response is Meta&apos;s aggregate and the only source of real
          currency <strong>cost</strong> and unique <strong>URL-button clicks</strong>.
          They measure different things and will not agree exactly.
        </p>
        <Endpoint method="GET" path="/api/external/v1/broadcasts/:id/timeseries">
          The delivery curve — cumulative sent / delivered / read / replied,
          bucketed by a width the server picks from the send&apos;s span
          (<code>bucketSeconds</code>). Bounded output: a 100k campaign returns
          the same few hundred points a 100-recipient one does.
        </Endpoint>
        <Endpoint method="POST" path="/api/external/v1/broadcasts/:id/analytics/refresh">
          Pull fresh figures from Meta for this campaign&apos;s template.
          Manual on purpose — the report is polled while a campaign sends, and a
          Graph call on that path would exhaust Meta&apos;s rate limit for an
          aggregate that barely moves minute to minute.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/whatsapp/qr-codes">
          QR codes and short links on the number (reads <code>read:catalog</code>;
          creating / renaming / deleting codes and updating the business profile
          below need <code>admin:settings</code>). A <code>code</code> is both the
          identity and the short-link slug (
          <code>https://wa.me/message/&lt;code&gt;</code>).
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/whatsapp/qr-codes"
          body={{ prefilledMessage: "Hi! Tell me about your workshop", imageFormat: "SVG" }}
        >
          Create one. <code>prefilledMessage</code> is capped at{" "}
          <strong>140</strong> characters — it lands in the customer&apos;s chat
          box ready to send. <code>qrImageUrl</code> is returned{" "}
          <em>only here</em>, not by the list. Meta caps a number at 2,000 codes
          and reports no scan analytics.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/whatsapp/qr-codes/:code"
          body={{ prefilledMessage: "Hi! Tell me about your spring workshop" }}
        >
          Change the prefilled message. The code and its link keep working —
          which is why editing beats delete-and-recreate.
        </Endpoint>
        <Endpoint method="DELETE" path="/api/external/v1/whatsapp/qr-codes/:code">
          Retire a code. <strong>Anything already printed with it stops
          working</strong> — scanners see &ldquo;this QR code has expired.&rdquo;
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/whatsapp/account-status">
          The number&apos;s Official Business Account status (<code>obaStatus</code>,
          verbatim from Meta) and its WABA record (<code>name</code>,{" "}
          <code>status</code>, <code>currency</code>, <code>country</code>,{" "}
          <code>businessVerificationStatus</code>). Read-only — an OBA request is
          made in WhatsApp Manager.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/whatsapp/profile">
          The number&apos;s public business profile — <code>about</code>,{" "}
          <code>address</code>, <code>description</code>, <code>email</code>,{" "}
          <code>websites</code>, plus read-only <code>vertical</code> and{" "}
          <code>profilePictureUrl</code>. <code>?accountId=</code> picks one of
          the workspace&apos;s numbers; each has its own profile.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/whatsapp/profile"
          body={{ description: "Succulent specialists", websites: ["https://example.com"] }}
        >
          Update it. <strong>Only the fields you send are changed</strong>, and
          sending <code>&quot;&quot;</code> <em>clears</em> a field — so omit
          anything you don&apos;t mean to touch. <code>vertical</code> isn&apos;t
          writable here (Meta doesn&apos;t publish the enum&apos;s members);
          change it in WhatsApp Manager. The response is read back from Meta, not
          echoed.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/templates">
          The WhatsApp template catalog — the <code>id</code> the send and
          analytics routes take, Meta&apos;s <code>externalId</code>, the{" "}
          <code>parameterFormat</code> that decides the send shape, the
          components, and <code>qualityScore</code> (
          <code>GREEN</code>/<code>YELLOW</code>/<code>RED</code>/
          <code>UNKNOWN</code>). The quality band is the one worth alerting on:
          all four bands still send, but it drives Meta&apos;s template pausing,
          so <code>RED</code> is a template about to stop working.{" "}
          <code>statusDetail</code>, when present, carries Meta&apos;s rich
          status context verbatim: <code>rejectionReason</code> +{" "}
          <code>recommendation</code> (the explanation and fix advice sent with{" "}
          <code>INVALID_FORMAT</code> rejections), <code>title</code> (the pause
          instance — <code>FIRST_PAUSE</code>/<code>SECOND_PAUSE</code> self-lift
          in 3/6 hours; <code>RATE_LIMITING_PAUSE</code> is Template Pacing and
          only lifts via the unpause route below), and <code>disabledAt</code>.
          Filter with{" "}
          <code>?status=</code> / <code>?category=</code> /{" "}
          <code>?wabaId=</code> (templates belong to one WhatsApp Business
          Account — read the id off any row, then scope to it). Read-only —
          creating a template is a Meta review submission, not a CRUD write.
        </Endpoint>
        <Endpoint method="POST" path="/api/external/v1/templates/:id/unpause">
          Lift a quality pause, and release any campaigns that were paused with
          it. Meta lifts a <em>quality</em> pause on its own (3h, then 6h, then it{" "}
          <strong>disables</strong> the template on the third instance) — this is
          for one paused by Template Pacing, which never unpauses by itself.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/templates/:id/link-tracking"
          body={{ enabled: false }}
        >
          Toggle Meta&apos;s button-click tracking on one template
          (<code>cta_url_link_tracking_opted_out</code>). With{" "}
          <code>enabled: false</code>, future sends record no clicks — the
          template list&apos;s <code>linkTrackingOptedOut</code> says which
          templates are opted out, so an empty <code>clicked</code> series can
          be told apart from a campaign nobody clicked. Reversible; scope{" "}
          <code>admin:settings</code>.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/templates/:id/analytics">
          Per-template daily trend. <code>?start=</code> / <code>?end=</code>{" "}
          ISO; defaults to the last 30 days, and Meta&apos;s lookback ceiling is
          90. Returns <code>days[]</code> plus a <code>summary</code>. Both
          carry <code>clickedButtons</code> — Meta&apos;s per-button click
          entries (<code>type</code>: <code>url_button</code> /{" "}
          <code>unique_url_button</code> / <code>quick_reply_button</code>,{" "}
          <code>buttonContent</code>, <code>count</code>) — while the scalar{" "}
          <code>clicked</code> is the headline link-click figure (unique
          URL-button clicks when Meta reports them). The same block appears as{" "}
          <code>metaAnalytics.clickedButtons</code> on{" "}
          <code>/broadcasts/:id/report</code>.
          <br />
          <br />
          Two fields explain an all-zero result before you treat it as one.{" "}
          <code>analyticsSince</code> is when Meta started recording for this
          WABA — it backfills <strong>nothing</strong>, so anything sent earlier
          reads zero permanently. <code>regionUnsupported: true</code> means the
          number sits in a region Meta excludes from template analytics (the EU
          and Japan): every figure stays zero forever and re-fetching cannot
          change it. Both also appear on{" "}
          <code>metaAnalytics</code> in <code>/broadcasts/:id/report</code>.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/whatsapp/insights/status">
          Whether Meta&apos;s template analytics are switched on. Enabling is a{" "}
          <strong>one-time, irreversible</strong> opt-in per WABA, so there is no
          API to do it — it&apos;s an in-app admin action (Settings → WhatsApp).
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/whatsapp/health">
          Messaging tier + 24h unique-recipient cap, spend so far, quality rating
          and throughput ceiling. Secret-free. Plan against{" "}
          <code>remainingDailyBudget</code> — without it you discover the cap by
          having a large send refused, and the refusal is correct so there is
          nothing to retry. <code>portfolioAccountCount &gt; 1</code> means the
          budget is <strong>shared</strong> with other numbers in the portfolio.
          <code>?accountId=</code> scopes the figures to one number (quality and
          throughput are per-number; the budget is portfolio-shared).{" "}
          <code>utilityRestrictionType</code>, when set, means Meta is enforcing
          template-categorization rules on the WABA — utility sends over its cap
          are rejected until <code>utilityRestrictedUntil</code>.{" "}
          <code>bizMessagingRestrictionType</code> /{" "}
          <code>customerMessagingRestrictionType</code>, when set, mean Meta has
          blocked that direction of messaging over policy or spam violations
          (its 1&ndash;30-day enforcement ladder): business-initiated covers
          template/broadcast sends, customer-initiated covers replies. Each
          lifts at its <code>…RestrictedUntil</code>; a null expiry with the
          type set is an indefinite lock or account ban, cleared only by a
          successful appeal in Meta Business Support Home.
        </Endpoint>
        <Endpoint method="POST" path="/api/external/v1/whatsapp/health/refresh">
          Re-poll Meta for a number&apos;s tier / quality / throughput now
          instead of waiting for the periodic sweep. <code>?accountId=</code>{" "}
          picks the number; omitted polls the default. Scope{" "}
          <code>admin:settings</code> — it spends Graph reads.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/whatsapp/register"
          body={{ accountId: "acc_123", pin: "123456" }}
        >
          Register a connected number for Cloud API use (Meta&apos;s two-step
          verification PIN — passed straight through, never stored). A number
          saved before registration fails every send; this closes that gap
          without leaving the API. Meta&apos;s error is surfaced verbatim
          (wrong PIN, unapproved display name, number in use elsewhere). Scope{" "}
          <code>admin:settings</code>.
        </Endpoint>
        <p className="text-sm text-muted-foreground">
          <strong>Reading the nulls.</strong> <code>read</code> and{" "}
          <code>clicked</code> are null outside Meta&apos;s ~7-day window, and
          cost is null when the account is billed through a partner
          (<code>costWithheld: true</code> says which). A null is{" "}
          <strong>never</strong> the same as zero — the stored rollup preserves
          whatever was captured while it was still being reported.
        </p>
      </Section>

      <Section title="Saved inbox views">
        <p className="text-sm text-muted-foreground">
          A <strong>view</strong> is a named, reusable filter over the
          conversation list — &ldquo;Support · unassigned · WhatsApp&rdquo;.
          These are the same views your team sees in the inbox rail, backed by
          the same service, so a view can never select different conversations
          through the API than it shows in the product. Read needs{" "}
          <code>read:catalog</code>, writes need <code>write:catalog</code>.
        </p>
        <p className="text-sm text-muted-foreground">
          Two consequences of an API key not being a person:{" "}
          <strong>only shared views</strong> are visible or creatable (a
          personal view belongs to one teammate; an explicit{" "}
          <code>&quot;personal&quot;</code> returns{" "}
          <code>inbox_view_requires_user</code>), and a view whose assignee is{" "}
          <code>{`{ kind: "me" }`}</code> <strong>matches nothing</strong> here
          rather than silently widening to everyone.
        </p>
        <Endpoint method="GET" path="/api/external/v1/inbox-views">
          Every shared view in the workspace, in rail order.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/inbox-views/:id">
          One view. 404 for another workspace&apos;s id, so it can&apos;t be
          used to probe for existence.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/inbox-views"
          body={{
            name: "Unassigned WhatsApp",
            icon: "flame",
            color: "rose",
            filters: {
              statuses: ["open"],
              assignee: { kind: "unassigned" },
              channels: ["whatsapp"],
            },
          }}
        >
          Every <code>filters</code> field is optional and <strong>ANDed</strong>;
          an omitted field means &ldquo;no opinion&rdquo;, so <code>{`{}`}</code>{" "}
          is the widest possible view. Fields:{" "}
          <code>statuses</code>, <code>assignee</code> (
          <code>{`{ kind: "anyone" | "me" | "unassigned" }`}</code> or{" "}
          <code>{`{ kind: "users", userIds: [...] }`}</code>),{" "}
          <code>channels</code>, <code>stageIds</code>, <code>tagIds</code> +{" "}
          <code>tagMatch</code> (<code>&quot;any&quot;</code> default or{" "}
          <code>&quot;all&quot;</code>), <code>hasOpenFlags</code>,{" "}
          <code>unreadOnly</code>.
        </Endpoint>
        <Endpoint method="PATCH" path="/api/external/v1/inbox-views/:id" body={{ name: "Renamed" }}>
          Any subset of the create fields.
        </Endpoint>
        <Endpoint method="DELETE" path="/api/external/v1/inbox-views/:id">
          Removes the saved filter. Conversations are untouched.
        </Endpoint>
        <p className="text-sm text-muted-foreground">
          A view referencing a tag, stage or teammate that has since been
          deleted is <strong>widened</strong>, not emptied: the dead ids are
          dropped at read time. Deleting one tag of five must not silently blank
          a view. Errors: <code>inbox_view_not_found</code> (404),{" "}
          <code>inbox_view_name_taken</code> (400),{" "}
          <code>inbox_view_limit_reached</code> (400, 30 per scope).
        </p>
      </Section>

      <Section title="Assignment routing">
        <p className="text-sm text-muted-foreground">
          Full parity with Settings → Assignment. A <strong>policy</strong>
          decides how to pick someone; a <strong>rule</strong> decides which
          policy applies (top to bottom, first match wins, default policy as the
          fallback); <strong>settings</strong> decide when routing runs at all.
          Read needs <code>read:catalog</code>, writes need{" "}
          <code>admin:settings</code> — routing rules are admin authority, same as in the app.
        </p>
        <Endpoint method="GET" path="/api/external/v1/assignment">
          Everything at once: <code>{`{ policies, rules, settings, members }`}</code>.
          Each member carries their live <code>openCount</code> — the number a
          capacity limit is measured against.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/assignment/policies"
          body={{
            name: "Support — weighted",
            strategy: "weighted",
            defaultMaxOpen: 25,
            members: [
              { userId: "user_ali", weight: 50 },
              { userId: "user_sara", weight: 20 },
            ],
          }}
        >
          <code>strategy</code>: <code>least_busy</code> (default) ·{" "}
          <code>round_robin</code> · <code>weighted</code> · <code>fixed</code> ·{" "}
          <code>manual</code>. <code>eligibility</code>:{" "}
          <code>online_first</code> · <code>online_only</code> ·{" "}
          <code>available_only</code> · <code>any_active</code>.{" "}
          <code>overflow</code>: <code>leave_unassigned</code> ·{" "}
          <code>ignore_capacity</code> · <code>fallback_user</code>. Weighted is
          exact, not probabilistic: 50/20 over 70 conversations is 50 and 20.
        </Endpoint>
        <Endpoint
          method="PUT"
          path="/api/external/v1/assignment/policies/:id"
          body={{ name: "Support", expectedVersion: 3 }}
        >
          Requires <code>expectedVersion</code> from your last read. A stale
          version returns <code>409 version_conflict</code> instead of
          overwriting a co-admin&apos;s edit.
        </Endpoint>
        <Endpoint method="POST" path="/api/external/v1/assignment/policies/:id/default">
          Make this the fallback policy.
        </Endpoint>
        <Endpoint method="DELETE" path="/api/external/v1/assignment/policies/:id">
          Archive. The default policy can&apos;t be archived.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/assignment/rules"
          body={{
            name: "VIP WhatsApp → senior pool",
            policyId: "apol_...",
            conditions: {
              channelAccountIds: ["ccn_sales_line"],
              tagIds: ["tag_vip"],
            },
          }}
        >
          Clauses AND together; values inside one clause OR. Available:{" "}
          <code>channels</code>, <code>channelAccountIds</code>,{" "}
          <code>tagIds</code>, <code>stageIds</code>, <code>languages</code>{" "}
          (prefix match), <code>keywords</code> (case-insensitive substring),{" "}
          <code>isNewContact</code>, <code>sources</code>. An absent clause means
          &ldquo;don&apos;t care&rdquo;, so <code>{`{}`}</code> is a catch-all.
          <br />
          <code>channelAccountIds</code> is narrower than <code>channels</code>:
          it names specific <em>accounts</em> (a WhatsApp number, a Page, an
          Instagram handle — ids from{" "}
          <code>GET /v1/channel-accounts</code>), so a workspace running Sales and
          Support on two numbers can route each one to its own team. It fails
          closed: a conversation not bound to an account matches no
          account-scoped rule.
        </Endpoint>
        <Endpoint method="PUT" path="/api/external/v1/assignment/rules/order" body={{ ruleIds: ["r1", "r2"] }}>
          Full reorder — send the complete ordered id list.
        </Endpoint>
        <Endpoint method="PATCH" path="/api/external/v1/assignment/rules/:id">
          Update <code>name</code>, <code>policyId</code>, <code>enabled</code>{" "}
          or <code>conditions</code>.
        </Endpoint>
        <Endpoint method="DELETE" path="/api/external/v1/assignment/rules/:id">
          Delete a rule.
        </Endpoint>
        <Endpoint
          method="PATCH"
          path="/api/external/v1/assignment/settings"
          body={{ autoAssignOnNewConversation: true, skipWhenAiHandling: true }}
        >
          When routing runs: <code>autoAssignOnNewConversation</code>,{" "}
          <code>skipWhenAiHandling</code> (AI answers first, a human is routed in
          on escalation), <code>autoAssignOnReopen</code>,{" "}
          <code>reassignOnOffline</code> +{" "}
          <code>reassignOfflineAfterMinutes</code> +{" "}
          <code>reassignOfflineOnlyPending</code>,{" "}
          <code>reassignOnDeactivate</code>, and{" "}
          <code>aiHandoffPolicyId</code>.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/assignment/preview"
          body={{ source: "inbound", channel: "whatsapp" }}
        >
          Dry run against live presence and workload: who would take a
          conversation like this right now, and why. Read-only — it never
          advances the rotation cursor or the weighted counters, so it&apos;s safe
          to poll.
        </Endpoint>
      </Section>

      <Section title="Messages & notes">
        <Endpoint method="GET" path="/api/external/v1/conversations/:id/messages">
          Cursor-paginated message history.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/conversations/:id/messages"
          body={{ body: "Hello from the API" }}
          headers={{ "Idempotency-Key": "<uuid>" }}
        >
          Send a WhatsApp text. 24h-window enforced. Idempotency via{" "}
          <code>Idempotency-Key</code> header. Sending into a closed thread
          reopens it (closed → pending) once the send lands, like an inbox reply.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/conversations/:id/interactive"
          body={{
            body: "How would you like your order?",
            kind: "buttons",
            options: [
              { id: "pickup", title: "Pick up" },
              { id: "deliver", title: "Deliver" },
            ],
            contactShare: ["phone"],
          }}
          headers={{ "Idempotency-Key": "<uuid>" }}
        >
          Tappable options — <code>kind: &quot;buttons&quot;</code> (up to 3,
          ids ≤256 chars) or <code>kind: &quot;list&quot;</code> (up to 10 rows,
          ids ≤200 chars — Meta&apos;s caps differ by kind). Option{" "}
          <code>id</code>s and <code>title</code>s must each be unique. Both
          kinds take an optional <code>headerText</code> and{" "}
          <code>footerText</code> (≤60 chars each). On WhatsApp,{" "}
          <code>kind: &quot;location_request&quot;</code> sends the body with a
          native <strong>Send location</strong> button (no <code>options</code>{" "}
          — WhatsApp renders it); the customer&apos;s pick arrives as a normal
          inbound location message on the thread. Also WhatsApp-only,{" "}
          <code>kind: &quot;cta_url&quot;</code> renders one URL-opening button
          instead of a raw link in the body — pass{" "}
          <code>{`ctaUrl: { displayText (≤20), url, headerText? (≤60), footerText? (≤60) }`}</code>{" "}
          and no <code>options</code>. And <code>kind: &quot;carousel&quot;</code>{" "}
          sends 2–10 scrollable media cards — pass{" "}
          <code>{`carouselCards: [{ headerMedia: { kind: "image"|"video", link }, body? (≤160), ctaUrl? | quickReplies? (1–3) }]`}</code>
          ; every card must use the same button type and count, and quick-reply
          ids must be unique across the whole carousel. On Messenger &amp;
          Instagram you can also add <code>contactShare</code> consent chips (
          <code>&quot;phone&quot;</code> / <code>&quot;email&quot;</code>) that
          let the customer share those details in one tap from their Meta
          profile — the only way a social contact&apos;s phone or email ever
          reaches you. WhatsApp has no such chip and returns{" "}
          <code>422 contact_share_not_supported</code>. Requires{" "}
          <code>Idempotency-Key</code>.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/messages"
          body={{
            contact: { phone: "+15555550100" },
            text: "Hello from n8n",
          }}
          headers={{ "Idempotency-Key": "<uuid>" }}
        >
          Top-level send — resolves contact by <code>{`{ id }`}</code> or{" "}
          <code>{`{ phone }`}</code>, finds-or-opens a conversation, then sends.
          Provide exactly one of <code>text</code> or <code>template</code> ({" "}
          <code>{`{ name, language, variables }`}</code>). Only{" "}
          <code>template</code> sends outside the 24-hour customer-service window.{" "}
          URL-based <code>media</code> ({" "}
          <code>{`{ url, mime_type, caption? }`}</code>) is <strong>roadmap, not yet
          supported</strong> — it currently returns{" "}
          <code>400 media_not_yet_supported</code>; send media via the inbox UI for now.
          {" "}Other UI composer send types — direct media <strong>upload</strong>,{" "}
          <strong>location</strong>, <strong>contact-card</strong>,{" "}
          <strong>reaction</strong>, and message <strong>forward</strong> — are
          likewise roadmap and have no <code>/v1</code> endpoint yet; text,
          template, and interactive sends have full parity.
          <br />
          <br />
          <code>variables</code> accepts every parameter shape Meta defines:{" "}
          <code>body</code> (positional <code>{`{{1}}`}</code> templates),{" "}
          <code>bodyNamed</code> (<code>{`{{order_id}}`}</code> templates —
          mutually exclusive with <code>body</code>; the template&apos;s stored{" "}
          <code>parameter_format</code> decides which is read),{" "}
          <code>header</code> (a text header&apos;s one value),{" "}
          <code>headerMedia</code> (<code>{`{ kind, link, filename? }`}</code> for
          an image/video/document header — Meta fetches <code>link</code>),{" "}
          <code>headerLocation</code> (
          <code>{`{ latitude, longitude, name, address }`}</code> for a map
          header), and <code>buttons</code> (
          <code>{`{ index, subType, text }`}</code> for a dynamic URL suffix,
          a copy-code coupon, or a quick-reply payload — percent-encode a URL
          value), <code>tapTarget</code> (<code>{`{ url, title }`}</code>, which
          makes the whole message a call-to-action),{" "}
          <code>cards</code> (one entry per media-card carousel card, in order —
          the length must equal the card count the template was approved with;
          button indexes are scoped to the card), and{" "}
          <code>limitedTimeOfferExpiresAtMs</code> (UNIX{" "}
          <strong>milliseconds</strong> — required when the template shows a
          countdown; a past instant is rejected rather than delivered already
          expired). Supplying the wrong set is rejected with a named error such as{" "}
          <code>named_body_vars_required</code> or{" "}
          <code>button_params_required</code>, not an opaque Meta code.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/messages/:id">
          Find a single message by id.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/conversations/:id/notes"
          body={{ body: "Customer prefers SMS", authorUserId: "<user-id>" }}
        >
          Add an internal note (never sent to the customer). Body:{" "}
          <code>{`{ body: string, authorUserId: string }`}</code> —{" "}
          <code>authorUserId</code> is <strong>required</strong> (omitting it
          returns <code>400 authorUserId_required</code>) and must be a team
          member id from <code>GET /users</code>; create a dedicated
          service-account user for your integration if no human author applies.
        </Endpoint>
        <Endpoint
          method="DELETE"
          path="/api/external/v1/conversations/:id/notes/:noteId"
        >
          Delete an internal note. Fires the <code>note.deleted</code> webhook
          (symmetric with the create above, so a CRM mirror can complete a
          create→delete round-trip). Idempotent — a repeated delete returns{" "}
          <code>404 note_not_found</code>.
        </Endpoint>
      </Section>

      <Section title="Tickets (the unit of work)">
        <p className="mb-4 text-sm text-muted-foreground">
          A <strong>conversation</strong> is the long-lived thread with one contact — it
          never fragments. A <strong>ticket</strong> is one piece of <em>work</em> on that
          thread, and there are many over time: the refund raised in March and the
          delivery question in June are two tickets on one unbroken thread, each with its
          own assignee, priority, SLA clock and outcome. Every message carries the ticket
          it belongs to.
          <br />
          <br />
          Lifecycle: <code>new</code> → <code>open</code> → <code>pending</code> /{" "}
          <code>on_hold</code> → <code>solved</code> → <code>closed</code>. Tickets open
          by themselves — an inbound on a thread with no active ticket opens one, and a
          follow-up inside the reopen window (default 72h) comes back to the solved one
          instead of starting a third. <strong>Broadcasts never open tickets</strong>; a
          customer who replies to one does.
          <br />
          <br />
          Subscribe to the <code>ticket.changed</code> webhook to be told the instant work
          is opened, reassigned, solved, or breaches its SLA, then use these endpoints to
          work the backlog from your own system.
        </p>
        <Endpoint method="GET" path="/api/external/v1/tickets">
          The board, newest-first, keyset-paginated. Query: <code>status</code>,{" "}
          <code>priority</code>, <code>tagIds</code> (comma lists),{" "}
          <code>assignee</code> (a user id, <code>me</code>, or <code>none</code> for
          unassigned), <code>contactId</code>, <code>conversationId</code>,{" "}
          <code>channel</code>, <code>breached=true</code>,{" "}
          <code>cursorCreatedAt</code> + <code>cursorId</code>, <code>limit</code> (max
          50). An unknown enum value is a <code>400</code> that names it — a filter is
          never silently ignored. Scope <code>read:tickets</code>.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/tickets/counts">
          Header badges: <code>totalActive</code>, <code>mineActive</code>,{" "}
          <code>breached</code>, <code>byStatus</code>. <code>mineActive</code> is always
          0 for an API key (a key has no agent identity). Scope{" "}
          <code>read:tickets</code>.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/tickets/:id">
          One ticket plus its full <code>events</code> timeline. Scope{" "}
          <code>read:tickets</code>.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/tickets"
          body={{
            conversationId: "cnv_9",
            subject: "Also: wrong invoice",
            description: "Customer double-charged on the 3rd; billing to confirm.",
            priority: "high",
          }}
        >
          Open a ticket manually — a second issue raised in the same breath, or work
          created from your own system. <code>description</code> is the cause — free text a
          receiving team reads first. Also accepts <code>assignedUserId</code>,{" "}
          <code>assignedTeamId</code>, <code>tagIds</code>, <code>customFields</code>. With
          an assignee it starts <code>open</code>; without one it starts <code>new</code>,
          which is what makes an untriaged backlog reportable. Scope{" "}
          <code>write:tickets</code>.
        </Endpoint>
        <Endpoint
          method="PATCH"
          path="/api/external/v1/tickets/:id"
          body={{ expectedVersion: 3, status: "solved", resolutionCode: "refunded" }}
        >
          Status, priority, assignee, <strong>team</strong>, subject, tags, custom fields,
          resolution. Send{" "}
          <code>expectedVersion</code> from your last read and a write built on a stale
          view returns <code>409 version_conflict</code> instead of overwriting someone
          else&apos;s change; omit it and the write always applies (right for automation,
          which has no stale view to protect). Moving to <code>on_hold</code> pauses the
          SLA clock — leaving it pushes both deadlines out by exactly the parked time
          rather than restarting the commitment. Scope <code>write:tickets</code>.
        </Endpoint>
        <Endpoint
          method="PATCH"
          path="/api/external/v1/tickets/:id"
          body={{ assignedTeamId: "pol_sales", handoffReason: "Wants to upgrade their plan" }}
        >
          <strong>Hand a ticket to another team.</strong> A ticket can belong to a team (an
          assignment policy — Sales, Support, Billing) as well as, or instead of, a person:
          Support hands the <em>ticket</em> over and it sits in Sales&apos; queue with nobody
          on it until someone there claims it. <code>assignedTeamId</code> comes from{" "}
          <code>GET /assignment-policies</code>; <code>null</code> takes it out of every
          queue; a team from another workspace is rejected{" "}
          <code>400 team_not_found</code>. Setting it <strong>clears the assignee</strong>{" "}
          unless you name one too. Send <code>handoffReason</code> — without it the
          receiving team re-reads the whole thread to work out what was wanted. The
          resulting webhook carries <code>action: &quot;team_changed&quot;</code>, distinct
          from <code>&quot;assigned&quot;</code>. Filter with <code>?team=</code> (or{" "}
          <code>team=none</code>), which ANDs with <code>assignee</code>. Scope{" "}
          <code>write:tickets</code>.
        </Endpoint>
        <Endpoint method="DELETE" path="/api/external/v1/tickets/:id">
          <strong>Permanently delete a ticket</strong> — for work raised by mistake. The
          conversation and every message stay in the inbox (only unlinked); the work item
          and its timeline go. Returns <code>{"{ ok: true }"}</code>, or <code>404</code> if
          it isn&apos;t in your workspace. In the app this is limited to admins/managers; a
          scoped key is trusted like an integration. Scope <code>write:tickets</code>.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/tickets/:id/notes"
          body={{ body: "Tell them their order ships Tuesday." }}
        >
          An <strong>internal note</strong> — the customer never sees it. The other half of
          a handoff: the receiving team answers <em>what to say</em> without messaging the
          customer themselves. A separate route rather than a <code>PATCH</code> field
          because a note changes nothing about the ticket — it must not bump{" "}
          <code>version</code> (which would 409 a colleague&apos;s open editor) or move the
          SLA clock. Scope <code>write:tickets</code>.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/tickets/escalation-targets">
          The <strong>sibling workspaces</strong> of your organization a ticket can be
          escalated to — <code>{"{ workspaces: [{ id, name }] }"}</code>, id + name only,
          never the current workspace. Scope <code>read:tickets</code>.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/tickets/:id/escalate"
          body={{
            targetWorkspaceId: "ws_…",
            cause: "Customer was double-charged on invoice #88; needs a refund approval we can't give here.",
          }}
        >
          <strong>Escalate a ticket to a sibling workspace</strong> in your organization. A
          TWIN ticket is created over there (its own number, board card, assignee and SLA)
          carrying a frozen <em>snapshot</em> of the customer&apos;s profile — the
          conversation history stays private. <code>cause</code> is required: it becomes
          the twin&apos;s description and is everything the receiving workspace sees.
          Optional <code>subject</code> overrides the twin&apos;s title. One escalation per
          ticket lifetime (<code>409 already_escalated</code>); an escalation target cannot
          be escalated onward (<code>400 cannot_escalate_escalated_ticket</code>). Fires{" "}
          <code>ticket.changed</code> with <code>action: &quot;escalated&quot;</code> on the
          source. Scope <code>write:tickets</code>.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/tickets/:id/escalation-comments"
          body={{ body: "Refund approved — tell them it lands in 3–5 business days." }}
        >
          A comment <strong>both workspaces of the escalation pair see</strong> — unlike{" "}
          <code>/notes</code>, which stays private. Works from either side&apos;s ticket id.
          Like a note, it is not a ticket update: no <code>version</code> bump, no SLA
          movement. <code>400 escalation_severed</code> once the linked ticket was deleted.
          Scope <code>write:tickets</code>.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/tickets/:id/escalation/message-customer"
          body={{ channelConnectionId: "optional — which of your accounts to start from" }}
        >
          On an escalated-<em>in</em> ticket: <strong>start this workspace&apos;s own
          conversation</strong> with the customer from the snapshot&apos;s phone
          (find-or-create contact, reopen-not-fragment) and bind it to the ticket — from
          then on it behaves like any other ticket (replies attach, first response stamps).
          Returns <code>{"{ ticket, conversationId }"}</code>.{" "}
          <code>400 no_phone_in_snapshot</code> when the customer&apos;s source-channel
          identity has no phone — answer through shared comments instead. Scope{" "}
          <code>write:tickets</code>.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/tickets-settings">
          <code>ticketReopenWindowHours</code>,{" "}
          <code>ticketCloseConversationOnLastSolved</code>. <code>PATCH</code> the same
          path to change them (<code>admin:settings</code>). Scope{" "}
          <code>read:tickets</code>.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/ticket-sla"
          body={{ priority: "urgent", firstResponseMins: 15, resolutionMins: 60 }}
        >
          One commitment per priority; upserts on <code>priority</code>.{" "}
          <code>null</code> minutes means <strong>no commitment on that leg</strong> — not
          zero, so nothing is due and nothing breaches. Due dates are computed when a
          ticket is created and then stored, so editing a policy never retroactively
          breaches open work. <code>GET</code> the same path to read them. Scope{" "}
          <code>admin:settings</code> / <code>read:tickets</code>.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/ticket-fields">
          Custom fields on a ticket. <code>POST</code> to create,{" "}
          <code>PATCH</code>/<code>DELETE /ticket-fields/:id</code> to edit or remove. The{" "}
          <code>key</code> is derived from the label once and is immutable — stored values
          are keyed by it. Deleting a definition leaves its values in place (history on
          closed work); they just stop rendering. Scope <code>read:tickets</code> /{" "}
          <code>admin:settings</code>.
        </Endpoint>
      </Section>

      <Section title="Message flags (triage)">
        <p className="mb-4 text-sm text-muted-foreground">
          A <strong>message flag</strong> marks one message as needing follow-up of a
          named kind — “Complaint”, “Refund request” — and carries a lifecycle:{" "}
          <code>open</code> → <code>resolved</code> or <code>dismissed</code>
          {" "}(<code>dismissed</code> means “it wasn’t actually one”, so reporting can
          exclude it). Distinct from contact <strong>tags</strong>, which label a person
          and drive broadcast audiences.
          <br />
          <br />
          The intended integration shape: subscribe to the{" "}
          <code>message.flag_changed</code> webhook to be told the instant something is
          flagged, route on <code>flag.definitionName</code>, then use these endpoints to
          read the backlog and mark items handled from your own system.
        </p>
        <Endpoint method="GET" path="/api/external/v1/message-flags">
          The triage queue, newest-first, keyset-paginated. Query:{" "}
          <code>status</code> (repeatable or comma-joined; defaults to{" "}
          <code>open</code>), <code>definitionId</code>, <code>assignedTo</code> (a user
          id or the literal <code>unassigned</code>), <code>conversationId</code>,{" "}
          <code>cursor</code>, <code>take</code> (max 50). Each row carries the contact
          name, channel and a message excerpt, so a worklist renders without a second
          call. Scope <code>read:flags</code>.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/message-flags/counts">
          Open counts, team-wide and per definition. Scope <code>read:flags</code>.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/message-flag-definitions">
          The flag catalog (archived included) — resolve names to ids once and cache.
          Scope <code>read:catalog</code>.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/message-flag-definitions"
          body={{ name: "Complaint", color: "rose" }}
        >
          Create a flag definition. Scope <code>write:catalog</code>.{" "}
          <code>color</code> is one of the shared tag colors; anything
          unrecognized normalizes to <code>slate</code>.
        </Endpoint>
        <Endpoint
          method="PATCH"
          path="/api/external/v1/message-flag-definitions/:id"
          body={{ name: "Serious complaint" }}
        >
          Update <code>name</code>, <code>color</code>,{" "}
          <code>description</code>, <code>sortOrder</code> or{" "}
          <code>archivedAt</code>. Scope <code>write:catalog</code>.
        </Endpoint>
        <Endpoint method="DELETE" path="/api/external/v1/message-flag-definitions/:id">
          Archive a definition. Existing flags keep resolving to it, so history
          stays readable. Scope <code>write:catalog</code>.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/messages/:messageId/flags"
          body={{ definitionName: "Complaint", note: "Second time this month." }}
        >
          Raise a flag on a message. Provide <strong>exactly one</strong> of{" "}
          <code>definitionId</code> or <code>definitionName</code> (the name form exists
          so your config can say “Complaint” rather than a cuid). Optional{" "}
          <code>note</code> and <code>assignedToId</code>.
          <br />
          <br />
          <strong>Idempotent by construction</strong> — one flag of a given kind per
          message — so no <code>Idempotency-Key</code> is required and a retry converges
          on the same row rather than duplicating. Re-raising a resolved flag reopens
          it. Scope <code>write:flags</code>.
        </Endpoint>
        <Endpoint
          method="PATCH"
          path="/api/external/v1/message-flags/:flagId"
          body={{ status: "resolved", resolutionNote: "Refund issued, ticket #4192" }}
        >
          Resolve, dismiss, reopen, reassign, or edit the notes. Any subset of{" "}
          <code>status</code>, <code>assignedToId</code> (<code>null</code> to unassign),{" "}
          <code>note</code>, <code>resolutionNote</code>. Concurrency-safe: two clients
          resolving the same flag both succeed and the open count moves exactly once.
          Scope <code>write:flags</code>.
        </Endpoint>
        <Endpoint method="DELETE" path="/api/external/v1/message-flags/:flagId">
          Remove a flag entirely — “this was flagged by mistake”. Different from{" "}
          <code>dismissed</code>, which keeps the record that someone looked and decided
          it wasn’t one. Scope <code>write:flags</code>.
        </Endpoint>
      </Section>

      <Section title="Broadcasts (launching campaigns)">
        <p className="mb-4 text-sm text-muted-foreground">
          <strong>
            <code>write:broadcasts</code> is the most dangerous scope in this API.
          </strong>{" "}
          A create sends billed template messages to an entire audience and{" "}
          <strong>there is no unsend</strong>. <code>read:broadcasts</code> deliberately
          does <em>not</em> imply it, so a reporting integration can never be one typo away
          from launching a campaign.
          <br />
          <br />
          Create and retry both <strong>require</strong> an <code>Idempotency-Key</code>,
          and an ambiguous crash is never auto-cleared into a re-send: if we cannot prove a
          campaign did <em>not</em> launch, a retry with the same key is refused rather
          than risking a second one.
        </p>
        <Endpoint
          method="POST"
          path="/api/external/v1/broadcasts"
          headers={{ "Idempotency-Key": "campaign-autumn-2026" }}
          body={{
            templateId: "tpl_123",
            audience: { audienceGroupId: "aud_456" },
            variables: { "1": "{{contact.firstName}}" },
          }}
        >
          <strong>Launch a campaign</strong>, or schedule one by passing{" "}
          <code>scheduledAt</code>. Build the audience with the audience-group routes
          above, and call <code>preview-missing</code> first so you find out about empty
          variables now rather than from the failure report. <code>variables</code>{" "}
          accepts the same campaign-level extras as the single-message send —
          including <code>buttons</code> (<code>{`[{ index, subType, text }]`}</code>
          , the coupon code or URL suffix every recipient gets; required when
          the template&apos;s buttons carry a send-time value) and{" "}
          <code>tapTarget</code> (<code>{`{ url, title }`}</code>, one
          call-to-action destination for the whole campaign; Meta gates it on a
          fully verified, high-quality WABA). Returns the{" "}
          <code>broadcastId</code> and the resolved <code>totalCount</code>. Scope{" "}
          <code>write:broadcasts</code>.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/broadcasts/preview-missing"
          body={{ templateId: "tpl_123", audience: { audienceGroupId: "aud_456" } }}
        >
          <strong>Pre-send preflight:</strong> how many recipients would resolve a template
          variable to empty and be rejected by WhatsApp. Read-only. Scope{" "}
          <code>read:broadcasts</code>.
        </Endpoint>
        <Endpoint method="POST" path="/api/external/v1/broadcasts/:id/cancel">
          <strong>Stop a running or scheduled campaign.</strong> Recipients Meta has
          already accepted stay sent — a message cannot be unsent. Scope{" "}
          <code>write:broadcasts</code>.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/broadcasts/:id/retry"
          headers={{ "Idempotency-Key": "campaign-autumn-2026-retry-1" }}
          body={{ errorCodes: ["130429"] }}
        >
          <strong>Re-queue failed recipients.</strong> <code>errorCodes</code> narrows it to
          one failure bucket, so you can retry the rate-limited without also re-sending to
          numbers that are permanently invalid. This bills again —{" "}
          <code>Idempotency-Key</code> required. Scope <code>write:broadcasts</code>.
        </Endpoint>
        <Endpoint method="DELETE" path="/api/external/v1/broadcasts/:id">
          <strong>Delete a campaign</strong> and its recipient rows. Terminal campaigns
          only — one that is still running is refused. Scope{" "}
          <code>write:broadcasts</code>.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/broadcasts/:id/recipient-ids">
          <strong>Every recipient contact id</strong> — for building a follow-up audience
          from who actually received a campaign. Scope <code>read:broadcasts</code>.
        </Endpoint>
      </Section>

      <Section title="Conversation operations">
        <p className="mb-4 text-sm text-muted-foreground">
          Reads, status and assignment already existed; these are the operations an
          integration needs to actually drive a thread.
        </p>
        <Endpoint
          method="POST"
          path="/api/external/v1/conversations"
          body={{ phone: "+15555550100", name: "Dana Okafor" }}
        >
          <strong>Open (or reopen) a thread</strong> with a contact, by{" "}
          <code>contactId</code> or by <code>phone</code> — the precursor to a send.
          Idempotent by nature: an existing open thread comes back as-is, a closed one is
          reopened through the audited status path, and a phone with no contact yet
          find-or-creates one. Scope <code>write:conversations</code>.
        </Endpoint>
        <Endpoint method="POST" path="/api/external/v1/conversations/:id/read">
          <strong>Mark a thread read.</strong> Unread is <strong>team-wide</strong> in this
          product, not per-agent, so this clears it for everyone — call it when your system
          rather than a human has handled the thread. Repeating it is a genuine no-op.
          Scope <code>write:conversations</code>.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/conversations/:id/events">
          <strong>The audit timeline</strong> — every status change, assignment, tag and
          ticket transition, in order. Scope <code>read:conversations</code>.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/conversations/:id/attachments">
          <strong>Every media attachment</strong> on a thread, newest first. Scope{" "}
          <code>read:messages</code>.
        </Endpoint>
      </Section>

      <Section title="Customers (unified identity)">
        <p className="mb-4 text-sm text-muted-foreground">
          One person often reaches you on several channels — a WhatsApp number, an
          Instagram handle, a web-chat session. Each of those is a <strong>contact</strong>;
          the person behind them is a <strong>customer</strong>. Threads stay per-contact
          (we never merge message histories), so a customer is the profile-and-switcher
          layer over them.
          <br />
          <br />
          Merging here is the <strong>manual, reversible</strong> kind: linking only
          re-points a contact at a customer — no contact and no message is ever deleted, so
          unlink puts it back. Automatic merging happens at ingest on deterministic strong
          keys only (an exact phone, or an email the customer themselves shared) and is
          deliberately not exposed here. There is no fuzzy name matching, ever.
        </p>
        <Endpoint method="GET" path="/api/external/v1/contacts/:id/customer">
          <strong>The person behind a contact</strong>, with every channel identity they
          own — so you can answer &quot;is this the same human?&quot; without guessing.
          Scope <code>read:contacts</code>.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/contacts/:id/merge-suggestions">
          <strong>Possible same-person matches</strong> for a contact — the candidates an
          agent would be shown before confirming. Suggestions only: nothing is merged until
          you call <code>link</code>. Scope <code>read:contacts</code>.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/customers/:id">
          <strong>One customer profile</strong> and its linked contacts. Scope{" "}
          <code>read:contacts</code>.
        </Endpoint>
        <Endpoint method="PATCH" path="/api/external/v1/customers/:id" body={{ name: "Dana Okafor" }}>
          <strong>Rename the person.</strong> Scope <code>write:contacts</code>.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/customers/:id/link"
          body={{ contactId: "cnt_ig_9f2" }}
        >
          <strong>Merge:</strong> attach a contact to this customer. Reversible — this
          re-points <code>Contact.customerId</code> and nothing else. Scope{" "}
          <code>write:contacts</code>.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/customers/:id/unlink"
          body={{ contactId: "cnt_ig_9f2" }}
        >
          <strong>Split:</strong> take a contact back off this customer onto its own.
          Returns the customer id it now belongs to. Scope <code>write:contacts</code>.
        </Endpoint>
      </Section>

      <Section title="Workflows (automation)">
        <p className="mb-4 text-sm text-muted-foreground">
          Read your automations, fire a manual one for a contact, and inspect what
          happened. The scope split is deliberate: <strong>reading</strong> is{" "}
          <code>read:catalog</code> (a workflow is configuration), <strong>publishing</strong>{" "}
          is <code>admin:settings</code> (it changes what happens to everyone&apos;s
          conversations), and <strong>firing</strong> one is its own{" "}
          <code>write:workflows</code> — a run executes real step actions, including billed
          sends, which is not a catalog write.
        </p>
        <Endpoint method="GET" path="/api/external/v1/workflows">
          <strong>List workflows</strong> with their trigger and published state. Scope{" "}
          <code>read:catalog</code>.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/workflows/:id">
          <strong>One workflow</strong>, including its step graph. Scope{" "}
          <code>read:catalog</code>.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/workflows/:id/trigger"
          headers={{ "Idempotency-Key": "order-4417-shipped" }}
          body={{ contactId: "cnt_123", metadata: { orderId: "4417" } }}
        >
          <strong>Fire a manual-trigger workflow for one contact.</strong>{" "}
          <code>Idempotency-Key</code> is <strong>required</strong> — a run can send billed
          messages, so a retry after a timeout must not start a second one. Use something
          stable from your side (an order id, the inbound message id), not a random value.
          The workflow must be <strong>published</strong> and its trigger must be{" "}
          <code>manual_trigger</code>; anything else is rejected rather than silently doing
          nothing. <code>metadata</code> is yours — steps can read it. Scope{" "}
          <code>write:workflows</code>.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/workflows/:id/runs">
          <strong>Run history</strong> — what fired, when, and how it ended. Scope{" "}
          <code>read:catalog</code>.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/workflows/:id/runs/:runId">
          <strong>One run with its per-step journal</strong> — the first place to look when
          an automation &quot;did nothing&quot;. Scope <code>read:catalog</code>.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/workflows/:id/publish"
          body={{ publish: true }}
        >
          <strong>Publish or unpublish.</strong> An unpublished workflow is inert, so this
          switch is what makes automation live for the whole workspace. Scope{" "}
          <code>admin:settings</code>.
        </Endpoint>
      </Section>

      <Section title="Outbound webhooks (register your own)">
        <p className="mb-4 text-sm text-muted-foreground">
          Register the endpoint we POST events to — <strong>without anyone opening
          Settings</strong>. Until these existed an integration could not receive a single
          event until a human clicked through the app, which is the one step a self-serve
          install cannot do for itself.
          <br />
          <br />
          Every route needs <code>admin:settings</code>, including the reads: a webhook is
          a standing <strong>data-egress grant</strong> — every subscribed event body
          leaves the system — and the secret returned here is what signs that traffic.
          Delivery is signed (<code>X-CCP-Signature</code>), idempotent (a stable delivery
          id header), and retried with backoff before auto-disabling.
        </p>
        <Endpoint method="GET" path="/api/external/v1/outbound-webhooks">
          <strong>List your registered webhooks</strong> — url, subscribed event types,
          enabled state, last delivery outcome. The signing secret is never returned here
          (see create/rotate). Scope <code>admin:settings</code>.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/outbound-webhooks"
          body={{
            name: "Ops receiver",
            url: "https://example.com/hooks/ccp",
            eventTypes: ["message.received", "ticket.changed"],
          }}
        >
          <strong>Register an endpoint.</strong> The response carries the signing{" "}
          <code>secret</code> <strong>once and never again</strong> — same contract as an
          API key, so store it before you acknowledge the response. Subscribe only to what
          you act on: every extra event type is more traffic to verify and more data
          leaving the system. Scope <code>admin:settings</code>.
        </Endpoint>
        <Endpoint
          method="PATCH"
          path="/api/external/v1/outbound-webhooks/:id"
          body={{ enabled: false }}
        >
          <strong>Change the url, the subscription set, or pause it.</strong> Pausing with{" "}
          <code>enabled: false</code> is the safe move during your own maintenance —
          deleting loses the delivery history. Scope <code>admin:settings</code>.
        </Endpoint>
        <Endpoint method="POST" path="/api/external/v1/outbound-webhooks/:id/rotate-secret">
          <strong>Rotate the signing secret.</strong> Returns the new one once; the old one
          stops validating <em>immediately</em>, so swap it on your side in the same deploy
          rather than rotating and hoping. Scope <code>admin:settings</code>.
        </Endpoint>
        <Endpoint method="DELETE" path="/api/external/v1/outbound-webhooks/:id">
          <strong>Delete a webhook</strong> and its delivery history. Prefer{" "}
          <code>enabled: false</code> unless you mean it. Scope{" "}
          <code>admin:settings</code>.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/outbound-webhooks/:id/deliveries">
          <strong>The delivery log</strong> — what we sent, your response code, and the
          retry state. This is the first place to look when your receiver says it never got
          an event. Scope <code>admin:settings</code>.
        </Endpoint>
        <Endpoint method="POST" path="/api/external/v1/outbound-webhooks/:id/test">
          <strong>Fire a signed sample delivery.</strong> Verify your endpoint and your
          signature check <em>before</em> real traffic depends on them. Scope{" "}
          <code>admin:settings</code>.
        </Endpoint>
      </Section>

      <Section title="Audience groups">
        <p className="mb-4 text-sm text-muted-foreground">
          A saved audience is what a broadcast targets. Without these an integration could
          read campaign results but never build the list a campaign sends to.
        </p>
        <Endpoint method="GET" path="/api/external/v1/audience-groups">
          <strong>List saved audiences.</strong> Scope <code>read:catalog</code>.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/audience-groups/:id">
          <strong>One audience</strong> with its full definition. Scope{" "}
          <code>read:catalog</code>.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/audience-groups"
          body={{ name: "Lapsed customers", contactIds: ["cnt_123", "cnt_456"] }}
        >
          <strong>Create an audience.</strong> Contact ids from another workspace are
          silently dropped rather than rejected — the audience is always a subset of what
          you can actually reach. Scope <code>write:catalog</code>.
        </Endpoint>
        <Endpoint method="PATCH" path="/api/external/v1/audience-groups/:id" body={{ name: "Lapsed — Q3" }}>
          <strong>Rename or re-populate an audience.</strong> Scope{" "}
          <code>write:catalog</code>.
        </Endpoint>
        <Endpoint method="DELETE" path="/api/external/v1/audience-groups/:id">
          <strong>Delete an audience.</strong> Campaigns already sent keep their recipient
          records — an audience is the list you targeted <em>with</em>, not the record of
          who you reached. Scope <code>write:catalog</code>.
        </Endpoint>
      </Section>

      <Section title="Snippets (canned replies)">
        <p className="mb-4 text-sm text-muted-foreground">
          Reusable reply text agents insert in the composer. Keep them in sync from
          whatever system owns your support copy.
        </p>
        <Endpoint method="GET" path="/api/external/v1/snippets">
          <strong>List snippets.</strong> Scope <code>read:catalog</code>.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/snippets"
          body={{
            name: "shipping_times",
            label: "Shipping times",
            body: "Orders ship within 2 business days.",
          }}
        >
          <strong>Create a snippet.</strong> Scope <code>write:catalog</code>.
        </Endpoint>
        <Endpoint method="PATCH" path="/api/external/v1/snippets/:id" body={{ body: "Orders ship next business day." }}>
          <strong>Edit a snippet.</strong> Scope <code>write:catalog</code>.
        </Endpoint>
        <Endpoint method="DELETE" path="/api/external/v1/snippets/:id">
          <strong>Delete a snippet.</strong> Scope <code>write:catalog</code>.
        </Endpoint>
      </Section>


      <hr className="my-10 border-border" />

      <header className="mb-4">
        <h2 className="text-xl font-semibold">Webhook events</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Subscribe a URL to one or more event names in{" "}
          <Link
            href="/settings/integrations/webhooks"
            className="text-primary hover:underline"
          >
            Integrations → Webhooks
          </Link>
          . Every delivery is a flat JSON body — <code className="rounded bg-muted px-1 text-xs">team_id</code>,{" "}
          <code className="rounded bg-muted px-1 text-xs">event_type</code>, and
          the event-specific blocks shown in the samples below. There is no{" "}
          <code className="rounded bg-muted px-1 text-xs">data</code> wrapper.
        </p>
      </header>

      <div className="mb-6 rounded-md border border-border bg-card p-3 text-xs">
        <p className="mb-2 font-semibold text-foreground">Body shape (every delivery)</p>
        <pre className="overflow-x-auto rounded bg-muted/40 p-2 font-mono leading-relaxed">{`{
  "team_id": "cmpteam_…",          // present on every event so a multi-tenant
                                   //   receiver can route by team from the body
  "event_type": "message.received",
  // …event-specific top-level blocks — see the per-event samples below.
  // For message events: contact, assignee, message, channel, sender.
}`}</pre>
        <p className="mt-2 text-muted-foreground">
          De-dup on the{" "}
          <code className="rounded bg-muted px-1">X-CCP-Delivery</code> request
          header (a stable per-delivery id) — it is the only delivery
          identifier, and it is not repeated in the body. The{" "}
          <code className="rounded bg-muted px-1">channel</code> block is{" "}
          <code className="rounded bg-muted px-1">null</code> until you connect
          WhatsApp.
        </p>
      </div>

      <div className="mb-6 rounded-md border border-border bg-card p-3 text-xs">
        <p className="mb-1 font-semibold text-foreground">Signature verification</p>
        <p className="mb-2 text-muted-foreground">
          Every delivery includes{" "}
          <code className="rounded bg-muted px-1">X-CCP-Signature: t=&lt;unix-seconds&gt;,v1=&lt;hex&gt;</code>.
          Recompute <code>HMAC-SHA256(secret, &quot;&lt;t&gt;.&lt;raw_body&gt;&quot;)</code>{" "}
          and compare to <code>v1</code> in constant time. Reject if{" "}
          <code>t</code> is older than 5 minutes (replay protection).
        </p>
        <pre className="overflow-x-auto rounded bg-muted/40 p-2 font-mono leading-relaxed">{`// Node.js example
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, header, secret) {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(",").map((p) => p.trim().split("=")),
  );                                    // { t: "…", v1: "…" }
  if (!parts.t || !parts.v1) return false;
  const t = Number.parseInt(parts.t, 10);
  if (!Number.isFinite(t)) return false;
  if (Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = createHmac("sha256", secret)
    .update(t + "." + rawBody)
    .digest("hex");
  const a = Buffer.from(parts.v1, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}`}</pre>
      </div>

      <div className="flex flex-col gap-6">
        {PUBLIC_EVENT_GROUPS.map((g) => (
          <div key={g.group}>
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {g.group}
            </h3>
            <div className="flex flex-col gap-3 rounded-md border border-border bg-card p-3">
              {g.events.map((e) => (
                <div key={e.type} className="flex flex-col gap-1">
                  <code className="font-mono text-xs">{e.type}</code>
                  <span className="text-xs font-medium">{e.label}</span>
                  <span className="text-xs text-muted-foreground">{e.description}</span>
                  <details className="mt-1 text-2xs">
                    <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                      Sample payload
                    </summary>
                    <pre className="mt-1 overflow-x-auto rounded bg-muted/40 p-2 font-mono leading-relaxed">
                      {JSON.stringify(
                        toWirePayload(e.type, e.samplePayload, { channelBase: SAMPLE_CHANNEL }),
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-2 text-base font-semibold">{title}</h2>
      <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-3">
        {children}
      </div>
    </section>
  );
}

type Method = "GET" | "POST" | "PATCH" | "DELETE" | "PUT";

function Endpoint({
  method,
  path,
  body,
  headers,
  children,
}: {
  method: Method;
  path: string;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  children: React.ReactNode;
}) {
  const color =
    method === "GET"
      ? "bg-success-bg text-success-fg"
      : method === "POST"
        ? "bg-blue-500/10 text-blue-600"
        : method === "PATCH"
          ? "bg-warning-bg text-warning-fg"
          : method === "DELETE"
            ? "bg-destructive/10 text-destructive"
            : "bg-slate-500/10 text-slate-600";
  return (
    <div className="flex flex-col gap-1 px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-3xs font-bold ${color}`}>{method}</span>
        <code className="truncate font-mono text-xs">{path}</code>
        <CopyCurlButton method={method} path={path} body={body} headers={headers} />
      </div>
      <div className="pl-12 text-xs text-muted-foreground">{children}</div>
    </div>
  );
}
