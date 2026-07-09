import { BookOpen, MapPin, Phone, UserRound } from "lucide-react";

import type { MessageStructured } from "@ccp/shared/types";
import { formatPhone } from "@ccp/shared/utils";

/**
 * Rich rendering for structured (non-media) message content — a shared WhatsApp
 * location pin or contact card — replacing the plain text placeholder. Set at
 * ingest time (`Message.structured`), so it needs no live reducer wiring.
 */
export function StructuredBlock({
  structured,
  isOut,
}: {
  structured: MessageStructured;
  isOut: boolean;
}) {
  if (structured.kind === "location") {
    const { latitude, longitude, name, address } = structured;
    // Open in the OS's default maps app (Google Maps universal query URL).
    const href = `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-start gap-2 px-2.5 py-2 hover:underline"
      >
        <span
          className={cnPin(isOut)}
          aria-hidden
        >
          <MapPin className="size-4" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">
            {name?.trim() || "Shared location"}
          </span>
          <span className="block truncate text-2xs text-muted-foreground">
            {address?.trim() || `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`}
          </span>
          <span className="mt-0.5 block text-2xs font-medium text-primary">
            Open in Maps
          </span>
        </span>
      </a>
    );
  }

  if (structured.kind === "story") {
    const label =
      structured.storyType === "reply"
        ? "Replied to your story"
        : structured.storyType === "share"
          ? "Shared a post"
          : "Mentioned you in their story";
    const body = (
      <span className="flex items-center gap-2 px-2.5 py-2">
        <span className={cnPin(isOut)} aria-hidden>
          <BookOpen className="size-4" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{label}</span>
          {structured.url && (
            <span className="mt-0.5 block text-2xs font-medium text-primary">
              Open story
            </span>
          )}
        </span>
      </span>
    );
    return structured.url ? (
      <a
        href={structured.url}
        target="_blank"
        rel="noopener noreferrer"
        className="block hover:underline"
      >
        {body}
      </a>
    ) : (
      body
    );
  }

  // Contact card(s) — a vCard the customer shared.
  return (
    <div className="flex flex-col gap-1.5 px-2.5 py-2">
      {structured.contacts.map((c, i) => (
        <div key={i} className="flex items-start gap-2">
          <span className={cnPin(isOut)} aria-hidden>
            <UserRound className="size-4" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">
              {c.name?.trim() || "Shared contact"}
            </span>
            {c.phones.map((p, j) => (
              <span
                key={j}
                className="flex items-center gap-1 text-2xs text-muted-foreground"
              >
                <Phone className="size-2.5 shrink-0" />
                <span className="truncate">{formatPhone(p)}</span>
              </span>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Rounded icon chip, tinted to sit on either bubble side. */
function cnPin(isOut: boolean): string {
  return [
    "grid size-8 shrink-0 place-items-center rounded-full",
    isOut ? "bg-primary-foreground/15 text-primary-foreground" : "bg-muted text-foreground",
  ].join(" ");
}
