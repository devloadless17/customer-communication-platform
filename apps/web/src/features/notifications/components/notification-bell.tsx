"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { Bell, CheckCheck } from "lucide-react";

import { LocalTime } from "@/components/local-time";
import { apiFetch } from "@/lib/api/client-fetch";
import { getClientSocket } from "@/lib/socket-client";
import { toast } from "@/lib/toast";
import { cn } from "@ccp/shared/utils";
import type { AppNotification } from "@ccp/shared/notifications/types";

/**
 * The bell — where anything meant for YOU lands and waits.
 *
 * The app's other signals (rail badges, toasts) are ambient and per-surface:
 * neither survives you being away from the tab, so a member assigned a ticket
 * found out by going to look. This is the one place that remembers.
 *
 * Server-authoritative, like every other count in the app (§10): seeded on
 * mount, refetched on the socket frame, and re-seeded on every reconnect — a
 * badge maintained by client-side arithmetic drifts after the first offline gap.
 */

/** One line per notification kind. Unknown kinds fall through to the summary. */
const KIND_VERB: Record<string, string> = {
  ticket_assigned: "assigned you a ticket",
  ticket_replied: "replied on a ticket",
  ticket_changed: "updated a ticket",
  ticket_file_added: "added a file",
  ticket_escalated: "escalated a ticket",
};

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  /**
   * Where to pin the panel, in VIEWPORT coordinates.
   *
   * The panel is portalled to <body> rather than positioned inside the rail:
   * the rail and the section sub-sidebar are siblings, so a `z-50` on a
   * descendant of the rail cannot paint above the sub-sidebar — the panel
   * opened correctly and was then covered by the ticket views, which reads
   * exactly like a broken button.
   */
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);

  const loadCount = useCallback(async () => {
    try {
      const res = await apiFetch("/api/notifications/unread-count");
      if (!res.ok) return;
      const body = (await res.json()) as { unread?: unknown };
      if (typeof body.unread === "number") setUnread(body.unread);
    } catch {
      // Chrome: a failed poll leaves the last badge rather than zeroing it.
    }
  }, []);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch("/api/notifications?limit=30");
      if (!res.ok) return;
      const body = (await res.json()) as { notifications?: AppNotification[]; unread?: number };
      setItems(body.notifications ?? []);
      if (typeof body.unread === "number") setUnread(body.unread);
    } catch {
      // Same posture as the count.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCount();
    const socket = getClientSocket();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const debounced = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void loadCount(), 300);
    };
    const onNew = (payload: { ticketNumber?: number; actorName?: string; summary?: string }) => {
      debounced();
      // The frame reaches this user's room ONLY, so anything arriving here is
      // genuinely theirs — no recipient check needed, unlike the workspace-wide
      // ticket frames.
      const who = payload.actorName ?? "Someone";
      const what = payload.summary ?? "sent you a notification";
      toast.info(payload.ticketNumber ? `${who} ${what} · #${payload.ticketNumber}` : `${who} ${what}`);
    };
    socket.on("notification:new", onNew);
    // Re-seed after an offline gap longer than the socket recovery window.
    socket.on("connect", debounced);
    return () => {
      if (timer) clearTimeout(timer);
      socket.off("notification:new", onNew);
      socket.off("connect", debounced);
    };
  }, [loadCount]);

  // Close on an outside click / Escape — a panel you cannot dismiss without
  // navigating is worse than no panel.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // The panel lives in a portal now, so "inside" is the panel OR the button
      // that owns it — a single `contains` on one wrapper no longer covers both.
      if (panelRef.current?.contains(t)) return;
      if (buttonRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const markAllRead = async () => {
    if (unread === 0) return;
    setUnread(0);
    setItems((prev) =>
      prev.map((n) => (n.readAt ? n : { ...n, readAt: new Date().toISOString() })),
    );
    await apiFetch("/api/notifications/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }).catch(() => undefined);
  };

  /**
   * GROUPED BY TICKET at render time — which is why the rows are append-only
   * and never coalesced at write time (no upsert race, no partial index, and
   * the history survives being read). Three edits to #42 read as one entry.
   */
  const grouped = useMemo(() => {
    const out: Array<{ key: string; head: AppNotification; extra: number; unread: boolean }> = [];
    const seen = new Map<string, number>();
    for (const n of items) {
      const key = n.ticketId ?? n.id;
      const at = seen.get(key);
      if (at === undefined) {
        seen.set(key, out.length);
        out.push({ key, head: n, extra: 0, unread: !n.readAt });
      } else {
        const row = out[at]!;
        row.extra += 1;
        row.unread = row.unread || !n.readAt;
      }
    }
    return out;
  }, [items]);

  return (
    <div className="relative">
      <button
        type="button"
        ref={buttonRef}
        onClick={() => {
          const next = !open;
          if (next) {
            const r = buttonRef.current?.getBoundingClientRect();
            if (r) {
              setAnchor({
                left: Math.round(r.right + 8),
                bottom: Math.round(window.innerHeight - r.bottom),
              });
            }
            void loadList();
          }
          setOpen(next);
        }}
        aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
        aria-expanded={open}
        className={cn(
          "relative flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground",
          open && "bg-accent/60 text-foreground",
        )}
      >
        <Bell className="size-4.5" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground ring-2 ring-sidebar">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && anchor && typeof document !== "undefined" && createPortal(
        <div
          ref={panelRef}
          style={{ left: anchor.left, bottom: anchor.bottom }}
          className="fixed z-[100] w-80 overflow-hidden rounded-xl border bg-popover shadow-lg"
        >
          <div className="flex items-center justify-between border-b px-3 py-2">
            <h2 className="text-xs font-semibold">Notifications</h2>
            {unread > 0 && (
              <button
                type="button"
                onClick={() => void markAllRead()}
                className="inline-flex cursor-pointer items-center gap-1 text-3xs text-muted-foreground hover:text-foreground"
              >
                <CheckCheck aria-hidden className="size-3" />
                Mark all read
              </button>
            )}
          </div>

          <ol className="max-h-96 overflow-y-auto">
            {grouped.map((row) => {
              const n = row.head;
              const line = KIND_VERB[n.kind] ?? n.summary ?? "sent you a notification";
              return (
                <li key={row.key} className={cn("border-b last:border-b-0", row.unread && "bg-primary/[0.04]")}>
                  <Link
                    href={n.ticketId ? `/tickets/${n.ticketId}` : "/tickets"}
                    onClick={() => setOpen(false)}
                    className="block px-3 py-2 hover:bg-accent/50"
                  >
                    <p className="text-2xs leading-relaxed">
                      <strong className="font-medium">{n.actorName ?? "Automation"}</strong>{" "}
                      {n.summary ?? line}
                      {n.ticketNumber ? (
                        <span className="ml-1 tabular-nums text-muted-foreground">
                          #{n.ticketNumber}
                        </span>
                      ) : null}
                    </p>
                    {n.ticketSubject ? (
                      <p className="truncate text-3xs text-muted-foreground">{n.ticketSubject}</p>
                    ) : null}
                    <p className="mt-0.5 flex items-center gap-1.5 text-3xs text-muted-foreground">
                      <LocalTime iso={n.createdAt} format="listTime" />
                      {row.extra > 0 ? <span>· +{row.extra} more on this ticket</span> : null}
                    </p>
                  </Link>
                </li>
              );
            })}
            {grouped.length === 0 && (
              <li className="px-3 py-6 text-center text-2xs text-muted-foreground">
                {loading ? "Loading…" : "Nothing yet. Assignments and replies land here."}
              </li>
            )}
          </ol>
        </div>,
        document.body,
      )}
    </div>
  );
}
