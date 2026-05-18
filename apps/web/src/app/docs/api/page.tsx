import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { PUBLIC_EVENT_GROUPS } from "@ccp/shared/outbound-webhooks/public-events";

export const metadata = { title: "API reference" };

/**
 * Single-page reference of every `/api/external/v1` endpoint + every
 * outbound webhook event type. Kept deliberately public — there's no
 * sensitive info on this page, and partners may want to read it before
 * signing up.
 */
export default function ApiDocsPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
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
          from a key you created in{" "}
          <Link
            href="/settings/api-keys"
            className="text-primary hover:underline"
          >
            Settings → API keys
          </Link>
          .
        </p>
      </header>

      <Section title="Contacts">
        <Endpoint method="GET" path="/api/external/v1/contacts">
          List or find contacts. <code>?phone=</code> for exact E.164 match;{" "}
          <code>?search=</code> for fuzzy; <code>?stageId=</code>,{" "}
          <code>?tagIds=</code>, <code>?cursor=</code>, <code>?limit=</code> for paging.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/contacts/:id">
          Fetch a single contact (including custom fields, tags, stage).
        </Endpoint>
        <Endpoint method="POST" path="/api/external/v1/contacts">
          Create a contact. Requires <code>phoneNumber</code> (E.164). Returns 409
          on duplicate.
        </Endpoint>
        <Endpoint method="POST" path="/api/external/v1/contacts/upsert">
          Find-or-create by <code>phoneNumber</code>. Returns{" "}
          <code>{`{ contact, created: boolean }`}</code>.
        </Endpoint>
        <Endpoint method="PATCH" path="/api/external/v1/contacts/:id">
          Partial update — name, email, location, customFields, stageId. Phone is
          immutable.
        </Endpoint>
        <Endpoint method="DELETE" path="/api/external/v1/contacts/:id">
          Hard-delete and cascade conversations + notes + tags + broadcast
          recipient rows.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/contacts/:id/channels">
          List a contact's channels (today: one WhatsApp row per contact).
        </Endpoint>
        <Endpoint method="POST" path="/api/external/v1/contacts/:id/tags">
          Add tag(s) to a single contact. Body: <code>{`{ tagIds: string[] }`}</code>.
        </Endpoint>
        <Endpoint method="DELETE" path="/api/external/v1/contacts/:id/tags/:tagId">
          Remove a tag from a contact.
        </Endpoint>
        <Endpoint method="POST" path="/api/external/v1/contacts/tags/add">
          Bulk add tags. Body: <code>{`{ contactIds: string[], tagIds: string[] }`}</code>.
        </Endpoint>
        <Endpoint method="POST" path="/api/external/v1/contacts/tags/remove">
          Bulk remove tags. Same body shape as <code>add</code>.
        </Endpoint>
      </Section>

      <Section title="Custom field definitions">
        <Endpoint method="GET" path="/api/external/v1/contact-fields">
          List every custom field definition (id, key, label, order).
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/contact-fields/:idOrKey">
          Find a field by id or by stable key (e.g. <code>amount_usd</code>).
        </Endpoint>
        <Endpoint method="POST" path="/api/external/v1/contact-fields">
          Create a new field. Body: <code>{`{ label: string }`}</code>. Key is
          auto-derived from the label.
        </Endpoint>
      </Section>

      <Section title="Tags & stages">
        <Endpoint method="GET" path="/api/external/v1/tags">
          List the tag catalog.
        </Endpoint>
        <Endpoint method="POST" path="/api/external/v1/tags">
          Create a tag. Body: <code>{`{ name: string, color?: string }`}</code>.
        </Endpoint>
        <Endpoint method="PATCH" path="/api/external/v1/tags/:id">
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
        <Endpoint method="POST" path="/api/external/v1/conversations/:id/assign">
          Body: <code>{`{ assignedUserId: string | null }`}</code>.
        </Endpoint>
        <Endpoint method="POST" path="/api/external/v1/conversations/:id/status">
          Body: <code>{`{ status: "open" | "pending" | "closed" }`}</code>.
        </Endpoint>
      </Section>

      <Section title="Messages & notes">
        <Endpoint method="GET" path="/api/external/v1/conversations/:id/messages">
          Cursor-paginated message history.
        </Endpoint>
        <Endpoint method="POST" path="/api/external/v1/conversations/:id/messages">
          Send a WhatsApp text. 24h-window enforced. Idempotency via{" "}
          <code>Idempotency-Key</code> header.
        </Endpoint>
        <Endpoint method="GET" path="/api/external/v1/messages/:id">
          Find a single message by id.
        </Endpoint>
        <Endpoint method="POST" path="/api/external/v1/conversations/:id/notes">
          Add an internal note. Body:{" "}
          <code>{`{ body: string, authorUserId: string }`}</code>.
        </Endpoint>
      </Section>

      <hr className="my-10 border-border" />

      <header className="mb-4">
        <h2 className="text-xl font-semibold">Webhook events</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          When you subscribe a webhook to one of these event names in{" "}
          <Link
            href="/settings/integrations/webhooks"
            className="text-primary hover:underline"
          >
            Integrations → Webhooks
          </Link>
          , we POST a JSON envelope to your URL with an{" "}
          <code className="rounded bg-muted px-1 text-xs">X-CCP-Signature</code>{" "}
          header (HMAC-SHA256 over the raw body, timestamped — see the docs in
          the create form).
        </p>
      </header>

      <div className="flex flex-col gap-6">
        {PUBLIC_EVENT_GROUPS.map((g) => (
          <div key={g.group}>
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {g.group}
            </h3>
            <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-3">
              {g.events.map((e) => (
                <div key={e.type} className="flex flex-col gap-0.5">
                  <code className="font-mono text-xs">{e.type}</code>
                  <span className="text-xs font-medium">{e.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {e.description}
                  </span>
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

function Endpoint({
  method,
  path,
  children,
}: {
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  path: string;
  children: React.ReactNode;
}) {
  const color =
    method === "GET"
      ? "bg-emerald-500/10 text-emerald-600"
      : method === "POST"
        ? "bg-blue-500/10 text-blue-600"
        : method === "PATCH"
          ? "bg-amber-500/10 text-amber-600"
          : method === "DELETE"
            ? "bg-destructive/10 text-destructive"
            : "bg-slate-500/10 text-slate-600";
  return (
    <div className="flex flex-col gap-1 px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${color}`}>{method}</span>
        <code className="font-mono text-xs">{path}</code>
      </div>
      <div className="pl-12 text-xs text-muted-foreground">{children}</div>
    </div>
  );
}
