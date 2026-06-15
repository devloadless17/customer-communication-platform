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
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/contacts/:id">
          Fetch a single contact (including custom fields, tags, stage).
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
          Read-only lifecycle stage catalog.
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
          <code>Idempotency-Key</code> header.
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
          Accepts <code>text</code> OR <code>template</code> ({" "}
          <code>{`{ name, language, variables }`}</code>).
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/messages/:id">
          Find a single message by id.
        </Endpoint>
        <Endpoint
          method="POST"
          path="/api/external/v1/conversations/:id/notes"
          body={{ body: "Customer prefers SMS", authorUserId: "user_..." }}
        >
          Add an internal note. Body:{" "}
          <code>{`{ body: string, authorUserId: string }`}</code>.
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
  const [tPart, sigPart] = header.split(",");
  const t = tPart.slice(2);             // "t=…"
  const sig = sigPart.slice(3);         // "v1=…"
  if (Date.now() / 1000 - Number(t) > 300) return false;
  const expected = createHmac("sha256", secret)
    .update(t + "." + rawBody)
    .digest("hex");
  return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
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
