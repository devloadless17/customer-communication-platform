"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, Search, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client-fetch";
import { formatPhone } from "@ccp/shared/utils";
import {
  computeWindowStatus,
  formatWindowRemaining,
} from "@ccp/shared/utils/window";
import { useNow } from "@/hooks/use-now";
import type { ContactListItem } from "@ccp/shared/types";

/**
 * Searchable combobox restricted to contacts inside the 24h customer-service
 * window. Used by the Send Message step's "custom phone number" target mode —
 * picking from a 24h-open contact prevents the save-then-fail-at-runtime
 * misconfiguration where the user typed a phone whose contact is outside
 * the window.
 *
 * The runtime check at apps/api/src/lib/workflows/steps/send-message.ts is
 * still the source of truth (the window may close between save and exec);
 * this picker is best-effort UX.
 *
 * Reuses GET /api/contacts?window=open&search=... — no new endpoint.
 */

export interface OpenWindowContactValue {
  phoneNumber: string;
  contactId?: string;
  name?: string;
  /** ISO timestamp of contact's lastInboundAt, used for the inline expiry
   *  hint. Optional — when omitted (e.g. a config saved before this picker
   *  existed), we just render the phone number. */
  lastInboundAt?: string | null;
}

interface Props {
  value: OpenWindowContactValue | null;
  onChange: (value: OpenWindowContactValue | null) => void;
}

export function OpenWindowContactCombobox({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ContactListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // SSR-stable "now" — initialized to the server's clock on first render so
  // the window-status string ("8h left" / "closed 2h ago") paints the same
  // server-side and client-side, no hydration flash.
  const now = useNow();

  // Close on outside-click. Same idiom the StepPickerPopover uses.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    const t = window.setTimeout(() => {
      window.addEventListener("mousedown", onDocClick);
    }, 0);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("mousedown", onDocClick);
    };
  }, [open]);

  // Debounced fetch. 250ms — feels responsive without firing on every keystroke.
  useEffect(() => {
    if (!open) return;
    const handle = window.setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        params.set("window", "open");
        if (query.trim()) params.set("search", query.trim());
        const res = await apiFetch(`/api/contacts?${params.toString()}`);
        if (!res.ok) {
          setResults([]);
          return;
        }
        const page = (await res.json()) as { items: ContactListItem[] };
        setResults(page.items ?? []);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => window.clearTimeout(handle);
  }, [open, query]);

  const onPick = useCallback(
    (item: ContactListItem) => {
      const phone = item.contact.phoneNumber ?? "";
      if (!phone) return;
      onChange({
        phoneNumber: phone,
        contactId: item.contact.id,
        name: item.contact.name,
        lastInboundAt: item.lastInboundAt,
      });
      setOpen(false);
      setQuery("");
    },
    [onChange],
  );

  const onClear = useCallback(() => {
    onChange(null);
    setQuery("");
  }, [onChange]);

  // Selection pill: shows current name + phone + window status. Click to
  // reopen the picker; × to clear.
  if (value && !open) {
    const status = value.lastInboundAt
      ? computeWindowStatus(value.lastInboundAt, now)
      : null;
    const statusLabel = status ? formatWindowRemaining(status) : null;
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="min-w-0 flex-1 cursor-pointer text-left"
          aria-label="Change contact"
        >
          <div className="truncate font-medium">
            {value.name ?? formatPhone(value.phoneNumber)}
          </div>
          <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            <span className="font-mono">{formatPhone(value.phoneNumber)}</span>
            {statusLabel && (
              <>
                <span aria-hidden>·</span>
                <span
                  className={
                    status?.state === "open"
                      ? "text-success-fg"
                      : "text-warning-fg"
                  }
                >
                  {statusLabel}
                </span>
              </>
            )}
          </div>
        </button>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Change"
          title="Change"
        >
          <ChevronsUpDown className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={onClear}
          className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          aria-label="Clear"
          title="Clear"
        >
          <X className="size-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div ref={wrapperRef} className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Search contacts in the 24h window…"
          aria-label="Search contacts in the 24h window"
          className="pl-8"
        />
      </div>
      {open && (
        <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-30 max-h-72 overflow-y-auto rounded-md border border-border bg-popover shadow-lg">
          {loading && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              Searching…
            </div>
          )}
          {!loading && results.length === 0 && (
            <div className="px-3 py-3 text-xs text-muted-foreground">
              No contacts inside the 24h window match. Cold reachout requires a
              Send Template step.
            </div>
          )}
          {!loading &&
            results.map((item) => (
              <ContactRow
                key={item.contact.id}
                item={item}
                now={now}
                selected={item.contact.id === value?.contactId}
                onPick={() => onPick(item)}
              />
            ))}
        </div>
      )}
    </div>
  );
}

function ContactRow({
  item,
  now,
  selected,
  onPick,
}: {
  item: ContactListItem;
  now: number;
  selected: boolean;
  onPick: () => void;
}) {
  const status = useMemo(
    () => computeWindowStatus(item.lastInboundAt, now),
    [item.lastInboundAt, now],
  );
  const remaining = useMemo(() => formatWindowRemaining(status), [status]);
  return (
    <button
      type="button"
      onClick={onPick}
      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent/60"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{item.contact.name}</div>
        <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
          <span className="font-mono">{formatPhone(item.contact.phoneNumber)}</span>
          <span aria-hidden>·</span>
          <span
            className={
              status.state === "open"
                ? "text-success-fg"
                : "text-warning-fg"
            }
          >
            {remaining}
          </span>
        </div>
      </div>
      {selected && <Check className="size-3.5 text-primary" />}
    </button>
  );
}
