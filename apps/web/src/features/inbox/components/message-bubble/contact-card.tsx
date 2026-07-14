"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Building2,
  Loader2,
  Mail,
  MapPin,
  MessageCircle,
  Phone,
  UserPlus,
  UserRound,
} from "lucide-react";

import { formatPhone } from "@ccp/shared/utils";
import { apiFetch } from "@/lib/api/client-fetch";
import { toast } from "@/lib/toast";

/** One shared vCard entry (the shape `MessageStructured` "contacts" carries). */
export interface SharedContact {
  name: string;
  phones: string[];
  emails?: string[];
  addresses?: string[];
  company?: string;
}

/** Strip formatting to the `+<digits>` a phone-channel contact needs. */
function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  const plus = trimmed.startsWith("+") ? "+" : "";
  return plus + trimmed.replace(/\D/g, "");
}

export function ContactCard({
  contacts,
  isOut,
}: {
  contacts: SharedContact[];
  isOut: boolean;
}) {
  return (
    <div className="flex w-60 max-w-full flex-col gap-1.5">
      {contacts.map((c, i) => (
        <ContactCardRow key={i} contact={c} isOut={isOut} />
      ))}
    </div>
  );
}

function ContactCardRow({ contact: c }: { contact: SharedContact; isOut: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "message" | "save">(null);

  const name = c.name?.trim() || "Shared contact";
  const firstPhone = c.phones[0];
  const hasDetails =
    c.phones.length > 0 ||
    (c.emails?.length ?? 0) > 0 ||
    (c.addresses?.length ?? 0) > 0;

  const onMessage = async () => {
    if (!firstPhone || busy) return;
    setBusy("message");
    try {
      // One atomic call — the server find-or-creates the WhatsApp contact by
      // phone, then opens (or reopens) their conversation.
      const res = await apiFetch("/api/conversations/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phone: normalizePhone(firstPhone),
          ...(name && name !== "Shared contact" ? { name } : {}),
        }),
      });
      if (!res.ok) throw new Error("start failed");
      const { conversationId } = (await res.json()) as { conversationId: string };
      router.push(`/inbox?c=${encodeURIComponent(conversationId)}`);
    } catch {
      toast.error("Couldn't open a conversation for this contact.");
    } finally {
      setBusy(null);
    }
  };

  const onSave = async () => {
    if (!firstPhone || busy) return;
    setBusy("save");
    try {
      const res = await apiFetch("/api/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phoneNumber: normalizePhone(firstPhone),
          channel: "whatsapp",
          ...(name && name !== "Shared contact" ? { name } : {}),
          ...(c.emails?.[0] ? { email: c.emails[0] } : {}),
        }),
      });
      if (res.ok) {
        toast.success(`Saved ${name} to your contacts.`);
      } else if (res.status === 409) {
        toast.info(`${name} is already in your contacts.`);
      } else {
        throw new Error("save failed");
      }
    } catch {
      toast.error("Couldn't save this contact.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="overflow-hidden rounded-lg border border-black/10 bg-background text-foreground">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-2xs font-semibold uppercase text-muted-foreground">
          {contactInitials(name) || <UserRound className="size-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{name}</span>
          {c.company ? (
            <span className="flex items-center gap-1 text-2xs text-muted-foreground">
              <Building2 className="size-2.5 shrink-0" />
              <span className="truncate">{c.company}</span>
            </span>
          ) : null}
        </span>
      </div>

      {hasDetails ? (
        <div className="flex flex-col gap-1 border-t border-black/5 px-2.5 py-1.5">
          {c.phones.map((p, j) => (
            <span
              key={`p${j}`}
              className="flex items-center gap-1.5 text-2xs text-muted-foreground"
            >
              <Phone className="size-2.5 shrink-0" />
              <span className="truncate">{formatPhone(p)}</span>
            </span>
          ))}
          {(c.emails ?? []).map((e, j) => (
            <span
              key={`e${j}`}
              className="flex items-center gap-1.5 text-2xs text-muted-foreground"
            >
              <Mail className="size-2.5 shrink-0" />
              <span className="truncate">{e}</span>
            </span>
          ))}
          {(c.addresses ?? []).map((a, j) => (
            <span
              key={`a${j}`}
              className="flex items-start gap-1.5 text-2xs text-muted-foreground"
            >
              <MapPin className="mt-0.5 size-2.5 shrink-0" />
              <span className="min-w-0">{a}</span>
            </span>
          ))}
        </div>
      ) : null}

      <div className="grid grid-cols-2 border-t border-black/5 text-center text-2xs font-medium">
        <button
          type="button"
          onClick={onMessage}
          disabled={!firstPhone || busy !== null}
          className="flex items-center justify-center gap-1 py-1.5 text-primary transition hover:bg-muted/60 disabled:opacity-40"
        >
          {busy === "message" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <MessageCircle className="size-3" />
          )}
          Message
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={!firstPhone || busy !== null}
          className="flex items-center justify-center gap-1 border-l border-black/5 py-1.5 text-primary transition hover:bg-muted/60 disabled:opacity-40"
        >
          {busy === "save" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <UserPlus className="size-3" />
          )}
          Save contact
        </button>
      </div>
    </div>
  );
}

/** Up to two uppercase initials from a display name (empty → caller shows an
 *  icon). Only alphanumeric leads count, and the first CODE POINT is taken
 *  (`Array.from`, not `w[0]`) so an emoji/astral-led name doesn't render a
 *  broken half-surrogate — it falls through to the icon fallback instead. */
function contactInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => Array.from(w)[0] ?? "")
    .filter((ch) => /\p{L}|\p{N}/u.test(ch))
    .join("")
    .toUpperCase();
}
