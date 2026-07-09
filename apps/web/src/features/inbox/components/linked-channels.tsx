"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, Loader2, Pencil, Plus, Search, Users, X } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LocalTime } from "@/components/local-time";
import { apiFetch } from "@/lib/api/client-fetch";
import { CHANNEL_LABEL, ChannelBadge } from "./channel-badge";
import { cn, formatPhone, initials } from "@ccp/shared/utils";
import type { Channel, ContactListItem } from "@ccp/shared/types";

interface CustomerContact {
  id: string;
  name: string;
  identityChannel: Channel;
  phoneNumber: string | null;
  externalContactId: string | null;
  avatarUrl: string | null;
  conversationId: string | null;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  conversationStatus: string | null;
}
interface Profile {
  id: string;
  name: string | null;
  contacts: CustomerContact[];
  unreadTotal: number;
}
interface SearchHit {
  id: string;
  name: string;
  identityChannel: Channel;
  phoneNumber: string | null;
}

/** The channel-side identity for a contact — phone, or the channel label. */
function subtitle(c: { phoneNumber: string | null; identityChannel: Channel }): string {
  return c.phoneNumber ? formatPhone(c.phoneNumber) : CHANNEL_LABEL[c.identityChannel];
}

/**
 * Unified-customer PERSON HUB in the contact panel: the person (editable
 * `Customer.name`) plus every channel they've reached us on, each shown like a
 * mini conversation row (last message + time + unread + status). The currently-
 * open channel is highlighted; every other channel is one click from its thread.
 * Link joins another contact into this person; unlink splits one off. Threads
 * stay separate — this is the profile-and-switcher layer over them (§6).
 */
export function LinkedChannels({ contactId }: { contactId: string }) {
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const searchSeq = useRef(0);
  // Inline person rename.
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  const load = useCallback(async () => {
    const res = await apiFetch(`/api/customers/by-contact/${contactId}`);
    if (res.ok) {
      const { customer } = (await res.json()) as { customer: Profile | null };
      setProfile(customer);
    } else {
      setProfile(null);
    }
  }, [contactId]);

  useEffect(() => {
    setProfile(undefined);
    setPicking(false);
    setQuery("");
    setHits([]);
    setEditingName(false);
    void load();
  }, [load]);

  // Debounced contact search for the link picker.
  useEffect(() => {
    if (!picking) return;
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    const seq = ++searchSeq.current;
    setSearching(true);
    const t = setTimeout(() => {
      void (async () => {
        try {
          const res = await apiFetch(`/api/contacts?search=${encodeURIComponent(q)}&limit=8`);
          if (res.ok && seq === searchSeq.current) {
            // The list endpoint returns CursorPage<ContactListItem> — each item
            // is { contact: {...} }, NOT a flat hit. Map the contact fields out
            // (and coalesce the name so `initials()` never sees null/undefined).
            const { items } = (await res.json()) as { items: ContactListItem[] };
            setHits(
              (items ?? []).flatMap(({ contact: c }) => {
                const ch = c.identityChannel;
                if (!ch) return [];
                return [
                  {
                    id: c.id,
                    name: c.name || subtitle({ phoneNumber: c.phoneNumber, identityChannel: ch }),
                    identityChannel: ch,
                    phoneNumber: c.phoneNumber,
                  },
                ];
              }),
            );
          }
        } finally {
          if (seq === searchSeq.current) setSearching(false);
        }
      })();
    }, 250);
    return () => clearTimeout(t);
  }, [query, picking]);

  const linkedIds = new Set(profile?.contacts.map((c) => c.id) ?? []);

  async function link(otherId: string) {
    if (!profile) return;
    setBusy(true);
    try {
      const res = await apiFetch(`/api/customers/${profile.id}/link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contactId: otherId }),
      });
      if (res.ok) {
        setPicking(false);
        setQuery("");
        setHits([]);
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function unlink(otherId: string) {
    if (!profile) return;
    setBusy(true);
    try {
      const res = await apiFetch(`/api/customers/${profile.id}/unlink`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contactId: otherId }),
      });
      if (res.ok) await load();
    } finally {
      setBusy(false);
    }
  }

  async function saveName() {
    if (!profile) return;
    const next = nameDraft.trim();
    setEditingName(false);
    if (next === (profile.name ?? "")) return;
    setBusy(true);
    try {
      const res = await apiFetch(`/api/customers/${profile.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: next }),
      });
      if (res.ok) {
        const { customer } = (await res.json()) as { customer: Profile };
        setProfile(customer);
      }
    } finally {
      setBusy(false);
    }
  }

  if (profile === undefined) return null; // loading — stay quiet
  // Solo person with no other channels + no name to manage: keep the panel calm,
  // just the "link a channel" affordance.
  const contacts = profile?.contacts ?? [];
  const hasOthers = contacts.some((c) => c.id !== contactId);

  return (
    <div className="flex flex-col gap-2 px-5 py-3">
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          <Users className="size-3" />
          Same person
          {profile && profile.unreadTotal > 0 && (
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-3xs font-semibold text-primary-foreground">
              {profile.unreadTotal > 99 ? "99+" : profile.unreadTotal}
            </span>
          )}
        </span>
        {profile && !picking && (
          <button
            type="button"
            onClick={() => setPicking(true)}
            className="inline-flex items-center gap-1 text-2xs font-medium text-primary hover:underline"
          >
            <Plus className="size-3" />
            Link a channel
          </button>
        )}
      </div>

      {/* Person header — the identity that spans channels. Editable name. Only
          shown once the person actually has >1 channel (a solo contact's name
          is already the panel header). */}
      {profile && hasOthers && (
        <div className="flex items-center gap-1.5">
          {editingName ? (
            <>
              <Input
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveName();
                  if (e.key === "Escape") setEditingName(false);
                }}
                placeholder="Person name"
                className="h-7 px-2 text-xs"
              />
              <Button
                variant="ghost"
                size="icon"
                className="size-6 shrink-0"
                type="button"
                onClick={() => void saveName()}
                aria-label="Save name"
              >
                <Check className="size-3.5" />
              </Button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => {
                setNameDraft(profile.name ?? "");
                setEditingName(true);
              }}
              className="group/name inline-flex items-center gap-1.5 text-xs font-medium hover:text-primary"
              title="Rename this person"
            >
              {profile.name?.trim() || "Unnamed person"}
              <Pencil className="size-3 opacity-0 group-hover/name:opacity-100" />
            </button>
          )}
        </div>
      )}

      {!hasOthers && !picking && (
        <p className="text-xs text-muted-foreground">
          Not linked to any other channel yet.
        </p>
      )}

      {/* The full channel roster — only when the person spans >1 channel (a solo
          contact's single channel is already the panel header, so we don't echo
          it as a one-row list). */}
      {hasOthers && contacts.map((c) => {
        const isActive = c.id === contactId;
        const unread = c.unreadCount > 0;
        return (
          <div
            key={c.id}
            className={cn(
              "group flex items-center gap-2 rounded-md px-1.5 py-1.5",
              isActive ? "bg-primary/10" : "hover:bg-muted/60",
            )}
          >
            <Avatar className="size-7 shrink-0">
              {c.avatarUrl ? <AvatarImage src={c.avatarUrl} alt="" /> : null}
              <AvatarFallback className="bg-muted text-2xs font-medium">
                {initials(c.name)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <ChannelBadge channel={c.identityChannel} className="size-3 shrink-0" />
                <span className="truncate text-xs font-medium">{c.name}</span>
                {c.lastMessageAt && (
                  <LocalTime
                    iso={c.lastMessageAt}
                    format="listTime"
                    className="ml-auto shrink-0 text-3xs tabular-nums text-muted-foreground"
                  />
                )}
              </div>
              <p className="truncate text-2xs text-muted-foreground">
                {c.lastMessagePreview?.trim() || subtitle(c)}
              </p>
            </div>
            {unread && (
              <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-3xs font-semibold text-primary-foreground">
                {c.unreadCount > 99 ? "99+" : c.unreadCount}
              </span>
            )}
            {isActive ? (
              <span className="shrink-0 text-3xs font-medium uppercase tracking-wide text-primary">
                Here
              </span>
            ) : c.conversationId ? (
              <Link
                href={`/inbox?c=${c.conversationId}`}
                className="shrink-0 text-2xs font-medium text-primary hover:underline"
              >
                Open
              </Link>
            ) : null}
            {!isActive && (
              <button
                type="button"
                onClick={() => unlink(c.id)}
                disabled={busy}
                aria-label="Unlink this channel"
                title="Not the same person — split off"
                className="shrink-0 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100 disabled:opacity-40"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        );
      })}

      {picking && (
        <div className="mt-1 flex flex-col gap-1.5 rounded-md border p-2">
          <div className="flex items-center gap-1.5">
            <Search className="size-3.5 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search a contact to link…"
              className="h-7 border-0 px-1 text-xs shadow-none focus-visible:ring-0"
            />
            {searching && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              type="button"
              onClick={() => {
                setPicking(false);
                setQuery("");
              }}
            >
              <X className="size-3.5" />
            </Button>
          </div>
          {hits
            .filter((h) => h.id !== contactId && !linkedIds.has(h.id))
            .map((h) => (
              <button
                key={h.id}
                type="button"
                disabled={busy}
                onClick={() => link(h.id)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-muted/60 disabled:opacity-50",
                )}
              >
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-3xs font-medium">
                  {initials(h.name)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1">
                    <span className="truncate text-xs">{h.name}</span>
                    <ChannelBadge channel={h.identityChannel} className="size-3" />
                  </div>
                  <p className="truncate text-2xs text-muted-foreground">{subtitle(h)}</p>
                </div>
              </button>
            ))}
          {query.trim().length >= 2 && !searching && hits.length === 0 && (
            <p className="px-1.5 py-1 text-2xs text-muted-foreground">No matches.</p>
          )}
        </div>
      )}
    </div>
  );
}
