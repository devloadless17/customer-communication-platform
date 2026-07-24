"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TicketPlus, Loader2 } from "lucide-react";
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
 * from auto-open (off by default) and from a workflow raising one.
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
  const [teamId, setTeamId] = useState("");
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);

  // Lazy-load the teams once, when the dialog opens. A failure degrades to "no
  // handoff picker" rather than blocking the whole form — filing the ticket must
  // not depend on the team catalog being reachable.
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
    return () => {
      alive = false;
    };
  }, []);

  async function submit() {
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
          ...(teamId ? { assignedTeamId: teamId } : {}),
        }),
      });
      if (!res.ok) {
        toast.error(await apiErrorMessage(res, "Couldn't raise the ticket"));
        return;
      }
      const body = (await res.json()) as { ticket: { id: string; number: number } };
      setCreatedId(body.ticket.id);
      toast.success(`Ticket #${body.ticket.number} raised`);
    } catch {
      toast.error("Couldn't raise the ticket. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} dismissOnBackdrop={!busy}>
      <DialogContent ariaLabel="Raise a ticket" className="flex max-w-md flex-col gap-4">
        <div>
          <h2 className="text-sm font-semibold">Raise a ticket</h2>
          <p className="mt-0.5 text-2xs text-muted-foreground">
            On {contactName}&rsquo;s conversation. Give it a cause so whoever picks it up
            knows the issue without re-reading the thread.
          </p>
        </div>

        {createdId ? (
          // Success state: confirm + offer to jump to the new ticket, rather than
          // silently closing (the agent usually wants to set an assignee next).
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">The ticket is open on this thread.</p>
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
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy) void submit();
            }}
          >
            <div className="flex flex-col gap-1">
              <label htmlFor="rt-subject" className="text-2xs font-medium text-foreground">
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

            <div className="flex flex-col gap-1">
              <label htmlFor="rt-cause" className="text-2xs font-medium text-foreground">
                Cause
              </label>
              <textarea
                id="rt-cause"
                value={cause}
                onChange={(e) => setCause(e.target.value)}
                rows={3}
                maxLength={5000}
                placeholder="Why does this need work? What should the team that picks it up know?"
                className="w-full resize-y rounded-md border bg-background px-2.5 py-1.5 text-xs leading-relaxed focus-visible:border-input focus-visible:outline-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label htmlFor="rt-priority" className="text-2xs font-medium text-foreground">
                  Priority
                </label>
                <select
                  id="rt-priority"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as TicketPriority)}
                  className="h-8 rounded-md border bg-background px-2 text-xs"
                >
                  {TICKET_PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {PRIORITY_LABELS[p]}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1">
                <label htmlFor="rt-team" className="text-2xs font-medium text-foreground">
                  Hand to team{" "}
                  <span className="font-normal text-muted-foreground">(optional)</span>
                </label>
                <select
                  id="rt-team"
                  value={teamId}
                  disabled={!teams || teams.length === 0}
                  onChange={(e) => setTeamId(e.target.value)}
                  className="h-8 rounded-md border bg-background px-2 text-xs disabled:opacity-60"
                >
                  <option value="">Nobody yet</option>
                  {(teams ?? []).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="mt-1 flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onClose}>
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
