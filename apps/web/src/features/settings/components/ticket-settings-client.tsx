"use client";

import { useState, useTransition } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/layouts/page-header";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { apiFetch } from "@/lib/api/client-fetch";
import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import { toast } from "@/lib/toast";
import {
  TICKET_PRIORITIES,
  type TicketFieldDefinition,
  type TicketPriority,
  type TicketSlaPolicy,
} from "@ccp/shared/tickets/types";

export function TicketSettingsClient({
  policies,
  fields,
}: {
  policies: TicketSlaPolicy[];
  fields: TicketFieldDefinition[];
}) {
  const refresh = useSoftRefresh();
  const [, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);

  const save = async (path: string, init: RequestInit) => {
    setSaving(true);
    try {
      const res = await apiFetch(path, {
        headers: { "content-type": "application/json" },
        ...init,
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
        throw new Error(d.detail || d.error || "Couldn't save");
      }
      startTransition(() => refresh());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Tickets"
        description="What each priority promises, and the fields every ticket carries. Tickets are raised deliberately — by an agent from the inbox or by a workflow — and never open, reopen or close a conversation on their own: closing a thread is the agent's call when they are done with the customer."
        action={saving ? <Loader2 aria-hidden className="size-4 animate-spin" /> : undefined}
      />

      <SlaPolicies policies={policies} onSave={save} />
      <CustomFields fields={fields} onSave={save} />
    </div>
  );
}

type Saver = (path: string, init: RequestInit) => Promise<void>;

function SlaPolicies({ policies, onSave }: { policies: TicketSlaPolicy[]; onSave: Saver }) {
  const byPriority = new Map(policies.map((p) => [p.priority, p]));
  return (
    <section className="rounded-xl border bg-card p-4">
      <h2 className="text-sm font-semibold">Response promises</h2>
      <p className="mb-3 text-2xs text-muted-foreground">
        One commitment per priority. Leave a field empty to promise nothing on that leg —
        empty is not zero, it means nothing is due and nothing can be late. Due dates are
        fixed when a ticket opens, so editing these never back-dates a breach onto work
        already in flight.
      </p>
      <ul className="flex flex-col gap-2">
        {TICKET_PRIORITIES.map((priority) => (
          <SlaRow
            key={priority}
            priority={priority}
            policy={byPriority.get(priority)}
            onSave={onSave}
          />
        ))}
      </ul>
    </section>
  );
}

function SlaRow({
  priority,
  policy,
  onSave,
}: {
  priority: TicketPriority;
  policy: TicketSlaPolicy | undefined;
  onSave: Saver;
}) {
  const [first, setFirst] = useState(policy?.firstResponseMins?.toString() ?? "");
  const [resolution, setResolution] = useState(policy?.resolutionMins?.toString() ?? "");

  const parse = (v: string): number | null | undefined => {
    const t = v.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };

  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2">
      <span className="w-16 text-xs font-medium capitalize">{priority}</span>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const f = parse(first);
          const r = parse(resolution);
          if (f === undefined || r === undefined) {
            toast.error("Enter a whole number of minutes, or leave it empty for no promise");
            return;
          }
          void onSave("/api/workspace/tickets/sla", {
            method: "POST",
            body: JSON.stringify({ priority, firstResponseMins: f, resolutionMins: r }),
          });
        }}
      >
        <label className="flex items-center gap-1 text-2xs text-muted-foreground">
          First reply
          <Input
            value={first}
            onChange={(e) => setFirst(e.target.value)}
            placeholder="—"
            inputMode="numeric"
            className="h-7 w-16 text-xs"
          />
          min
        </label>
        <label className="flex items-center gap-1 text-2xs text-muted-foreground">
          Resolution
          <Input
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
            placeholder="—"
            inputMode="numeric"
            className="h-7 w-16 text-xs"
          />
          min
        </label>
        <Button type="submit" size="sm" variant="ghost" className="h-7 px-2 text-2xs">
          Save
        </Button>
      </form>
    </li>
  );
}

function CustomFields({
  fields,
  onSave,
}: {
  fields: TicketFieldDefinition[];
  onSave: Saver;
}) {
  const { confirm, confirmDialog } = useConfirm();
  const [label, setLabel] = useState("");

  return (
    <section className="rounded-xl border bg-card p-4">
      {confirmDialog}
      <h2 className="text-sm font-semibold">Ticket fields</h2>
      <p className="mb-3 text-2xs text-muted-foreground">
        Custom fields on a ticket — “root cause”, “order ID”. Separate from contact fields:
        one describes a person, the other describes one piece of work.
      </p>

      <ul className="mb-3 flex flex-col gap-1.5">
        {fields.map((f) => (
          <li key={f.id} className="flex items-center gap-2 rounded-lg border px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium">{f.label}</div>
              <div className="truncate text-3xs text-muted-foreground">{f.key}</div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-destructive"
              onClick={async () => {
                const ok = await confirm({
                  title: `Remove “${f.label}”?`,
                  // Say what does NOT happen — the surprising, reassuring part.
                  description:
                    "The field disappears from the ticket form. Values already saved on existing tickets are kept as history; they just stop being shown.",
                  confirmLabel: "Remove",
                  destructive: true,
                });
                if (ok) {
                  void onSave(`/api/workspace/tickets/fields/${f.id}`, { method: "DELETE" });
                }
              }}
            >
              <Trash2 aria-hidden className="size-3.5" />
              <span className="sr-only">Remove {f.label}</span>
            </Button>
          </li>
        ))}
        {fields.length === 0 && (
          <li className="text-2xs text-muted-foreground">No ticket fields yet.</li>
        )}
      </ul>

      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = label.trim();
          if (!trimmed) return;
          setLabel("");
          void onSave("/api/workspace/tickets/fields", {
            method: "POST",
            body: JSON.stringify({ label: trimmed }),
          });
        }}
      >
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Root cause"
          maxLength={80}
          // A placeholder is not an accessible name: it vanishes as soon as the
          // field has a value.
          aria-label="Ticket field name"
          className="h-8 max-w-xs text-xs"
        />
        <Button type="submit" size="sm" variant="outline" className="h-8 px-2 text-2xs">
          <Plus aria-hidden className="mr-1 size-3.5" />
          Add field
        </Button>
      </form>
    </section>
  );
}

