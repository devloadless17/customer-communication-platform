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
  Lock,
  MessageSquare,
  MessagesSquare,
  Paperclip,
  Trash2,
  Users,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { LocalTime } from "@/components/local-time";
import { ChannelBadge } from "@/features/inbox/components/channel-badge";
import { apiFetch } from "@/lib/api/client-fetch";
import { dispatchLocalSocketEvent, getClientSocket } from "@/lib/socket-client";
import { toast } from "@/lib/toast";
import { cn } from "@ccp/shared/utils";
import { tagColorClasses } from "@ccp/shared/utils/tag-colors";
import type { Channel, Tag, User } from "@ccp/shared/types";
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type Ticket,
  type TicketAttachment,
  type TicketEvent,
  type TicketPriority,
  type TicketStatus,
  type TicketThreadMessage,
} from "@ccp/shared/tickets/types";

import { TicketAttachmentRow } from "./ticket-attachment-row";
import { TicketThread } from "./ticket-thread";
import { TicketThreadComposer } from "./ticket-thread-composer";

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
  escalated: "gave another workspace access",
  escalation_revoked: "removed a workspace's access",
  // RETIRED 2026-07-31 — comments became TicketMessage rows and are excluded
  // from the log. Kept for pre-migration rows nothing rewrites.
  escalation_note: "commented",
  attachment_added: "attached a file",
  attachment_removed: "removed a file",
  // Retired with the twin-pair design (2026-07-30) — old rows still render.
  escalation_received: "received this escalation",
  escalation_status: "changed the status in the other workspace",
  escalation_severed: "the linked ticket was deleted",
};

/** A ticket-level file: one that isn't already rendering inside a thread
 *  message or a migrated log entry, where it would show twice. */
const isTicketLevel = (a: TicketAttachment) => !a.eventId && !a.messageId;

/** A string field off an event's before/after JSON, or null. */
function eventStr(v: Record<string, unknown> | null | undefined, key: string): string | null {
  const val = v?.[key];
  return typeof val === "string" && val ? val : null;
}

export function TicketDetailClient({
  ticket: seed,
  events: seedEvents,
  thread: seedThread,
  notes: seedNotes,
  threadUnreadSinceMessageId: seedUnread,
  viewerUserId,
  viewerWorkspaceId,
  users,
  tags,
  teams,
  escalationTargets,
  canDelete,
}: {
  ticket: Ticket;
  events: TicketEvent[];
  /** The cross-department conversation, oldest first. */
  thread: TicketThreadMessage[];
  /** THIS workspace's private notes. Another department's never arrive here —
   *  the API scopes them to the workspace that wrote them. */
  notes: TicketEvent[];
  /** Where this reader's "New replies" divider goes, or null. */
  threadUnreadSinceMessageId: string | null;
  viewerUserId: string;
  /** The workspace being VIEWED from — a guest department reads the same
   *  ticket from its own side, so this is not `ticket.sharing.ownerWorkspaceId`. */
  viewerWorkspaceId: string;
  users: User[];
  tags: Tag[];
  /** Teams (Team) this ticket can be handed to. */
  teams: Array<{ id: string; name: string; isDefault: boolean }>;
  /** Sibling workspaces this ticket can be escalated to. */
  escalationTargets: Array<{ id: string; name: string }>;
  /** Whether the viewer (admin/manager) may permanently delete this ticket. */
  canDelete: boolean;
}) {
  const router = useRouter();
  const [ticket, setTicket] = useState(seed);
  const [events, setEvents] = useState(seedEvents);
  const [thread, setThread] = useState(seedThread);
  const [notes, setNotes] = useState(seedNotes);
  // Frozen at mount: the divider must stay put while you read the messages
  // under it, so the server's clear (below) must not make it jump away.
  const [unreadAnchor] = useState(seedUnread);
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
  // Files picked for the next comment, and for direct ticket attachment.
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
      const body = (await res.json()) as {
        ticket: Ticket;
        events: TicketEvent[];
        thread: TicketThreadMessage[];
        notes: TicketEvent[];
      };
      if (!opts.eventsOnly) setTicket(body.ticket);
      setEvents(body.events);
      // The thread rides every reload: an optimistic row that lost its response
      // is reconciled here rather than left pending forever.
      setThread(body.thread);
      setNotes(body.notes);
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

  /**
   * Live replies, and clearing this reader's unread marker.
   *
   * Marking read is gated on the tab actually being VISIBLE (§10): a reply that
   * arrives while this page sits in a background tab must not clear a badge for
   * something nobody looked at. So: on mount, whenever the tab becomes visible,
   * and on each arriving reply while visible.
   */
  useEffect(() => {
    const socket = getClientSocket();
    let cleared = false;

    const markRead = async () => {
      if (document.visibilityState !== "visible") return;
      // Nothing to clear until a reply we haven't read exists — a POST per
      // visibility flip on a quiet ticket is pure noise.
      if (cleared) return;
      cleared = true;
      await apiFetch(`/api/tickets/${seed.id}/thread/read`, { method: "POST" }).catch(
        () => undefined,
      );
      // Dispatched at ourselves so the rail badge and the board drop it now.
      // The server never emits this frame: read state is per-user, and one
      // reader's clear is nobody else's business.
      dispatchLocalSocketEvent("ticket:thread:read", {
        workspaceId: viewerWorkspaceId,
        ticketId: seed.id,
        readByUserId: viewerUserId,
      });
    };

    const onMessage = (payload: {
      ticketId: string;
      message: TicketThreadMessage;
      clientTempId?: string;
    }) => {
      if (payload.ticketId !== seed.id) return;
      setThread((prev) => {
        // Already here — our own POST response beat the frame, or the frame
        // arrived twice. Either way the id is the identity.
        if (prev.some((m) => m.id === payload.message.id)) return prev;
        const without = payload.clientTempId
          ? prev.filter((m) => m.clientTempId !== payload.clientTempId)
          : prev;
        return [...without, payload.message];
      });
      // Reading it as it lands is exactly the case the marker exists for.
      cleared = false;
      void markRead();
    };

    const onVisible = () => void markRead();
    socket.on("ticket:thread:message", onMessage);
    document.addEventListener("visibilitychange", onVisible);
    if (seedUnread) void markRead();
    return () => {
      socket.off("ticket:thread:message", onMessage);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [seed.id, viewerWorkspaceId, seedUnread, viewerUserId]);

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
      toast.success("Escalated — that workspace now has this ticket on their board");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't escalate this ticket");
      await reload();
    } finally {
      setBusy(false);
    }
  };

  /**
   * Post to the ticket's THREAD — the conversation every workspace on the
   * ticket reads. Optimistic: the row lands immediately under a `clientTempId`
   * and is swapped for the server's, which is what makes a retry safe (the
   * same token twice returns the message that already landed instead of
   * posting a second one).
   *
   * Deliberately NOT `setBusy` — busy disables the whole page, and a reply
   * changes nothing about the work. Sent as multipart so it can carry evidence.
   */
  const postThreadMessage = useCallback(
    async (body: string, files: File[], reuseTempId?: string) => {
      const clientTempId = reuseTempId ?? `tmp_${Math.random().toString(36).slice(2)}_${Date.now()}`;
      const optimistic: TicketThreadMessage = {
        id: clientTempId,
        body,
        authorUserId: viewerUserId,
        authorName: null,
        authorAvatarUrl: null,
        authorWorkspaceId: null,
        authorWorkspaceName: null,
        attachments: [],
        createdAt: new Date().toISOString(),
        clientTempId,
        pending: true,
      };
      setThread((prev) => [
        // A retry re-sends an existing failed row rather than adding a twin.
        ...prev.filter((m) => m.clientTempId !== clientTempId),
        optimistic,
      ]);
      try {
        const form = new FormData();
        form.append("body", body);
        form.append("clientTempId", clientTempId);
        for (const f of files) form.append("files", f);
        // No content-type header: the browser must set the multipart boundary.
        const res = await apiFetch(`/api/tickets/${seed.id}/thread`, { method: "POST", body: form });
        if (!res.ok) throw new Error("send failed");
        const data = (await res.json()) as { message: TicketThreadMessage };
        setThread((prev) => {
          // The realtime frame can beat this response back — dedupe on the id
          // rather than blindly swapping, or the reply renders twice.
          const without = prev.filter(
            (m) => m.clientTempId !== clientTempId && m.id !== data.message.id,
          );
          return [...without, data.message];
        });
      } catch {
        setThread((prev) =>
          prev.map((m) =>
            m.clientTempId === clientTempId ? { ...m, pending: false, failed: true } : m,
          ),
        );
        toast.error("Couldn't send that — tap Retry");
      }
    },
    [seed.id, viewerUserId],
  );

  /** Attach files to the ticket itself (no comment). */
  const attachFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setBusy(true);
    try {
      const form = new FormData();
      for (const f of files) form.append("files", f);
      const res = await apiFetch(`/api/tickets/${ticket.id}/attachments`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
        throw new Error(d.detail || d.error || "Couldn't attach the files");
      }
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't attach the files");
    } finally {
      setBusy(false);
    }
  };

  const removeAttachment = async (attachmentId: string) => {
    setBusy(true);
    try {
      const res = await apiFetch(`/api/tickets/${ticket.id}/attachments/${attachmentId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
        throw new Error(d.detail || d.error || "Couldn't remove the file");
      }
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove the file");
    } finally {
      setBusy(false);
    }
  };

  /** Hand a workspace's access back. */
  const revokeShare = async (guestWorkspaceId: string, name: string) => {
    const ok = await confirm({
      title: `Remove ${name}'s access?`,
      description:
        "They'll lose this ticket from their board. The history of what they did stays on it, and you can escalate to them again later.",
      confirmLabel: "Remove access",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await apiFetch(`/api/tickets/${ticket.id}/shares/${guestWorkspaceId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
        throw new Error(d.detail || d.error || "Couldn't remove access");
      }
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove access");
    } finally {
      setBusy(false);
    }
  };

  /** Start THIS workspace's own chat with the customer, and jump into it. */
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

  /** Who reads the thread. Empty on an unshared ticket — nobody outside this
   *  workspace has access, so promising an audience would be a lie. */
  const threadAudience = ticket.sharing
    ? ticket.sharing.role === "owner"
      ? ticket.sharing.guests.map((g) => g.workspaceName).join(", ")
      : ticket.sharing.ownerWorkspaceName
    : "";

  return (
    // Two tracks on desktop: the WORK (fields, handoffs, escalation, notes)
    // on the left, the HISTORY as a sticky rail on the right — the log reads
    // alongside the thing it describes instead of a mile below it. Stacks
    // back to one column under lg.
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
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

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        {/* THE THREAD — the main pane. This is where the departments working
            this ticket talk to each other; the log is a secondary at the
            bottom of the rail, because "who changed what" is a different
            question from "what did Billing say". */}
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <section className="flex min-h-0 flex-col rounded-xl border bg-card p-4">
            <div className="mb-2 flex items-baseline gap-2">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold">
                <MessagesSquare aria-hidden className="size-4" />
                Thread
              </h2>
              <p className="text-2xs text-muted-foreground">
                {ticket.sharing
                  ? "Everyone working this ticket sees these — the customer never does."
                  : "Internal discussion on this ticket. The customer never sees it."}
              </p>
            </div>
            <div className="min-h-0 flex-1 lg:max-h-[calc(100dvh-24rem)] lg:overflow-y-auto">
              <TicketThread
                messages={thread}
                busy={busy}
                unreadSinceMessageId={unreadAnchor}
                audience={threadAudience}
                onRetry={(m) => void postThreadMessage(m.body, [], m.clientTempId)}
              />
            </div>
          </section>
          <TicketThreadComposer
            busy={busy}
            audience={threadAudience}
            onSubmit={(body, files) => void postThreadMessage(body, files)}
          />
        </div>

        {/* The WORK: everything you decide about this ticket, plus the log. */}
        <aside className="flex w-full shrink-0 flex-col gap-4 lg:w-96">

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

      {/* Cross-workspace sharing. ONE ticket, several departments: escalating
          grants a sibling workspace access to THIS ticket — nothing is copied,
          so every change either side makes is the change, and the log says who
          made it. */}
      {ticket.sharing ? (
        <section className="rounded-xl border bg-card p-4">
          <h2 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
            <Users aria-hidden className="size-4" />
            Shared ticket
          </h2>
          <p className="mb-3 text-2xs leading-relaxed text-muted-foreground">
            {ticket.sharing.role === "owner"
              ? "This ticket is yours and is shared with the workspaces below. They see the same status, priority, history and files — anything they change here is the change."
              : `${ticket.sharing.ownerWorkspaceName} escalated this to you. You're working the same ticket they are: your changes, comments and files are theirs too. Their inbox conversation stays private.`}
          </p>

          {/* The participant list. Not a secret from the participants. */}
          <ul className="mb-3 flex flex-col gap-1.5">
            <li className="flex items-center gap-2 text-2xs">
              <span className="rounded bg-muted px-1.5 py-0.5 font-medium">
                {ticket.sharing.ownerWorkspaceName}
              </span>
              <span className="text-muted-foreground">raised it</span>
            </li>
            {ticket.sharing.guests.map((g) => (
              <li key={g.workspaceId} className="flex items-center gap-2 text-2xs">
                <span className="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary">
                  {g.workspaceName}
                </span>
                <span className="text-muted-foreground">
                  added <LocalTime iso={g.sharedAt} format="listTime" />
                </span>
                {/* The owner may remove anyone; a guest may only remove itself. */}
                {ticket.sharing?.role === "owner" || g.workspaceId === ticket.sharing?.ownerWorkspaceId ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void revokeShare(g.workspaceId, g.workspaceName)}
                    className="ml-auto cursor-pointer text-3xs text-muted-foreground underline-offset-2 hover:text-destructive hover:underline disabled:opacity-50"
                  >
                    Remove access
                  </button>
                ) : null}
              </li>
            ))}
          </ul>

          {/* The customer as the owner handed them over — a snapshot, not a live
              profile; edits over there don't change this. */}
          {ticket.sharing.contactSnapshot ? (
            <div className="mb-3 rounded-lg border bg-muted/30 p-3">
              <p className="mb-1.5 text-3xs font-medium uppercase tracking-wider text-muted-foreground">
                Customer details (as shared with you)
              </p>
              <dl className="grid gap-x-4 gap-y-1 text-2xs sm:grid-cols-2">
                {ticket.sharing.contactSnapshot.name && (
                  <SnapshotRow label="Name" value={ticket.sharing.contactSnapshot.name} />
                )}
                {ticket.sharing.contactSnapshot.phoneNumber && (
                  <SnapshotRow label="Phone" value={ticket.sharing.contactSnapshot.phoneNumber} />
                )}
                {ticket.sharing.contactSnapshot.email && (
                  <SnapshotRow label="Email" value={ticket.sharing.contactSnapshot.email} />
                )}
                <SnapshotRow
                  label="Channel"
                  value={ticket.sharing.contactSnapshot.identityChannel}
                />
                {Object.entries(ticket.sharing.contactSnapshot.customFields).map(([k, v]) => (
                  <SnapshotRow key={k} label={k} value={v} />
                ))}
              </dl>
              {!ticket.conversationId && ticket.sharing.contactSnapshot.phoneNumber ? (
                <>
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
                  <p className="mt-1 text-3xs text-muted-foreground">
                    Starts your own conversation with them, from your own number.
                  </p>
                </>
              ) : null}
              {!ticket.conversationId && !ticket.sharing.contactSnapshot.phoneNumber ? (
                <p className="mt-2 text-2xs text-muted-foreground">
                  No phone number on this channel identity — reply with a comment and{" "}
                  {ticket.sharing.ownerWorkspaceName} will relay it.
                </p>
              ) : null}
            </div>
          ) : null}

          {/* Escalate onward: any participant may loop in another department. */}
          {escalationTargets.filter(
            (w) =>
              w.id !== ticket.sharing?.ownerWorkspaceId &&
              !ticket.sharing?.guests.some((g) => g.workspaceId === w.id),
          ).length > 0 ? (
            <details className="mb-3 rounded-lg border px-3 py-2">
              <summary className="cursor-pointer text-2xs font-medium">
                Bring in another workspace
              </summary>
              <div className="mt-2 flex flex-col gap-2">
                <select
                  value={escTargetId}
                  disabled={busy}
                  onChange={(e) => setEscTargetId(e.target.value)}
                  className="h-8 w-full rounded-md border bg-background px-2 text-xs"
                  aria-label="Workspace to bring in"
                >
                  <option value="">Choose a workspace…</option>
                  {escalationTargets
                    .filter(
                      (w) =>
                        w.id !== ticket.sharing?.ownerWorkspaceId &&
                        !ticket.sharing?.guests.some((g) => g.workspaceId === w.id),
                    )
                    .map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                </select>
                <textarea
                  value={escCause}
                  disabled={busy}
                  onChange={(e) => setEscCause(e.target.value)}
                  rows={2}
                  maxLength={5000}
                  placeholder="What do you need from them?"
                  className="w-full rounded-md border bg-background px-2 py-1.5 text-xs"
                  aria-label="Why this workspace is being brought in"
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
                    Give them access
                  </button>
                </div>
              </div>
            </details>
          ) : null}

        </section>
      ) : escalationTargets.length > 0 ? (
        <section className="rounded-xl border bg-card p-4">
          <h2 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
            <ArrowUpRight aria-hidden className="size-4" />
            Escalate to another workspace
          </h2>
          <p className="mb-3 text-2xs leading-relaxed text-muted-foreground">
            When nobody here can answer, hand this ticket to another workspace in your
            organization. They work the <strong className="font-medium">same ticket</strong>{" "}
            — same status, same history, same files — and get the customer&rsquo;s details
            plus your reason. Your inbox conversation stays private.
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
              placeholder="What do you need from them? e.g. Customer 123 was double-charged on invoice #88 and needs a refund approval we can't give here."
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

      {/* Files on the TICKET itself. A file posted in the thread renders with
          the message that explains it, so it is excluded here rather than
          listed twice. Every party to a shared ticket sees all of them — the
          ticket is meant to carry the whole issue. */}
      <section className="rounded-xl border bg-card p-4">
        <h2 className="mb-1 text-sm font-semibold">Files</h2>
        <p className="mb-2 text-2xs text-muted-foreground">
          {ticket.sharing
            ? "Visible to every workspace working this ticket."
            : "Screenshots, invoices, forms — whatever the issue needs."}
        </p>
        {ticket.attachments.filter(isTicketLevel).length > 0 ? (
          <ul className="mb-2 flex flex-col gap-1.5">
            {ticket.attachments
              .filter(isTicketLevel)
              .map((a) => (
                <TicketAttachmentRow
                  key={a.id}
                  attachment={a}
                  busy={busy}
                  onRemove={() => void removeAttachment(a.id)}
                />
              ))}
          </ul>
        ) : null}
        <FilePicker
          busy={busy}
          label="Add files"
          onPick={(files) => void attachFiles(files)}
        />
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

      {/* Internal notes. Their own panel, not log lines: a note is something
          someone WROTE, and among twenty status flips it was unfindable — the
          same complaint that moved the discussion into the thread. Private to
          THIS workspace; the API never sends another department's. */}
      <section className="rounded-xl border border-amber-500/30 bg-amber-500/[0.03] p-4">
        <h2 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
          <Lock aria-hidden className="size-3.5 text-amber-600 dark:text-amber-500" />
          Internal notes
          {notes.length > 0 ? (
            <span className="text-2xs font-normal text-muted-foreground">{notes.length}</span>
          ) : null}
        </h2>
        <p className="mb-2 text-2xs text-muted-foreground">
          {ticket.sharing
            ? "Only your workspace sees these — not the customer, and not the other workspaces on this ticket. Use the thread to talk to them."
            : "Only your workspace sees these — the customer never does."}
        </p>
        {notes.length > 0 ? (
          <ol className="mb-3 flex max-h-72 flex-col gap-2 overflow-y-auto">
            {notes.map((n) => (
              <li key={n.id} className="rounded-md border bg-background px-2.5 py-1.5">
                <p className="flex flex-wrap items-baseline gap-x-1.5 text-3xs text-muted-foreground">
                  <strong className="font-medium text-foreground">
                    {n.actorName ?? "Automation"}
                  </strong>
                  <LocalTime iso={n.createdAt} format="listTime" />
                </p>
                <p className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-relaxed">
                  {n.body}
                </p>
                {n.attachments && n.attachments.length > 0 ? (
                  <ul className="mt-1 flex flex-col gap-1">
                    {n.attachments.map((a) => (
                      <TicketAttachmentRow key={a.id} attachment={a} busy={busy} />
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}
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

      {/* The audit log. COLLAPSED by default: it answers "who changed what",
          which you go looking for — unlike the thread, which you read. */}
      <details className="rounded-xl border bg-card p-4">
        <summary className="cursor-pointer text-sm font-semibold">
          History
          <span className="ml-1.5 font-normal text-2xs text-muted-foreground">
            {events.length}
          </span>
        </summary>
        <ol className="mt-2 flex max-h-96 flex-col gap-2 overflow-y-auto">
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
                {(e.kind === "escalated" || e.kind === "escalation_revoked") &&
                eventStr(e.after, "guestWorkspaceName") ? (
                  <>
                    {e.kind === "escalated" ? " — " : " — "}
                    <strong className="font-medium">
                      {eventStr(e.after, "guestWorkspaceName")}
                    </strong>
                  </>
                ) : null}
                {(e.kind === "attachment_added" || e.kind === "attachment_removed") &&
                eventStr(e.after, "filename") ? (
                  <>
                    {" "}
                    <strong className="font-medium">{eventStr(e.after, "filename")}</strong>
                  </>
                ) : null}
                {/* WHICH department acted — the whole point of a shared log. */}
                {e.actorWorkspaceName ? (
                  <span className="ml-1 rounded bg-muted px-1 py-px text-3xs text-muted-foreground">
                    {e.actorWorkspaceName}
                  </span>
                ) : null}
              </span>
              {e.body ? (
                <p
                  className={cn(
                    "mt-0.5 basis-full whitespace-pre-wrap rounded-md border-l-2 px-2 py-1 text-2xs text-foreground",
                    e.kind === "escalation_note"
                      ? "border-primary bg-primary/5"
                      : "border-primary/30 bg-muted/40",
                  )}
                >
                  {e.body}
                </p>
              ) : null}
              {/* Files that came in WITH this entry render under it. */}
              {e.attachments && e.attachments.length > 0 ? (
                <ul className="mt-1 flex basis-full flex-col gap-1">
                  {e.attachments.map((a) => (
                    <TicketAttachmentRow key={a.id} attachment={a} busy={busy} />
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
          {events.length === 0 && (
            <li className="text-2xs text-muted-foreground">Nothing yet.</li>
          )}
        </ol>
      </details>
        </aside>
      </div>

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

/**
 * A file input styled as a button. Resets its value after picking so choosing
 * the SAME file twice still fires a change event.
 */
function FilePicker({
  busy,
  label,
  onPick,
}: {
  busy: boolean;
  label: string;
  onPick: (files: File[]) => void;
}) {
  return (
    <label
      className={cn(
        "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-3 text-xs font-medium",
        busy && "pointer-events-none opacity-50",
      )}
    >
      <Paperclip aria-hidden className="size-3.5" />
      {label}
      <input
        type="file"
        multiple
        disabled={busy}
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length > 0) onPick(files);
        }}
      />
    </label>
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
