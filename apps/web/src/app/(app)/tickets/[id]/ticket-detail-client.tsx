"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Clock, Loader2, MessageSquare } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { LocalTime } from "@/components/local-time";
import { ChannelBadge } from "@/features/inbox/components/channel-badge";
import { apiFetch } from "@/lib/api/client-fetch";
import { getClientSocket } from "@/lib/socket-client";
import { toast } from "@/lib/toast";
import { cn } from "@ccp/shared/utils";
import { tagColorClasses } from "@ccp/shared/utils/tag-colors";
import type { Channel, Tag, User } from "@ccp/shared/types";
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type Ticket,
  type TicketEvent,
  type TicketPriority,
  type TicketStatus,
} from "@ccp/shared/tickets/types";

/**
 * The ticket detail.
 *
 * Every state is reachable here (unlike the board, which offers only the next
 * sensible move) because this is where someone comes to make a decision about
 * one piece of work rather than to keep a queue flowing.
 *
 * The SSR seed is the source of truth on first paint; the `ticket:changed`
 * frame patches it afterwards, filtered to THIS ticket — the frame is
 * workspace-wide, so an unfiltered handler would re-render this page every time
 * anyone touched anything.
 */

const STATUS_LABELS: Record<TicketStatus, string> = {
  new: "New",
  open: "Open",
  pending: "Waiting on customer",
  on_hold: "On hold",
  solved: "Solved",
  closed: "Closed",
};

const EVENT_LABELS: Record<string, string> = {
  created: "opened this ticket",
  assigned: "assigned it",
  unassigned: "unassigned it",
  status_changed: "changed the status",
  priority_changed: "changed the priority",
  subject_changed: "renamed it",
  tag_added: "added a tag",
  tag_removed: "removed a tag",
  field_changed: "edited a field",
  sla_breached: "missed the SLA",
  reopened: "reopened it",
  merged: "merged it",
};

export function TicketDetailClient({
  ticket: seed,
  events: seedEvents,
  users,
  tags,
}: {
  ticket: Ticket;
  events: TicketEvent[];
  users: User[];
  tags: Tag[];
}) {
  const [ticket, setTicket] = useState(seed);
  const [events, setEvents] = useState(seedEvents);
  const [busy, setBusy] = useState(false);
  const [subject, setSubject] = useState(seed.subject ?? "");

  // Filtered to THIS ticket: `ticket:changed` is workspace-scoped, so an
  // unfiltered handler would re-render the page on every ticket in the org.
  useEffect(() => {
    const socket = getClientSocket();
    const onTicket = (payload: { ticket: Ticket }) => {
      if (payload.ticket.id !== seed.id) return;
      setTicket((prev) => (prev.version === payload.ticket.version ? prev : payload.ticket));
    };
    socket.on("ticket:changed", onTicket);
    return () => {
      socket.off("ticket:changed", onTicket);
    };
  }, [seed.id]);

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await apiFetch(`/api/tickets/${ticket.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, expectedVersion: ticket.version }),
      });
      if (res.status === 409) {
        toast.error("Someone else just changed this ticket — reloading");
        await reload();
        return;
      }
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
        throw new Error(d.detail || d.error || "Couldn't update this ticket");
      }
      const body2 = (await res.json()) as { ticket: Ticket };
      setTicket(body2.ticket);
      // The timeline grew — refetch just it, rather than the whole page.
      await reload({ eventsOnly: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update this ticket");
    } finally {
      setBusy(false);
    }
  };

  const reload = async (opts: { eventsOnly?: boolean } = {}) => {
    const res = await apiFetch(`/api/tickets/${ticket.id}`);
    if (!res.ok) return;
    const body = (await res.json()) as { ticket: Ticket; events: TicketEvent[] };
    if (!opts.eventsOnly) setTicket(body.ticket);
    setEvents(body.events);
  };

  const breached = ticket.sla.firstResponseBreached || ticket.sla.resolutionBreached;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div>
        <Link
          href="/tickets"
          className="mb-2 inline-flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft aria-hidden className="size-3.5" />
          All tickets
        </Link>

        <div className="flex items-center gap-2">
          <span className="text-sm tabular-nums text-muted-foreground">#{ticket.number}</span>
          <ChannelBadge channel={ticket.channel as Channel} />
          {breached && (
            <Badge variant="muted" className="gap-1 px-1.5 py-0 text-3xs text-destructive">
              <AlertTriangle aria-hidden className="size-3" />
              {ticket.sla.firstResponseBreached ? "First reply overdue" : "Resolution overdue"}
            </Badge>
          )}
          {ticket.reopenCount > 0 && (
            <Badge variant="muted" className="px-1.5 py-0 text-3xs">
              Reopened {ticket.reopenCount}×
            </Badge>
          )}
        </div>

        <form
          className="mt-1 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const next = subject.trim();
            if (next === (ticket.subject ?? "")) return;
            void patch({ subject: next || null });
          }}
        >
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder={`${ticket.contactName}'s request`}
            maxLength={200}
            className="h-9 border-transparent px-0 text-lg font-semibold shadow-none focus-visible:border-input focus-visible:px-2"
          />
        </form>

        <p className="text-2xs text-muted-foreground">
          {ticket.contactName} · opened <LocalTime iso={ticket.createdAt} format="listTime" />
          {" · "}
          <Link href={`/inbox?c=${ticket.conversationId}`} className="hover:underline">
            <MessageSquare aria-hidden className="mr-0.5 inline size-3" />
            Open the conversation
          </Link>
        </p>
      </div>

      <section className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2">
        <Field label="Status">
          <select
            value={ticket.status}
            disabled={busy}
            onChange={(e) => void patch({ status: e.target.value as TicketStatus })}
            className="h-8 w-full rounded-md border bg-background px-2 text-xs"
          >
            {TICKET_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Priority">
          <select
            value={ticket.priority}
            disabled={busy}
            onChange={(e) => void patch({ priority: e.target.value as TicketPriority })}
            className="h-8 w-full rounded-md border bg-background px-2 text-xs capitalize"
          >
            {TICKET_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Assignee">
          <select
            value={ticket.assignedUserId ?? ""}
            disabled={busy}
            onChange={(e) => void patch({ assignedUserId: e.target.value || null })}
            className="h-8 w-full rounded-md border bg-background px-2 text-xs"
          >
            <option value="">Unassigned</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="SLA">
          <SlaSummary ticket={ticket} />
        </Field>
      </section>

      <section className="rounded-xl border bg-card p-4">
        <h2 className="mb-2 text-sm font-semibold">Tags</h2>
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag) => {
            const on = ticket.tags.some((t) => t.id === tag.id);
            return (
              <button
                key={tag.id}
                type="button"
                disabled={busy}
                onClick={() =>
                  void patch({
                    tagIds: on
                      ? ticket.tags.filter((t) => t.id !== tag.id).map((t) => t.id)
                      : [...ticket.tags.map((t) => t.id), tag.id],
                  })
                }
                className={cn(
                  "rounded px-2 py-0.5 text-2xs transition-opacity",
                  on ? tagColorClasses(tag.color) : "border text-muted-foreground opacity-60 hover:opacity-100",
                )}
              >
                {tag.name}
              </button>
            );
          })}
          {tags.length === 0 && (
            <p className="text-2xs text-muted-foreground">
              No tags yet — create them in Settings.
            </p>
          )}
        </div>
      </section>

      {(ticket.resolutionCode || ticket.resolutionNote) && (
        <section className="rounded-xl border bg-card p-4">
          <h2 className="mb-1 text-sm font-semibold">Resolution</h2>
          {ticket.resolutionCode && (
            <p className="text-xs font-medium">{ticket.resolutionCode}</p>
          )}
          {ticket.resolutionNote && (
            <p className="mt-0.5 text-2xs text-muted-foreground">{ticket.resolutionNote}</p>
          )}
        </section>
      )}

      <section className="rounded-xl border bg-card p-4">
        <h2 className="mb-2 text-sm font-semibold">History</h2>
        <ol className="flex flex-col gap-2">
          {events.map((e) => (
            <li key={e.id} className="flex items-baseline gap-2 text-2xs">
              <span className="text-muted-foreground">
                <LocalTime iso={e.createdAt} format="listTime" />
              </span>
              <span>
                <strong className="font-medium">{e.actorName ?? "Automation"}</strong>{" "}
                {EVENT_LABELS[e.kind] ?? e.kind}
                {e.kind === "status_changed" && e.after?.status ? (
                  <> to {STATUS_LABELS[e.after.status as TicketStatus] ?? String(e.after.status)}</>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      </section>

      {busy && (
        <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
          Saving…
        </p>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-2xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function SlaSummary({ ticket }: { ticket: Ticket }) {
  const { sla } = ticket;
  if (!sla.firstResponseDueAt && !sla.resolutionDueAt) {
    return <p className="text-2xs text-muted-foreground">No commitment set for this priority.</p>;
  }
  return (
    <div className="flex flex-col gap-0.5 text-2xs">
      {sla.firstResponseDueAt && (
        <span className={cn(sla.firstResponseBreached && "text-destructive")}>
          First reply{" "}
          {sla.firstResponseAt ? (
            <>
              answered <LocalTime iso={sla.firstResponseAt} format="listTime" />
            </>
          ) : (
            <>
              due <LocalTime iso={sla.firstResponseDueAt} format="listTime" />
            </>
          )}
        </span>
      )}
      {sla.resolutionDueAt && (
        <span className={cn(sla.resolutionBreached && "text-destructive")}>
          Resolution due <LocalTime iso={sla.resolutionDueAt} format="listTime" />
        </span>
      )}
      {sla.paused && (
        <span className="flex items-center gap-1 text-muted-foreground">
          <Clock aria-hidden className="size-3" />
          Clock paused while this is parked
        </span>
      )}
    </div>
  );
}
