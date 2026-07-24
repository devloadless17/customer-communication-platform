"use client";

import { useState, useTransition } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/layouts/page-header";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { apiFetch } from "@/lib/api/client-fetch";
import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import { toast } from "@/lib/toast";
import type { TicketSettingsView } from "@/lib/api/queries";
import {
  TICKET_PRIORITIES,
  type TicketFieldDefinition,
  type TicketPriority,
  type TicketSlaPolicy,
} from "@ccp/shared/tickets/types";

export function TicketSettingsClient({
  settings,
  policies,
  fields,
}: {
  settings: TicketSettingsView;
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
        description="When work opens by itself, how long it stays reopenable, and what each priority promises."
        action={saving ? <Loader2 aria-hidden className="size-4 animate-spin" /> : undefined}
      />

      <Behaviour settings={settings} onSave={save} />
      <SlaPolicies policies={policies} onSave={save} />
      <CustomFields fields={fields} onSave={save} />
    </div>
  );
}

type Saver = (path: string, init: RequestInit) => Promise<void>;

function Behaviour({ settings, onSave }: { settings: TicketSettingsView; onSave: Saver }) {
  const [reopenHours, setReopenHours] = useState(String(settings.ticketReopenWindowHours));

  const patch = (body: Record<string, unknown>) =>
    onSave("/api/workspace/tickets/settings", { method: "PATCH", body: JSON.stringify(body) });

  return (
    <section className="rounded-xl border bg-card p-4">
      <h2 className="text-sm font-semibold">How tickets open</h2>
      <p className="mb-3 mt-0.5 text-2xs text-muted-foreground">
        A ticket is always raised deliberately — by an agent from the inbox
        (&ldquo;Raise a ticket&rdquo;) or by a workflow. Incoming messages never
        open one on their own; the inbox already tracks every conversation.
      </p>

      <Row
        title="Reopen window"
        hint="How long after a ticket is solved a follow-up message reopens it instead of starting a new one. Too short and one issue becomes three tickets; too long and a genuinely new question gets buried in resolved work. 0 disables reopening."
      >
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(reopenHours);
            if (!Number.isInteger(n) || n < 0 || n > 720) {
              toast.error("Enter a whole number of hours between 0 and 720");
              return;
            }
            void patch({ ticketReopenWindowHours: n });
          }}
        >
          <Input
            value={reopenHours}
            onChange={(e) => setReopenHours(e.target.value)}
            inputMode="numeric"
            className="h-8 w-20 text-xs"
          />
          <span className="text-2xs text-muted-foreground">hours</span>
          <Button type="submit" size="sm" variant="ghost" className="h-8 px-2 text-2xs">
            Save
          </Button>
        </form>
      </Row>

      <Row
        title="Close the conversation when its last ticket is solved"
        hint="Off by default: conversation status and ticket status are deliberately independent, so closing work doesn't hide a thread the customer may still be writing in."
      >
        <Switch
          checked={settings.ticketCloseConversationOnLastSolved}
          onCheckedChange={(v) => void patch({ ticketCloseConversationOnLastSolved: v })}
        />
      </Row>
    </section>
  );
}

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

function Row({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-4 border-b py-3 last:border-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium">{title}</div>
        <p className="mt-0.5 text-2xs text-muted-foreground">{hint}</p>
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}
