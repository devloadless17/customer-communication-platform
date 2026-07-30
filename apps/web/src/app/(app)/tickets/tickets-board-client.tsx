"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowUpRight,
  Clock,
  Loader2,
  Search,
  Ticket as TicketIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layouts/page-header";
import { LocalTime } from "@/components/local-time";
import { ChannelBadge } from "@/features/inbox/components/channel-badge";
import { apiFetch } from "@/lib/api/client-fetch";
import { getClientSocket } from "@/lib/socket-client";
import { toast } from "@/lib/toast";
import { useNow } from "@/hooks/use-now";
import { cn } from "@ccp/shared/utils";
import { tagColorClasses } from "@ccp/shared/utils/tag-colors";
import type { Channel, User } from "@ccp/shared/types";
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type Ticket,
  type TicketCounts,
  type TicketPriority,
  type TicketStatus,
} from "@ccp/shared/tickets/types";

/**
 * The ticket board.
 *
 * Live-converged by the `ticket:changed` socket frame rather than polled: when
 * a teammate solves something, the card leaves everyone's board at once. The
 * frame carries the whole ticket, so a card already on screen is PATCHED in
 * place (no refetch, no scroll jump); only a change that could alter which
 * cards belong under the current filter triggers a reload — and that reload is
 * coalesced, because one person bulk-triaging fires a burst of frames.
 */

const STATUS_LABELS: Record<TicketStatus, string> = {
  new: "New",
  open: "Open",
  pending: "Waiting on customer",
  on_hold: "On hold",
  solved: "Solved",
  closed: "Closed",
};

/** Board columns. `closed` is deliberately absent — it's terminal history, and
 *  a permanently-growing sixth column would dominate the board. It stays
 *  reachable through the status filter. */
const BOARD_COLUMNS: TicketStatus[] = ["new", "open", "pending", "on_hold", "solved"];

const PRIORITY_CLASSES: Record<TicketPriority, string> = {
  low: "text-muted-foreground",
  normal: "text-foreground",
  high: "text-warning-fg",
  // text-danger-fg, not text-destructive: the latter is a button BACKGROUND
  // token and measured 3.88:1 as 11px text here (AA needs 4.5).
  urgent: "text-danger-fg",
};

export function TicketsBoardClient({
  users,
  teams,
}: {
  users: User[];
  /** Teams (AssignmentPolicy) — drives the queue filter. */
  teams: Array<{ id: string; name: string; isDefault: boolean }>;
}) {
  const params = useSearchParams();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [counts, setCounts] = useState<TicketCounts | null>(null);
  const [loading, setLoading] = useState(true);
  // Priority stays LOCAL (a quick narrowing you toggle while working a view);
  // the view itself is URL state, owned by the sidebar, so it is linkable and
  // survives a refresh.
  const [priority, setPriority] = useState<TicketPriority | null>(null);
  // The team QUEUE — "everything waiting on Sales". Local like priority: it is
  // a narrowing you toggle while working, not a view you link to. Orthogonal to
  // `assignee`, and both together is the query a team actually wants: in our
  // queue AND still unclaimed.
  const [teamFilter, setTeamFilter] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Search. `search` is what the user is typing; the query below picks up only
  // the DEBOUNCED value, so the board doesn't refetch per keystroke.
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  // Multi-select triage. A Set so the header shows a count and each card tests
  // membership in O(1).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const view = params.get("view");
  const statusParam = params.get("status") as TicketStatus | null;
  const assignee = view === "mine" ? "me" : view === "unassigned" ? "none" : null;
  const breachedOnly = view === "breached";
  // Work another department escalated to us — the guest side of a shared ticket.
  const sharedOnly = view === "shared";
  // A single-status view shows just that column; otherwise the whole board.
  const columns = useMemo(
    () => (statusParam && TICKET_STATUSES.includes(statusParam) ? [statusParam] : BOARD_COLUMNS),
    [statusParam],
  );

  // Guards a late response for a filter the user has since changed away from —
  // the classic out-of-order-fetch bug.
  const requestToken = useRef(0);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    // Default board excludes terminal work; a `?status=` view asks for exactly
    // that one, including `closed`.
    p.set("status", columns.join(","));
    if (assignee) p.set("assignee", assignee);
    if (teamFilter) p.set("team", teamFilter);
    if (priority) p.set("priority", priority);
    if (breachedOnly) p.set("breached", "true");
    if (sharedOnly) p.set("shared", "true");
    if (debouncedSearch) p.set("q", debouncedSearch);
    return p;
  }, [assignee, teamFilter, priority, breachedOnly, sharedOnly, debouncedSearch, columns]);

  const load = useCallback(async () => {
    const token = ++requestToken.current;
    setLoading(true);
    try {
      const res = await apiFetch(`/api/tickets?${query.toString()}`);
      if (!res.ok) throw new Error("Couldn't load tickets");
      const body = (await res.json()) as { tickets: Ticket[] };
      if (token !== requestToken.current) return;
      setTickets(body.tickets);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't load tickets");
    } finally {
      setLoading(false);
    }
  }, [query]);

  const loadCounts = useCallback(async () => {
    try {
      const res = await apiFetch("/api/tickets/counts");
      if (!res.ok) return;
      const body = (await res.json()) as { counts: TicketCounts };
      setCounts(body.counts);
    } catch {
      // Non-fatal: the header badges just keep their last value.
    }
  }, []);

  // 300ms: long enough that typing "refund" is one request, short enough that
  // the board feels like it is answering you.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void loadCounts();
  }, [loadCounts]);

  // Live convergence. Patch in place when we already hold the card — the frame
  // carries the whole ticket, so a refetch would cost a round-trip to arrive at
  // the state we were just handed. Only a NEW card (or one that may no longer
  // match the filter) needs a reload, and that reload is coalesced so a
  // teammate clearing twenty tickets doesn't fire twenty requests per open tab.
  useEffect(() => {
    const socket = getClientSocket();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleReload = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void load();
        void loadCounts();
      }, 400);
    };
    const onTicket = (payload: { ticket: Ticket; action: string }) => {
      // A deleted ticket leaves the board entirely — drop the card and refresh
      // the counts. No status re-check below; it's simply gone.
      if (payload.action === "deleted") {
        let held = false;
        setTickets((prev) => {
          if (!prev.some((t) => t.id === payload.ticket.id)) return prev;
          held = true;
          return prev.filter((t) => t.id !== payload.ticket.id);
        });
        if (held) void loadCounts();
        return;
      }
      let known = false;
      setTickets((prev) => {
        const idx = prev.findIndex((t) => t.id === payload.ticket.id);
        if (idx === -1) return prev;
        known = true;
        // Return the SAME array when nothing actually changed, so an
        // at-least-once redelivery doesn't re-render every card (§15).
        if (prev[idx]!.version === payload.ticket.version) return prev;
        const next = prev.slice();
        next[idx] = payload.ticket;
        return next;
      });
      // A card we don't hold, or one that just left the board's status set,
      // changes WHICH cards belong here — that needs the server's answer.
      if (!known || !columns.includes(payload.ticket.status)) scheduleReload();
      else void loadCounts();
    };
    socket.on("ticket:changed", onTicket);
    return () => {
      if (timer) clearTimeout(timer);
      socket.off("ticket:changed", onTicket);
    };
  }, [load, loadCounts, columns]);

  const move = async (ticket: Ticket, status: TicketStatus) => {
    setBusyId(ticket.id);
    try {
      const res = await apiFetch(`/api/tickets/${ticket.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, expectedVersion: ticket.version }),
      });
      if (res.status === 409) {
        // Someone else moved it first. Re-read rather than retrying blindly —
        // a blind retry is how one agent's "pending" silently overwrites
        // another's "solved".
        toast.error("Someone else just changed this ticket — refreshing");
        await load();
        return;
      }
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
        throw new Error(d.detail || d.error || "Couldn't update this ticket");
      }
      // The card updates through the socket frame above, so there's no
      // optimistic splice to reconcile.
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update this ticket");
    } finally {
      setBusyId(null);
    }
  };

  const byStatus = useMemo(() => {
    const map = new Map<TicketStatus, Ticket[]>();
    for (const s of columns) map.set(s, []);
    for (const t of tickets) map.get(t.status)?.push(t);
    return map;
  }, [tickets, columns]);

  /**
   * Apply one change to every SELECTED ticket.
   *
   * Sequential, not `Promise.all`: each PATCH carries its own `expectedVersion`
   * and the socket frames come back per ticket, so firing 40 at once buries the
   * API in a burst for no wall-clock win a triager would notice — and a partial
   * failure stays legible ("12 of 15 updated") instead of interleaving.
   */
  const bulkApply = async (body: Record<string, unknown>, label: string) => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkBusy(true);
    let done = 0;
    let conflicted = 0;
    try {
      for (const id of ids) {
        const t = tickets.find((x) => x.id === id);
        if (!t) continue;
        const res = await apiFetch(`/api/tickets/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          // Version-pinned like every other write: a stale card in a bulk
          // selection must not silently overwrite a colleague's change.
          body: JSON.stringify({ ...body, expectedVersion: t.version }),
        });
        if (res.ok) done += 1;
        else if (res.status === 409) conflicted += 1;
      }
      if (conflicted > 0) {
        toast.error(
          `${label}: ${done} updated, ${conflicted} changed by someone else — refreshing`,
        );
      } else if (done > 0) {
        toast.success(`${label}: ${done} ticket${done === 1 ? "" : "s"} updated`);
      }
      setSelected(new Set());
      await load();
      await loadCounts();
    } finally {
      setBulkBusy(false);
    }
  };

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** A card dropped on a column — same path as the quick-action buttons, so
   *  the CAS/409 handling and the socket-frame reconciliation are identical. */
  const dropTicket = (ticketId: string, status: TicketStatus) => {
    const t = tickets.find((x) => x.id === ticketId);
    if (!t || t.status === status) return;
    void move(t, status);
  };

  return (
    <div className="flex h-full min-h-0 flex-col px-4 py-6 sm:px-6 md:px-8">
      <PageHeader
        title="Tickets"
        description={
          counts
            ? `${counts.totalActive} open · ${counts.mineActive} assigned to you${
                counts.breached ? ` · ${counts.breached} past due` : ""
              }`
            : "Work items across every conversation"
        }
      />

      {/* Search. A board past a few hundred tickets is unnavigable by filters
          alone — "#47" and "the refund thing" are how people actually look. */}
      <div className="mb-3 flex items-center gap-2">
        <div className="relative w-full max-w-sm">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search #number, subject, cause, customer or comments…"
            aria-label="Search tickets"
            className="h-9 w-full rounded-md border bg-background pl-8 pr-2 text-xs"
          />
        </div>
        {debouncedSearch ? (
          <button
            type="button"
            onClick={() => setSearch("")}
            className="cursor-pointer text-2xs text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        ) : null}
      </div>

      {/* Bulk triage. Appears only with a selection — an always-present toolbar
          on a board nobody has selected in is chrome. */}
      {selected.size > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2">
          <span className="text-2xs font-medium">
            {selected.size} selected
          </span>
          <select
            value=""
            disabled={bulkBusy}
            onChange={(e) => {
              const v = e.target.value as TicketStatus | "";
              if (v) void bulkApply({ status: v }, "Status");
            }}
            className="h-8 rounded-md border bg-background px-2 text-xs"
            aria-label="Set status for selected tickets"
          >
            <option value="">Set status…</option>
            {TICKET_STATUSES.map((st) => (
              <option key={st} value={st}>
                {STATUS_LABELS[st]}
              </option>
            ))}
          </select>
          <select
            value=""
            disabled={bulkBusy}
            onChange={(e) => {
              const v = e.target.value as TicketPriority | "";
              if (v) void bulkApply({ priority: v }, "Priority");
            }}
            className="h-8 rounded-md border bg-background px-2 text-xs capitalize"
            aria-label="Set priority for selected tickets"
          >
            <option value="">Set priority…</option>
            {TICKET_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <select
            value=""
            disabled={bulkBusy}
            onChange={(e) => {
              const v = e.target.value;
              if (v) void bulkApply({ assignedUserId: v === "none" ? null : v }, "Assignee");
            }}
            className="h-8 rounded-md border bg-background px-2 text-xs"
            aria-label="Assign selected tickets"
          >
            <option value="">Assign to…</option>
            <option value="none">Unassigned</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          {teams.length > 0 && (
            <select
              value=""
              disabled={bulkBusy}
              onChange={(e) => {
                const v = e.target.value;
                if (v) void bulkApply({ assignedTeamId: v === "none" ? null : v }, "Team");
              }}
              className="h-8 rounded-md border bg-background px-2 text-xs"
              aria-label="Hand selected tickets to a team"
            >
              <option value="">Hand to team…</option>
              <option value="none">No team</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            disabled={bulkBusy}
            onClick={() => setSelected(new Set())}
            className="ml-auto cursor-pointer text-2xs text-muted-foreground hover:text-foreground"
          >
            Clear selection
          </button>
          {bulkBusy && <Loader2 aria-hidden className="size-3.5 animate-spin" />}
        </div>
      ) : null}

      {/* Only PRIORITY lives here now. Mine / Unassigned / Past due moved to the
          sidebar, where they are linkable URL views — keeping duplicates here
          would have given the same view two sources of truth. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-2xs text-muted-foreground">Priority</span>
        {TICKET_PRIORITIES.map((p) => (
          <FilterChip
            key={p}
            active={priority === p}
            onClick={() => setPriority(priority === p ? null : p)}
          >
            <span className={cn("capitalize", PRIORITY_CLASSES[p])}>{p}</span>
          </FilterChip>
        ))}

        {/* Team QUEUE. Rendered only when the workspace actually has teams —
            a one-entry filter is clutter, same rule as the inbox account
            picker. Composes with the sidebar's Mine/Unassigned view rather
            than replacing it: "Sales' queue AND unclaimed" is the query a team
            uses to find work handed to them. */}
        {teams.length > 0 && (
          <>
            <span className="ml-2 text-2xs text-muted-foreground">Team</span>
            {teams.map((t) => (
              <FilterChip
                key={t.id}
                active={teamFilter === t.id}
                onClick={() => setTeamFilter(teamFilter === t.id ? null : t.id)}
              >
                {t.name}
              </FilterChip>
            ))}
            <FilterChip
              active={teamFilter === "none"}
              onClick={() => setTeamFilter(teamFilter === "none" ? null : "none")}
            >
              No team
            </FilterChip>
          </>
        )}
      </div>

      {loading && tickets.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Loader2 aria-hidden className="size-5 animate-spin" />
        </div>
      ) : tickets.length === 0 ? (
        <EmptyBoard />
      ) : (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
          {columns.map((status) => (
            <Column
              key={status}
              status={status}
              tickets={byStatus.get(status) ?? []}
              busyId={busyId}
              users={users}
              onMove={move}
              onDropTicket={dropTicket}
              selected={selected}
              onToggleSelected={toggleSelected}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-1 text-2xs transition-colors",
        active
          ? "border-primary/40 bg-primary/10 text-foreground"
          : "text-muted-foreground hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}

function EmptyBoard() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      <TicketIcon aria-hidden className="size-8 text-muted-foreground/50" />
      <p className="text-sm font-medium">No open tickets</p>
      <p className="max-w-sm text-2xs text-muted-foreground">
        Tickets are raised deliberately — from a conversation&rsquo;s &ldquo;Raise a
        ticket&rdquo; button, a workflow, or an escalation from another workspace. Nothing
        here means every raised issue is settled — or your filters are hiding the rest.
      </p>
    </div>
  );
}

/** The dataTransfer key a dragged ticket card travels under. */
const DND_MIME = "application/x-ccp-ticket";

function Column({
  status,
  tickets,
  busyId,
  users,
  onMove,
  onDropTicket,
  selected,
  onToggleSelected,
}: {
  status: TicketStatus;
  tickets: Ticket[];
  busyId: string | null;
  users: User[];
  onMove: (ticket: Ticket, status: TicketStatus) => void;
  onDropTicket: (ticketId: string, status: TicketStatus) => void;
  selected: Set<string>;
  onToggleSelected: (id: string) => void;
}) {
  // Plain HTML5 drag-and-drop — no library (per the no-heavy-deps rule); a
  // depth counter because dragenter/leave fire for every child the cursor
  // crosses, and a naive boolean flickers the highlight off mid-column.
  const [dragDepth, setDragDepth] = useState(0);
  const isOver = dragDepth > 0;
  return (
    <section
      className={cn(
        "flex w-72 shrink-0 flex-col rounded-xl bg-muted/40 transition-colors",
        isOver && "bg-primary/5 ring-1 ring-inset ring-primary/30",
      )}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes(DND_MIME)) return;
        setDragDepth((d) => d + 1);
      }}
      onDragLeave={(e) => {
        if (!e.dataTransfer.types.includes(DND_MIME)) return;
        setDragDepth((d) => Math.max(0, d - 1));
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DND_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(DND_MIME);
        setDragDepth(0);
        if (!id) return;
        e.preventDefault();
        onDropTicket(id, status);
      }}
    >
      <header className="flex items-center justify-between px-3 py-2">
        <h2 className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          {STATUS_LABELS[status]}
        </h2>
        <span className="text-2xs tabular-nums text-muted-foreground">{tickets.length}</span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {tickets.map((t) => (
          <Card
            key={t.id}
            ticket={t}
            busy={busyId === t.id}
            users={users}
            onMove={onMove}
            selected={selected.has(t.id)}
            onToggleSelected={onToggleSelected}
          />
        ))}
        {/* An empty column still needs a drop surface taller than its header. */}
        {tickets.length === 0 && <div className="min-h-24 flex-1" aria-hidden />}
      </div>
    </section>
  );
}

function Card({
  ticket,
  busy,
  users,
  onMove,
  selected,
  onToggleSelected,
}: {
  ticket: Ticket;
  busy: boolean;
  users: User[];
  onMove: (ticket: Ticket, status: TicketStatus) => void;
  selected: boolean;
  onToggleSelected: (id: string) => void;
}) {
  const assignee = users.find((u) => u.id === ticket.assignedUserId);
  const [dragging, setDragging] = useState(false);
  return (
    <article
      draggable={!busy}
      onDragStart={(e) => {
        e.dataTransfer.setData(DND_MIME, ticket.id);
        e.dataTransfer.effectAllowed = "move";
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
      className={cn(
        "rounded-lg border bg-card p-2.5 shadow-xs transition-opacity",
        !busy && "cursor-grab active:cursor-grabbing",
        dragging && "opacity-40",
        selected && "border-primary ring-1 ring-inset ring-primary/40",
      )}
    >
      <div className="mb-1 flex items-center gap-1.5">
        {/* Bulk-select. Stops propagation so ticking a card can never start a
            drag or follow the title link. */}
        <input
          type="checkbox"
          checked={selected}
          disabled={busy}
          onClick={(e) => e.stopPropagation()}
          onChange={() => onToggleSelected(ticket.id)}
          aria-label={`Select ticket #${ticket.number}`}
          className="size-3 cursor-pointer"
        />
        <span className="text-3xs tabular-nums text-muted-foreground">#{ticket.number}</span>
        <ChannelBadge channel={ticket.channel as Channel} />
        <span className={cn("ml-auto text-3xs capitalize", PRIORITY_CLASSES[ticket.priority])}>
          {ticket.priority}
        </span>
      </div>

      <Link
        href={`/tickets/${ticket.id}`}
        className="block text-sm font-medium leading-snug hover:underline"
      >
        {ticket.subject ?? `${ticket.contactName}'s request`}
      </Link>
      <p className="mt-0.5 truncate text-2xs text-muted-foreground">
        {ticket.contactName}
        {/* One glance tells the triager this card is shared with another
            department — and, when it isn't ours, whose customer it is. */}
        {ticket.sharing ? (
          <span className="ml-1.5 inline-flex items-center gap-0.5 rounded bg-primary/10 px-1 py-px text-3xs font-medium text-primary">
            <ArrowUpRight aria-hidden className="size-2.5" />
            {ticket.sharing.role === "guest"
              ? `From ${ticket.sharing.ownerWorkspaceName}`
              : `Shared · ${ticket.sharing.guests.length}`}
          </span>
        ) : null}
      </p>

      {ticket.tags.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {ticket.tags.map((tag) => (
            <span
              key={tag.id}
              className={cn(
                "rounded px-1.5 py-px text-3xs",
                tagColorClasses(tag.color),
              )}
            >
              {tag.name}
            </span>
          ))}
        </div>
      )}

      <SlaLine ticket={ticket} />

      <div className="mt-2 flex items-center gap-1.5">
        <span className="truncate text-3xs text-muted-foreground">
          {assignee?.name ?? ticket.assignedUserName ?? "Unassigned"}
        </span>
        {busy ? (
          <Loader2 aria-hidden className="ml-auto size-3.5 shrink-0 animate-spin" />
        ) : (
          <div className="ml-auto flex gap-1">
            {nextSteps(ticket.status).map((next) => (
              <Button
                key={next}
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 text-3xs"
                onClick={() => onMove(ticket, next)}
              >
                {STATUS_LABELS[next]}
              </Button>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

/**
 * The one or two moves that make sense from here, rather than a full status
 * picker on every card. A board is for moving work along; the detail page is
 * where any state is reachable.
 */
function nextSteps(status: TicketStatus): TicketStatus[] {
  switch (status) {
    case "new":
      return ["open"];
    case "open":
      return ["pending", "solved"];
    case "pending":
    case "on_hold":
      return ["open", "solved"];
    case "solved":
      return ["closed"];
    default:
      return [];
  }
}

/**
 * The SLA line: a countdown while a promise is live, a breach badge once it's
 * missed, nothing at all when no promise was made.
 *
 * `useNow()` (the shared 60s tick) drives the countdown so the whole app agrees
 * on "now" and absolute timestamps elsewhere don't re-render every minute —
 * CLAUDE.md §14.
 */
function SlaLine({ ticket }: { ticket: Ticket }) {
  const now = useNow();
  const { sla } = ticket;
  const breached = sla.firstResponseBreached || sla.resolutionBreached;

  if (breached) {
    return (
      <Badge variant="destructive" className="mt-1.5 gap-1 px-1.5 py-0 text-3xs">
        <AlertTriangle aria-hidden className="size-3" />
        {sla.firstResponseBreached ? "First reply overdue" : "Resolution overdue"}
      </Badge>
    );
  }

  // The first-response leg is the one an agent can still act on; once it's
  // answered the resolution clock is what's left.
  const dueIso = sla.firstResponseAt ? sla.resolutionDueAt : sla.firstResponseDueAt;
  if (!dueIso) return null;

  const due = new Date(dueIso).getTime();
  const mins = Math.round((due - now) / 60_000);
  return (
    <p
      className={cn(
        "mt-1.5 flex items-center gap-1 text-3xs",
        sla.paused
          ? "text-muted-foreground"
          : mins <= 30
            ? "text-warning-fg"
            : "text-muted-foreground",
      )}
    >
      <Clock aria-hidden className="size-3" />
      {sla.paused ? (
        // A paused clock shows the deadline, not a countdown — counting down to
        // a time that isn't advancing would be a lie.
        <>
          Paused · due <LocalTime iso={dueIso} format="listTime" />
        </>
      ) : mins >= 60 ? (
        <>
          Due <LocalTime iso={dueIso} format="listTime" />
        </>
      ) : (
        <>{mins > 0 ? `Due in ${mins} min` : "Due now"}</>
      )}
    </p>
  );
}

export { STATUS_LABELS, TICKET_STATUSES };
