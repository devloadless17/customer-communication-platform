"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Search, UserRound, X } from "lucide-react";

import { apiFetch } from "@/lib/api/client-fetch";
import { emitOptimisticListBump } from "@/features/inbox/lib/optimistic-list-bump";
import { useFocusTrap } from "@/hooks/use-modal-overlay";
import { formatPhone } from "@ccp/shared/utils";

/**
 * Inbox-side composer to SEND a contact (vCard) — the outbound twin of the
 * shared-contact card. The agent searches their CRM contacts and picks one; we
 * POST /api/messages/contact, and it renders on the thread as the same contact
 * card an inbound share does (the send persists a `structured` payload). New
 * bubble arrives via the `message.sent` socket event.
 */

interface Hit {
  id: string;
  name: string;
  phoneNumber: string | null;
  email?: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  conversationId: string;
  onSent: () => void;
}

export function ContactComposer({ open, onClose, conversationId, onSent }: Props) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [searching, setSearching] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setHits([]);
      setError(null);
    }
  }, [open]);

  useFocusTrap(wrapperRef, open, onClose);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) onClose();
    }
    const t = window.setTimeout(() => window.addEventListener("mousedown", onDocClick), 0);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("mousedown", onDocClick);
    };
  }, [open, onClose]);

  // Debounced CRM search.
  useEffect(() => {
    if (!open) return;
    const query = q.trim();
    if (query.length < 2) {
      setHits([]);
      // Reset the spinner too — deleting back below 2 chars cancels the in-flight
      // search (whose finally is guarded by `cancelled`), so without this the
      // "Searching…" state sticks with an empty box.
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = window.setTimeout(async () => {
      try {
        // `channel=whatsapp` — you can only share a WhatsApp vCard with a phone
        // number, so restrict the picker to WhatsApp contacts (social contacts
        // have no phone). The list endpoint's channel filter derives from
        // LIVE_CHANNELS.
        const res = await apiFetch(
          `/api/contacts?search=${encodeURIComponent(query)}&channel=whatsapp&limit=8`,
        );
        if (!res.ok) throw new Error("search failed");
        // The list endpoint returns CursorPage<ContactListItem> — each item is
        // `{ contact: {...} }`, NOT a flat hit (same shape linked-channels.tsx
        // unwraps). Reading `phoneNumber` off the wrapper dropped EVERY match, so
        // the picker always showed "no contacts" no matter what was typed.
        const j = (await res.json()) as {
          items?: Array<{ contact: Hit }>;
          contacts?: Hit[];
        };
        const raw: Hit[] = j.items
          ? j.items.map((it) => it.contact).filter(Boolean)
          : j.contacts ?? [];
        if (!cancelled) setHits(raw.filter((h) => h.phoneNumber));
      } catch {
        if (!cancelled) setHits([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [q, open]);

  async function send(hit: Hit) {
    if (!hit.phoneNumber || busyId) return;
    setBusyId(hit.id);
    setError(null);
    try {
      // Contacts store the number as digits; send it in display E.164 (leading
      // "+") so both our rendered card AND the message the customer receives show
      // the full international number. The server also derives the wa_id.
      const digits = hit.phoneNumber.replace(/\D/g, "");
      const phone = digits ? `+${digits}` : hit.phoneNumber;
      const res = await apiFetch("/api/messages/contact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId,
          // Idempotency: a re-POST of this exact request carries the same id → no
          // duplicate contact card to the customer.
          clientTempId: crypto.randomUUID(),
          contacts: [
            {
              name: hit.name || "Contact",
              phones: [phone],
              ...(hit.email ? { emails: [hit.email] } : {}),
            },
          ],
        }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
        throw new Error(d.detail || d.error || `Send failed (HTTP ${res.status})`);
      }
      emitOptimisticListBump({
        conversationId,
        preview: `👤 ${hit.name}`,
        lastMessageAt: new Date().toISOString(),
      });
      onSent();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusyId(null);
    }
  }

  if (!open) return null;
  return (
    <div
      ref={wrapperRef}
      role="dialog"
      aria-modal="true"
      aria-label="Send a contact"
      tabIndex={-1}
      className="absolute bottom-[calc(100%+8px)] left-0 z-40 w-80 max-w-[calc(100vw-1.5rem)] rounded-xl border border-border bg-popover p-3 shadow-xl focus:outline-none animate-slide-up"
    >
      <div className="mb-2 flex items-center gap-2">
        <UserRound className="size-4 text-info-fg" />
        <div className="text-sm font-semibold">Send a contact</div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="ml-auto inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="relative mb-2">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search your contacts…"
          className="w-full rounded-md border border-border bg-background py-1.5 pl-7 pr-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>

      <div className="max-h-60 overflow-y-auto">
        {searching ? (
          <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Searching…
          </div>
        ) : hits.length === 0 ? (
          <div className="py-4 text-center text-xs text-muted-foreground">
            {q.trim().length < 2 ? "Type to search contacts" : "No contacts found"}
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {hits.map((h) => (
              <li key={h.id}>
                <button
                  type="button"
                  onClick={() => send(h)}
                  disabled={busyId !== null}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-accent disabled:opacity-50"
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-2xs font-semibold uppercase text-muted-foreground">
                    {initials(h.name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{h.name || "Unnamed"}</span>
                    {h.phoneNumber ? (
                      <span className="block truncate text-2xs text-muted-foreground">
                        {formatPhone(h.phoneNumber)}
                      </span>
                    ) : null}
                  </span>
                  {busyId === h.id ? <Loader2 className="size-3.5 animate-spin" /> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error ? <div className="mt-2 text-xs text-destructive">{error}</div> : null}
    </div>
  );
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      // First CODE POINT (not `w[0]`) + letters/numbers only, so an emoji-led
      // name doesn't render a broken half-surrogate. Falls back to "?".
      .map((w) => Array.from(w)[0] ?? "")
      .filter((ch) => /\p{L}|\p{N}/u.test(ch))
      .join("")
      .toUpperCase() || "?"
  );
}
