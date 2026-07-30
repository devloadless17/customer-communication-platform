"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  Clock,
  Loader2,
  MessageSquare,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
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

/** Resolve a team id from a snapshotted event to a readable name. */
function teamName(
  teams: Array<{ id: string; name: string }>,
  id: unknown,
): string {
  if (typeof id !== "string" || !id) return "no team";
  // A team can be archived or deleted after the handoff — the event keeps the
  // id, so say so plainly rather than rendering a raw cuid.
  return teams.find((t) => t.id === id)?.name ?? "a removed team";
}

const EVENT_LABELS: Record<string, string> = {
  created: "opened this ticket",
  assigned: "assigned it",
  unassigned: "unassigned it",
  status_changed: "changed the status",
  priority_changed: "changed the priority",
  subject_changed: "renamed it",
  description_changed: "edited the cause",
  tag_added: "added a tag",
  tag_removed: "removed a tag",
  field_changed: "edited a field",
  sla_breached: "missed the SLA",
  reopened: "reopened it",
  merged: "merged it",
  team_changed: "handed it to another team",
  note: "left a note",
  escalated: "escalated it to another workspace",
  escalation_received: "sent this escalation",
  escalation_note: "shared a comment",
  escalation_status: "changed their status",
  escalation_severed: "deleted the linked ticket",
};

/** A string field off an event's before/after JSON, or null. */
function eventStr(v: Record<string, unknown> | null | undefined, key: string): string | null {
  const val = v?.[key];
  return typeof val === "string" && val ? val : null;
}

export function TicketDetailClient({
  ticket: seed,
  events: seedEvents,
  users,
  tags,
  teams,
  escalationTargets,
  canDelete,
}: {
  ticket: Ticket;
  events: TicketEvent[];
  users: User[];
  tags: Tag[];
  /** Teams (AssignmentPolicy) this ticket can be handed to. */
  teams: Array<{ id: string; name: string; isDefault: boolean }>;
  /** Sibling workspaces this ticket can be escalated to. */
  escalationTargets: Array<{ id: string; name: string }>;
  /** Whether the viewer (admin/manager) may permanently delete this ticket. */
  canDelete: boolean;
}) {
  const router = useRouter();
  const [ticket, setTicket] = useState(seed);
  const [events, setEvents] = useState(seedEvents);
  const [busy, setBusy] = useState(false);
  const [subject, setSubject] = useState(seed.subject ?? "");
  // The cause — why this ticket exists. Seeded once and saved on blur when it
  // actually changed, same posture as the subject field above.
  const [description, setDescription] = useState(seed.description ?? "");
  // The handoff is a two-field action (team + why), so it gets a small inline
  // form rather than a bare <select>. The reason is the whole point: a handoff
  // without one makes the receiving team re-read the thread to work out what
  // was wanted.
  const [handoffTeamId, setHandoffTeamId] = useState<string>("");
  const [handoffReason, setHandoffReason] = useState("");
  const [note, setNote] = useState("");
  // The escalation form (workspace + why) mirrors the team-handoff form: the
  // cause is required — it is everything the receiving workspace gets.
  const [escTargetId, setEscTargetId] = useState<string>("");
  const [escCause, setEscCause] = useState("");
  const [escComment, setEscComment] = useState("");
  const { confirm, confirmDialog } = useConfirm();

  async function removeTicket() {
    const ok = await confirm({
      title: `Delete ticket #${ticket.number}?`,
      description:
        "This permanently removes the ticket and its timeline. The conversation and every message stay in the inbox — only this work item is deleted. This can't be undone.",
      confirmLabel: "Delete ticket",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await apiFetch(`/api/tickets/${ticket.id}`, { method: "DELETE" });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
        throw new Error(d.detail || d.error || "Couldn't delete this ticket");
      }
      toast.success(`Ticket #${ticket.number} deleted`);
      router.replace("/tickets");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't delete this ticket");
      setBusy(false);
    }
  }

  // Stable (the id never changes for a mounted detail page), so the socket
  // effect can call it without re-subscribing every render.
  const reload = useCallback(
    async (opts: { eventsOnly?: boolean } = {}) => {
      const res = await apiFetch(`/api/tickets/${seed.id}`);
      if (!res.ok) return;
      const body = (await res.json()) as { ticket: Ticket; events: TicketEvent[] };
      if (!opts.eventsOnly) setTicket(body.ticket);
      setEvents(body.events);
    },
    [seed.id],
  );

  // Filtered to THIS ticket: `ticket:changed` is workspace-scoped, so an
  // unfiltered handler would re-render the page on every ticket in the org.
  useEffect(() => {
    const socket = getClientSocket();
    const onTicket = (payload: { ticket: Ticket; action: string }) => {
      if (payload.ticket.id !== seed.id) return;
      // Deleted out from under the viewer (an admin removed it elsewhere) — this
      // page no longer has a ticket to show, so leave for the board.
      if (payload.action === "deleted") {
        toast.info("This ticket was deleted.");
        router.replace("/tickets");
        return;
      }
      if (payload.action === "escalated" || payload.action === "escalation_update") {
        // The other workspace commented / moved their status / severed the
        // link, or this side just escalated: the ticket's own `version` did
        // NOT move, but its escalation info and timeline did — take the frame
        // and refetch just the events.
        setTicket(payload.ticket);
        void reload({ eventsOnly: true });
        return;
      }
      setTicket((prev) => (prev.version === payload.ticket.version ? prev : payload.ticket));
    };
    socket.on("ticket:changed", onTicket);
    return () => {
      socket.off("ticket:changed", onTicket);
    };
  }, [seed.id, router, reload]);

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

  /**
   * Append an internal note. Its own endpoint, not a `patch` field: a note
   * changes nothing about the ticket, so it must not bump `version` (which
   * would 409 a colleague's open editor) or move the SLA clock. Only the
   * timeline is refetched.
   */
  const addNote = async (body: string) => {
    setBusy(true);
    try {
      const res = await apiFetch(`/api/tickets/${ticket.id}/notes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (res.ok) await reload({ eventsOnly: true });
    } finally {
      setBusy(false);
    }
  };

  /** Refer this ticket to a sibling workspace. The cause is required — it is
   *  everything the receiving side gets. */
  const escalate = async (targetWorkspaceId: string, cause: string) => {
    setBusy(true);
    try {
      const res = await apiFetch(`/api/tickets/${ticket.id}/escalate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetWorkspaceId, cause }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
        throw new Error(d.detail || d.error || "Couldn't escalate this ticket");
      }
      const data = (await res.json()) as { ticket: Ticket };
      setTicket(data.ticket);
      await reload({ eventsOnly: true });
      toast.success("Escalated — the other workspace now has it on their board");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't escalate this ticket");
      await reload();
    } finally {
      setBusy(false);
    }
  };

  /** A comment BOTH workspaces see — same non-update posture as a note. */
  const addEscalationComment = async (body: string) => {
    setBusy(true);
    try {
      const res = await apiFetch(`/api/tickets/${ticket.id}/escalation-comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
        throw new Error(d.detail || d.error || "Couldn't share the comment");
      }
      await reload({ eventsOnly: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't share the comment");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Jump to the OTHER side of the escalation pair. A ticket only exists inside
   * its own workspace, so this switches this DEVICE's active workspace first
   * and then hard-navigates to the twin (full navigation, never a soft route —
   * the socket must leave the old `ws:` room). Fails with a toast for agents
   * who have no seat in the other workspace.
   */
  const openTwin = async (workspaceId: string, ticketId: string) => {
    setBusy(true);
    try {
      const res = await apiFetch("/api/workspaces/active", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      if (!res.ok) {
        toast.error("You don't have access to that workspace — ask its admin for a seat.");
        setBusy(false);
        return;
      }
      window.location.assign(`/tickets/${ticketId}`);
    } catch {
      toast.error("Couldn't switch workspace. Please try again.");
      setBusy(false);
    }
  };

  /** Start OUR chat with the escalated customer and jump into it. */
  const messageCustomer = async () => {
    setBusy(true);
    try {
      const res = await apiFetch(`/api/tickets/${ticket.id}/escalation/message-customer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
        throw new Error(d.detail || d.error || "Couldn't start a chat with this customer");
      }
      const data = (await res.json()) as { conversationId: string };
      router.push(`/inbox?c=${data.conversationId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't start a chat with this customer");
      setBusy(false);
    }
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
            <Badge variant="destructive" className="gap-1 px-1.5 py-0 text-3xs">
              <AlertTriangle aria-hidden className="size-3" />
              {ticket.sla.firstResponseBreached ? "First reply overdue" : "Resolution overdue"}
            </Badge>
          )}
          {ticket.reopenCount > 0 && (
            <Badge variant="muted" className="px-1.5 py-0 text-3xs">
              Reopened {ticket.reopenCount}×
            </Badge>
          )}
          {canDelete && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void removeTicket()}
              className="ml-auto h-7 gap-1.5 px-2 text-2xs text-muted-foreground hover:text-destructive"
            >
              <Trash2 aria-hidden className="size-3.5" />
              Delete
            </Button>
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
          {/* An escalated-in ticket has no thread here until "Message customer"
              binds one — there is nothing to open yet. */}
          {ticket.conversationId ? (
            <>
              {" · "}
              <Link href={`/inbox?c=${ticket.conversationId}`} className="hover:underline">
                <MessageSquare aria-hidden className="mr-0.5 inline size-3" />
                Open the conversation
              </Link>
            </>
          ) : null}
        </p>

        {/* The cause. What a team receiving the handoff reads first — kept right
            under the title so it's the first thing on the ticket, not buried in
            the timeline. WRITTEN ONCE: once set it is the ticket's founding
            context and everything after it (comments, notes, status moves)
            reasons against it — updates travel as comments, never as a rewrite.
            Still fillable while empty. */}
        <div className="mt-3">
          <label
            htmlFor="ticket-cause"
            className="text-2xs font-medium uppercase tracking-wider text-muted-foreground"
          >
            Cause
          </label>
          {ticket.description ? (
            <>
              <p className="mt-1 w-full whitespace-pre-wrap rounded-md border bg-muted/30 px-2.5 py-1.5 text-xs leading-relaxed">
                {ticket.description}
              </p>
              <p className="mt-0.5 text-3xs text-muted-foreground">
                Set once, when the ticket was raised — add a note or a shared comment for
                anything new.
              </p>
            </>
          ) : (
            <textarea
              id="ticket-cause"
              value={description}
              disabled={busy}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() => {
                const next = description.trim();
                if (next === (ticket.description ?? "")) return;
                void patch({ description: next || null });
              }}
              rows={3}
              maxLength={5000}
              placeholder="Why does this need work? What should the team that picks it up know? Written once — it can't be edited later."
              className="mt-1 w-full resize-y rounded-md border bg-background px-2.5 py-1.5 text-xs leading-relaxed shadow-none focus-visible:border-input focus-visible:outline-none"
            />
          )}
        </div>
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

      {/* Hand this ticket to another team.
          A section rather than a field, because it is a two-part action: WHICH
          team, and WHY. The reason is what makes the difference between a
          handoff and just dropping work in someone else's queue. */}
      <section className="rounded-xl border bg-card p-4">
        <h2 className="mb-1 text-sm font-semibold">Team</h2>
        <p className="mb-3 text-2xs text-muted-foreground">
          {ticket.assignedTeamId
            ? `Owned by ${teams.find((t) => t.id === ticket.assignedTeamId)?.name ?? "a team that no longer exists"}. Hand it on, or clear it to take it out of every queue.`
            : "Not in any team's queue. Hand it to the team that should take it from here — they'll see it unclaimed in their board."}
        </p>

        {teams.length === 0 ? (
          <p className="text-2xs text-muted-foreground">
            No teams yet — create one in Settings → Teams &amp; routing, then you can
            hand tickets between them.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <select
              value={handoffTeamId}
              disabled={busy}
              onChange={(e) => setHandoffTeamId(e.target.value)}
              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
              aria-label="Team to hand this ticket to"
            >
              <option value="">Choose a team…</option>
              {teams
                .filter((t) => t.id !== ticket.assignedTeamId)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </select>

            <textarea
              value={handoffReason}
              disabled={busy}
              onChange={(e) => setHandoffReason(e.target.value)}
              rows={2}
              maxLength={2000}
              placeholder="Why are you handing this over? e.g. customer wants to upgrade their plan"
              className="w-full rounded-md border bg-background px-2 py-1.5 text-xs"
              aria-label="Reason for the handoff"
            />

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy || !handoffTeamId}
                onClick={() => {
                  const teamId = handoffTeamId;
                  const reason = handoffReason.trim();
                  setHandoffTeamId("");
                  setHandoffReason("");
                  void patch({
                    assignedTeamId: teamId,
                    ...(reason ? { handoffReason: reason } : {}),
                  });
                }}
                className="h-8 cursor-pointer rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                Hand over
              </button>
              {ticket.assignedTeamId && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void patch({ assignedTeamId: null })}
                  className="h-8 cursor-pointer rounded-md border px-3 text-xs disabled:opacity-50"
                >
                  Take out of the queue
                </button>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Cross-workspace escalation. One escalation per ticket lifetime; the
          pair shares comments and status changes through mirrored timeline
          rows — everything else stays inside each workspace. */}
      {ticket.escalation ? (
        <section className="rounded-xl border bg-card p-4">
          <h2 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
            <ArrowUpRight aria-hidden className="size-4" />
            {ticket.escalation.role === "source"
              ? `Escalated to ${ticket.escalation.otherWorkspaceName}`
              : `Escalated from ${ticket.escalation.otherWorkspaceName}`}
          </h2>
          <p className="mb-3 text-2xs text-muted-foreground">
            {ticket.escalation.severed ? (
              "The linked ticket was deleted — the history below is all that remains."
            ) : (
              <>
                Their ticket #{ticket.escalation.otherTicketNumber} ·{" "}
                {ticket.escalation.otherTicketStatus
                  ? STATUS_LABELS[ticket.escalation.otherTicketStatus]
                  : "unknown"}
                {ticket.escalation.role === "source"
                  ? " — one ticket, two workspaces: status and priority stay in sync, and their comments land in the history below. Relay answers to the customer here."
                  : " — one ticket, two workspaces: status and priority stay in sync. Answer with a shared comment, or start your own chat with the customer."}
              </>
            )}
          </p>

          {!ticket.escalation.severed && ticket.escalation.otherTicketId ? (
            <div className="mb-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  const esc = ticket.escalation;
                  if (esc?.otherTicketId) void openTwin(esc.otherWorkspaceId, esc.otherTicketId);
                }}
                className="h-8 gap-1.5 text-xs"
              >
                <ArrowUpRight aria-hidden className="size-3.5" />
                Open ticket #{ticket.escalation.otherTicketNumber} in{" "}
                {ticket.escalation.otherWorkspaceName}
              </Button>
              <p className="mt-1 text-3xs text-muted-foreground">
                Switches this tab to {ticket.escalation.otherWorkspaceName} — tickets never
                leave their workspace.
              </p>
            </div>
          ) : null}

          {/* The customer as the source workspace handed them over — a snapshot,
              not a live profile; edits over there don't change this. */}
          {ticket.escalation.role === "target" && ticket.escalation.contactSnapshot ? (
            <div className="mb-3 rounded-lg border bg-muted/30 p-3">
              <p className="mb-1.5 text-3xs font-medium uppercase tracking-wider text-muted-foreground">
                Customer snapshot (at escalation)
              </p>
              <dl className="grid gap-x-4 gap-y-1 text-2xs sm:grid-cols-2">
                {ticket.escalation.contactSnapshot.name && (
                  <SnapshotRow label="Name" value={ticket.escalation.contactSnapshot.name} />
                )}
                {ticket.escalation.contactSnapshot.phoneNumber && (
                  <SnapshotRow label="Phone" value={ticket.escalation.contactSnapshot.phoneNumber} />
                )}
                {ticket.escalation.contactSnapshot.email && (
                  <SnapshotRow label="Email" value={ticket.escalation.contactSnapshot.email} />
                )}
                <SnapshotRow
                  label="Channel"
                  value={ticket.escalation.contactSnapshot.identityChannel}
                />
                {Object.entries(ticket.escalation.contactSnapshot.customFields).map(([k, v]) => (
                  <SnapshotRow key={k} label={k} value={v} />
                ))}
              </dl>
              {!ticket.conversationId && ticket.escalation.contactSnapshot.phoneNumber ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => void messageCustomer()}
                  className="mt-2.5 h-8 gap-1.5 text-xs"
                >
                  <MessageSquare aria-hidden className="size-3.5" />
                  Message the customer
                </Button>
              ) : null}
              {!ticket.conversationId && !ticket.escalation.contactSnapshot.phoneNumber ? (
                <p className="mt-2 text-2xs text-muted-foreground">
                  No phone number on this channel identity — answer through the shared
                  comments and the source workspace will relay it.
                </p>
              ) : null}
            </div>
          ) : null}

          {!ticket.escalation.severed && (
            <div className="flex flex-col gap-2">
              <textarea
                value={escComment}
                disabled={busy}
                onChange={(e) => setEscComment(e.target.value)}
                rows={2}
                maxLength={5000}
                placeholder={
                  ticket.escalation.role === "source"
                    ? "Add context for the other workspace…"
                    : "e.g. Refund approved — tell them it lands in 3–5 business days."
                }
                className="w-full rounded-md border bg-background px-2 py-1.5 text-xs"
                aria-label="Shared escalation comment"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy || escComment.trim().length === 0}
                  onClick={() => {
                    const body = escComment.trim();
                    setEscComment("");
                    void addEscalationComment(body);
                  }}
                  className="h-8 cursor-pointer rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
                >
                  Share comment
                </button>
                <span className="text-3xs text-muted-foreground">
                  Visible to {ticket.escalation.otherWorkspaceName} — unlike an internal note.
                </span>
              </div>
            </div>
          )}
        </section>
      ) : escalationTargets.length > 0 ? (
        <section className="rounded-xl border bg-card p-4">
          <h2 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
            <ArrowUpRight aria-hidden className="size-4" />
            Escalate to another workspace
          </h2>
          <p className="mb-3 text-2xs text-muted-foreground">
            When nobody here can answer, refer this to another workspace in your
            organization. They get the customer's profile and your reason — never this
            inbox's messages — and can answer back here or contact the customer from
            their own channels.
          </p>
          <div className="flex flex-col gap-2">
            <select
              value={escTargetId}
              disabled={busy}
              onChange={(e) => setEscTargetId(e.target.value)}
              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
              aria-label="Workspace to escalate this ticket to"
            >
              <option value="">Choose a workspace…</option>
              {escalationTargets.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            <textarea
              value={escCause}
              disabled={busy}
              onChange={(e) => setEscCause(e.target.value)}
              rows={3}
              maxLength={5000}
              placeholder="Describe the issue for them — this is everything they'll see. e.g. Customer 123 was double-charged on invoice #88; needs a refund approval we can't give here."
              className="w-full rounded-md border bg-background px-2 py-1.5 text-xs"
              aria-label="Reason for the escalation"
            />
            <div>
              <button
                type="button"
                disabled={busy || !escTargetId || escCause.trim().length === 0}
                onClick={() => {
                  const target = escTargetId;
                  const cause = escCause.trim();
                  setEscTargetId("");
                  setEscCause("");
                  void escalate(target, cause);
                }}
                className="h-8 cursor-pointer rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                Escalate
              </button>
            </div>
          </div>
        </section>
      ) : null}

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
        <h2 className="mb-1 text-sm font-semibold">Internal note</h2>
        <p className="mb-2 text-2xs text-muted-foreground">
          Only your team sees this — the customer never does. Use it to answer a
          handoff without messaging them yourself.
        </p>
        <textarea
          value={note}
          disabled={busy}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          maxLength={5000}
          placeholder="e.g. Tell them their order ships Tuesday and we've waived the fee."
          className="w-full rounded-md border bg-background px-2 py-1.5 text-xs"
          aria-label="Internal note"
        />
        <button
          type="button"
          disabled={busy || note.trim().length === 0}
          onClick={() => {
            const body = note.trim();
            setNote("");
            void addNote(body);
          }}
          className="mt-2 h-8 cursor-pointer rounded-md border px-3 text-xs font-medium disabled:opacity-50"
        >
          Add note
        </button>
      </section>

      <section className="rounded-xl border bg-card p-4">
        <h2 className="mb-2 text-sm font-semibold">History</h2>
        <ol className="flex flex-col gap-2">
          {events.map((e) => (
            <li key={e.id} className="flex flex-wrap items-baseline gap-x-2 text-2xs">
              <span className="text-muted-foreground">
                <LocalTime iso={e.createdAt} format="listTime" />
              </span>
              <span>
                <strong className="font-medium">{e.actorName ?? "Automation"}</strong>{" "}
                {EVENT_LABELS[e.kind] ?? e.kind}
                {e.kind === "status_changed" && e.after?.status ? (
                  <> to {STATUS_LABELS[e.after.status as TicketStatus] ?? String(e.after.status)}</>
                ) : null}
                {e.kind === "team_changed" ? (
                  <>
                    {" "}
                    {teamName(teams, e.before?.teamId)} →{" "}
                    <strong className="font-medium">
                      {teamName(teams, e.after?.teamId)}
                    </strong>
                  </>
                ) : null}
                {/* Escalation rows carry snapshotted workspace names so they
                    keep reading correctly after a rename or a severed link. */}
                {e.kind === "escalated" && eventStr(e.after, "targetWorkspaceName") ? (
                  <>
                    {" "}
                    to <strong className="font-medium">{eventStr(e.after, "targetWorkspaceName")}</strong>
                    {typeof e.after?.targetTicketNumber === "number" ? (
                      <> (their #{e.after.targetTicketNumber})</>
                    ) : null}
                  </>
                ) : null}
                {e.kind === "escalation_received" && eventStr(e.after, "sourceWorkspaceName") ? (
                  <>
                    {" "}
                    from <strong className="font-medium">{eventStr(e.after, "sourceWorkspaceName")}</strong>
                  </>
                ) : null}
                {e.kind === "escalation_status" ? (
                  <>
                    {" "}
                    in <strong className="font-medium">{eventStr(e.after, "fromWorkspaceName") ?? "the other workspace"}</strong>
                    {eventStr(e.after, "status") ? (
                      <> to {STATUS_LABELS[e.after?.status as TicketStatus] ?? String(e.after?.status)}</>
                    ) : null}
                  </>
                ) : null}
                {e.kind === "escalation_severed" && typeof e.after?.deletedTicketNumber === "number" ? (
                  <> (their #{e.after.deletedTicketNumber})</>
                ) : null}
              </span>
              {/* "They solved it" is only half the answer — surface the outcome
                  the other side recorded. */}
              {e.kind === "escalation_status" && eventStr(e.after, "resolutionNote") ? (
                <p className="mt-0.5 basis-full whitespace-pre-wrap rounded-md border-l-2 border-primary/30 bg-muted/40 px-2 py-1 text-2xs text-foreground">
                  {eventStr(e.after, "resolutionNote")}
                </p>
              ) : null}
              {e.body ? (
                <p
                  className={cn(
                    "mt-0.5 basis-full whitespace-pre-wrap rounded-md border-l-2 px-2 py-1 text-2xs text-foreground",
                    e.kind === "escalation_note"
                      ? "border-primary bg-primary/5"
                      : "border-primary/30 bg-muted/40",
                  )}
                >
                  {e.kind === "escalation_note" && eventStr(e.after, "fromWorkspaceName") ? (
                    <span className="mb-0.5 block text-3xs font-medium uppercase tracking-wider text-muted-foreground">
                      Shared · from {eventStr(e.after, "fromWorkspaceName")}
                    </span>
                  ) : null}
                  {e.body}
                </p>
              ) : null}
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
      {confirmDialog}
    </div>
  );
}

function SnapshotRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      <dt className="shrink-0 font-medium capitalize text-muted-foreground">{label}</dt>
      <dd className="truncate">{value}</dd>
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
