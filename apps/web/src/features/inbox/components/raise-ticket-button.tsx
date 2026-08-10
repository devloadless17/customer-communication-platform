"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TicketPlus, Loader2, Check, Paperclip, X } from "lucide-react";
import { toast } from "sonner";

import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client-fetch";
import { apiErrorMessage } from "@ccp/shared/api/error-message";
import { TICKET_PRIORITIES, type TicketPriority } from "@ccp/shared/tickets/types";

/**
 * Raise a ticket on the open conversation.
 *
 * This is the DELIBERATE-creation surface the product is built around (CLAUDE.md
 * §2): an agent reads a message, decides it needs work, and files a ticket with
 * a subject, a cause and — optionally — hands it straight to a team. Distinct
 * from a workflow raising one — and those two are the ONLY doors: nothing
 * opens or reopens a ticket but a person (or a workflow a person built).
 *
 * The teams list is fetched lazily when the dialog opens, so the (heavy) contact
 * panel doesn't have to thread the assignment-policy catalog through just for a
 * button most agents click rarely.
 */

const PRIORITY_LABELS: Record<TicketPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

interface Team {
  id: string;
  name: string;
  isDefault: boolean;
}

interface EscalationTarget {
  id: string;
  name: string;
}

/** The combined "Send to" value: a team here, or a sibling workspace. The
 *  `ws:` prefix keeps one select semantically unambiguous — a team id and a
 *  workspace id can never be confused by the submit path. */
const WS_PREFIX = "ws:";

export function RaiseTicketButton({
  conversationId,
  contactName,
}: {
  conversationId: string;
  contactName: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md border bg-background text-xs font-medium transition-colors hover:bg-accent"
      >
        <TicketPlus aria-hidden className="size-3.5" />
        Raise a ticket
      </button>
      {open && (
        <RaiseTicketDialog
          conversationId={conversationId}
          contactName={contactName}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function RaiseTicketDialog({
  conversationId,
  contactName,
  onClose,
}: {
  conversationId: string;
  contactName: string;
  onClose: () => void;
}) {
  const [subject, setSubject] = useState("");
  const [cause, setCause] = useState("");
  const [priority, setPriority] = useState<TicketPriority>("normal");
  // A team id, or `ws:<workspaceId>` for a cross-workspace escalation.
  const [sendTo, setSendTo] = useState("");
  /** Hand it straight to a person. Optional — most tickets start unclaimed. */
  const [assigneeId, setAssigneeId] = useState("");
  const [members, setMembers] = useState<Array<{ id: string; name: string }> | null>(null);
  /** Live tickets already on THIS thread — shown before the form so an agent
   *  doesn't mint #13 while #12 is still being worked. */
  const [existing, setExisting] = useState<Array<{ id: string; number: number }> | null>(null);
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [workspaces, setWorkspaces] = useState<EscalationTarget[] | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const toWorkspaceId = sendTo.startsWith(WS_PREFIX) ? sendTo.slice(WS_PREFIX.length) : "";
  const toWorkspaceName = workspaces?.find((w) => w.id === toWorkspaceId)?.name ?? "";

  // Lazy-load the destinations once, when the dialog opens. Either failure
  // degrades to a shorter picker rather than blocking the form — filing the
  // ticket must not depend on a catalog being reachable.
  useEffect(() => {
    let alive = true;
    void apiFetch("/api/workspace/assignment-policies")
      .then(async (res) => {
        if (!res.ok) throw new Error("teams");
        const body = (await res.json()) as { policies: Team[] };
        if (alive) setTeams(body.policies ?? []);
      })
      .catch(() => {
        if (alive) setTeams([]);
      });
    void apiFetch(
      `/api/tickets?conversationId=${encodeURIComponent(conversationId)}&status=new,open,pending,on_hold`,
    )
      .then(async (res) => {
        if (!res.ok) throw new Error("existing");
        const body = (await res.json()) as { tickets: Array<{ id: string; number: number }> };
        if (alive) setExisting(body.tickets ?? []);
      })
      .catch(() => {
        if (alive) setExisting([]);
      });
    void apiFetch("/api/users")
      .then(async (res) => {
        if (!res.ok) throw new Error("users");
        const body = (await res.json()) as { users: Array<{ id: string; name: string }> };
        if (alive) setMembers(body.users ?? []);
      })
      .catch(() => {
        if (alive) setMembers([]);
      });
    void apiFetch("/api/tickets/escalation-targets")
      .then(async (res) => {
        if (!res.ok) throw new Error("targets");
        const body = (await res.json()) as { workspaces: EscalationTarget[] };
        if (alive) setWorkspaces(body.workspaces ?? []);
      })
      .catch(() => {
        if (alive) setWorkspaces([]);
      });
    return () => {
      alive = false;
    };
    // conversationId is stable for a mounted dialog; listed for correctness.
  }, [conversationId]);

  async function submit() {
    // Escalating without a cause would hand the other workspace a ticket that
    // says nothing — the server refuses it too; catch it before the round-trip.
    if (toWorkspaceId && !cause.trim()) {
      toast.error("Escalating needs a cause — it's everything the other workspace sees.");
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetch("/api/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId,
          subject: subject.trim() || null,
          description: cause.trim() || null,
          priority,
          ...(sendTo && !toWorkspaceId ? { assignedTeamId: sendTo } : {}),
          ...(assigneeId ? { assignedUserId: assigneeId } : {}),
        }),
      });
      if (!res.ok) {
        toast.error(await apiErrorMessage(res, "Couldn't raise the ticket"));
        return;
      }
      const body = (await res.json()) as { ticket: { id: string; number: number } };
      setCreatedId(body.ticket.id);

      // Files go up AFTER the ticket exists — a second request rather than one
      // multipart create, so a rejected file can never cost the agent the whole
      // form. They land as the ticket's FIRST THREAD MESSAGE, not as bare
      // ticket-level attachments: the thread is the one way files arrive (a
      // file belongs with the sentence that explains it), and the raise-time
      // evidence is exactly the file whose sentence is the cause.
      if (files.length > 0) {
        const form = new FormData();
        form.append("body", "");
        for (const f of files) form.append("files", f);
        const up = await apiFetch(`/api/tickets/${body.ticket.id}/thread`, {
          method: "POST",
          body: form,
        });
        if (!up.ok) {
          toast.error(
            await apiErrorMessage(up, "The ticket was raised, but the files didn't attach."),
          );
        }
      }

      if (toWorkspaceId) {
        // Second step of the one-click flow: the ticket exists either way, so
        // an escalate failure leaves a normal ticket the agent can escalate
        // from its page — never a lost form.
        const esc = await apiFetch(`/api/tickets/${body.ticket.id}/escalate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetWorkspaceId: toWorkspaceId, cause: cause.trim() }),
        });
        if (esc.ok) {
          toast.success(`Ticket #${body.ticket.number} raised and escalated to ${toWorkspaceName}`);
        } else {
          toast.error(
            await apiErrorMessage(
              esc,
              "The ticket was raised, but escalating failed — open it to escalate.",
            ),
          );
        }
      } else {
        toast.success(`Ticket #${body.ticket.number} raised`);
      }
    } catch {
      toast.error("Couldn't raise the ticket. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const selectClass =
    "h-9 w-full rounded-md border border-input bg-background px-2.5 text-xs shadow-sm transition-colors focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60";

  return (
    <Dialog open onClose={onClose} dismissOnBackdrop={!busy}>
      <DialogContent
        ariaLabel="Raise a ticket"
        className="flex max-w-md flex-col overflow-hidden p-0"
      >
        {/* Header — bordered, with a subtle icon chip, matching the app's dialogs. */}
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <TicketPlus aria-hidden className="size-4" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold leading-tight">Raise a ticket</h2>
            <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">
              On {contactName}&rsquo;s conversation — give it a cause so whoever picks
              it up knows the issue without re-reading the thread.
            </p>
          </div>
        </div>

        {createdId ? (
          <div className="flex flex-col gap-4 px-5 py-5">
            <div className="flex items-center gap-2.5 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2.5 text-xs text-emerald-700 dark:text-emerald-400">
              <Check aria-hidden className="size-4 shrink-0" />
              {toWorkspaceId
                ? `The ticket is on this thread and ${toWorkspaceName} now has access — their replies land in its thread.`
                : assigneeId
                  ? "The ticket is on this thread and its assignee has been notified."
                  : "The ticket is on this thread — nobody has picked it up yet."}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={onClose}>
                Done
              </Button>
              <Button size="sm" asChild>
                <Link href={`/tickets/${createdId}`}>Open the ticket</Link>
              </Button>
            </div>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy) void submit();
            }}
          >
            <div className="flex flex-col gap-4 px-5 py-5">
              {/* Live work already on this thread. Shown, not blocking: a second
                  ticket can be legitimate (a second issue in the same breath) —
                  but minting #13 because nobody noticed #12 is the common case,
                  and this is the moment to notice. */}
              {existing && existing.length > 0 ? (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/[0.06] px-3 py-2 text-2xs leading-relaxed">
                  {existing.length === 1 ? "A ticket is" : `${existing.length} tickets are`} already
                  open on this thread:{" "}
                  {existing.map((t, i) => (
                    <span key={t.id}>
                      {i > 0 ? ", " : ""}
                      <Link
                        href={`/tickets/${t.id}`}
                        className="font-medium underline underline-offset-2"
                      >
                        #{t.number}
                      </Link>
                    </span>
                  ))}
                  {" — "}open it to add to that work, or raise another for a separate issue.
                </div>
              ) : null}
              <div className="flex flex-col gap-1.5">
                <label htmlFor="rt-subject" className="text-xs font-medium text-foreground">
                  Subject
                </label>
                <Input
                  id="rt-subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder={`${contactName}'s request`}
                  maxLength={200}
                  autoFocus
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="rt-cause" className="text-xs font-medium text-foreground">
                  Cause
                </label>
                <textarea
                  id="rt-cause"
                  value={cause}
                  onChange={(e) => setCause(e.target.value)}
                  rows={3}
                  maxLength={5000}
                  placeholder="Why does this need work? What should the team that picks it up know?"
                  className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-xs leading-relaxed shadow-sm transition-colors placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="rt-priority" className="text-xs font-medium text-foreground">
                    Priority
                  </label>
                  <select
                    id="rt-priority"
                    value={priority}
                    onChange={(e) => setPriority(e.target.value as TicketPriority)}
                    className={selectClass}
                  >
                    {TICKET_PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {PRIORITY_LABELS[p]}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="rt-team" className="text-xs font-medium text-foreground">
                    Send to{" "}
                    <span className="font-normal text-muted-foreground">(optional)</span>
                  </label>
                  <select
                    id="rt-team"
                    value={sendTo}
                    disabled={
                      (!teams || teams.length === 0) && (!workspaces || workspaces.length === 0)
                    }
                    onChange={(e) => setSendTo(e.target.value)}
                    className={selectClass}
                  >
                    <option value="">Nobody yet</option>
                    {(teams ?? []).length > 0 && (
                      <optgroup label="Teams here">
                        {(teams ?? []).map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {(workspaces ?? []).length > 0 && (
                      <optgroup label="Escalate to workspace">
                        {(workspaces ?? []).map((w) => (
                          <option key={w.id} value={`${WS_PREFIX}${w.id}`}>
                            {w.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="rt-assignee" className="text-xs font-medium text-foreground">
                    Assign to{" "}
                    <span className="font-normal text-muted-foreground">(optional)</span>
                  </label>
                  {/* A PERSON, alongside the team queue: "Sara handles refunds"
                      is how small teams actually route, and the assignee gets a
                      bell the moment the ticket lands. Empty = unclaimed, which
                      is what makes the untriaged backlog reportable. */}
                  <select
                    id="rt-assignee"
                    value={assigneeId}
                    disabled={!members || members.length === 0}
                    onChange={(e) => setAssigneeId(e.target.value)}
                    className={selectClass}
                  >
                    <option value="">Nobody yet</option>
                    {(members ?? []).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-foreground">
                  Files <span className="font-normal text-muted-foreground">(optional)</span>
                </span>
                {files.length > 0 ? (
                  <ul className="flex flex-col gap-1">
                    {files.map((f, i) => (
                      <li
                        key={`${f.name}-${i}`}
                        className="flex items-center gap-2 rounded-md border bg-background px-2 py-1 text-2xs"
                      >
                        <Paperclip aria-hidden className="size-3 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{f.name}</span>
                        <button
                          type="button"
                          onClick={() => setFiles(files.filter((_, j) => j !== i))}
                          aria-label={`Remove ${f.name}`}
                          className="shrink-0 cursor-pointer text-muted-foreground hover:text-destructive"
                        >
                          <X aria-hidden className="size-3" />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <label
                  className={`inline-flex h-8 w-fit cursor-pointer items-center gap-1.5 rounded-md border px-3 text-xs font-medium ${
                    busy ? "pointer-events-none opacity-50" : ""
                  }`}
                >
                  <Paperclip aria-hidden className="size-3.5" />
                  Attach files
                  <input
                    type="file"
                    multiple
                    disabled={busy}
                    className="hidden"
                    onChange={(e) => {
                      const picked = Array.from(e.target.files ?? []);
                      // Reset so picking the SAME file again still fires change.
                      e.target.value = "";
                      if (picked.length > 0) setFiles((prev) => [...prev, ...picked]);
                    }}
                  />
                </label>
                <p className="text-3xs text-muted-foreground">
                  Screenshots or documents the team picking this up will need.
                </p>
              </div>

              {toWorkspaceId ? (
                <p className="rounded-md border border-primary/25 bg-primary/5 px-3 py-2 text-2xs leading-relaxed text-muted-foreground">
                  This raises the ticket and gives{" "}
                  <strong className="font-medium text-foreground">{toWorkspaceName}</strong>{" "}
                  access to it — one ticket, both workspaces. They get the customer&rsquo;s
                  details, your cause and any files, but never this inbox&rsquo;s messages, so
                  the <strong className="font-medium text-foreground">cause is required</strong>.
                </p>
              ) : null}
            </div>

            {/* Footer — bordered, actions right-aligned. */}
            <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3.5">
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={busy}>
                {busy && <Loader2 aria-hidden className="size-3.5 animate-spin" />}
                Raise ticket
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
