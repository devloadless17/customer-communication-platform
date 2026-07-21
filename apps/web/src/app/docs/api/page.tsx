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
  { scope: "read:catalog", grants: "read tags · fields · stages · channels · users" },
  { scope: "write:catalog", grants: "create / edit tags + custom fields" },
  { scope: "read:broadcasts", grants: "read broadcast campaigns + delivery reports" },
  { scope: "read:calls", grants: "read call history + calling-permission state" },
  { scope: "write:calls", grants: "request calling permission · send call buttons" },
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
          <code>?cursor=</code>, <code>?limit=</code>.
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
          Read-only channel list (today: a single WhatsApp row per team).
        </Endpoint>
      </Section>

      <Section title="Users">
        <Endpoint method="GET" path="/api/external/v1/users">
          List team members. Use this to populate an n8n assignment dropdown.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/users/:idOrEmail">
          Find a user by id or by email.
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
          that did connect.
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
          <code>?cursor=</code>.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/conversations/:id">
          Fetch one + its contact.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/conversations/:id/assign"
          body={{ assignedUserId: "user_..." }}
        >
          Body: <code>{`{ assignedUserId: string | null }`}</code>.
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
          Tappable options — <code>kind: &quot;buttons&quot;</code> or{" "}
          <code>kind: &quot;list&quot;</code> (up to 10). Option <code>id</code>s
          and <code>title</code>s must each be unique. On Messenger &amp;
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
