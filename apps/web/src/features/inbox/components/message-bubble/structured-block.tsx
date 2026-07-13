import { BookOpen, MapPin, ShoppingBag } from "lucide-react";
import { LocationMap } from "./location-map";
import { ContactCard } from "./contact-card";

import { cn } from "@ccp/shared/utils";
import type { MessageStructured } from "@ccp/shared/types";

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
    // Secondary text (address/coords + "Open in Maps") must stay readable on the
    // colored OUTBOUND bubble, where `text-muted-foreground`/`text-primary` are
    // near-invisible. Derive from the bubble side.
    const subClass = isOut ? "text-outbound-fg/75" : "text-muted-foreground";
    const linkClass = isOut ? "text-outbound-fg/90" : "text-primary";
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="group block w-64 max-w-full overflow-hidden rounded-xl"
      >
        {/* Map preview — full-width, WhatsApp-style. Tap to open the full map. */}
        <LocationMap lat={latitude} lon={longitude} className="h-32 w-full" />
        <span className="flex items-start gap-2 px-2.5 py-2">
          <MapPin
            className={cn("mt-0.5 size-4 shrink-0", isOut ? "text-outbound-fg" : "text-primary")}
            aria-hidden
          />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">
              {name?.trim() || "Shared location"}
            </span>
            <span className={cn("block truncate text-2xs", subClass)}>
              {address?.trim() ||
                `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`}
            </span>
            <span className={cn("mt-0.5 block text-2xs font-medium group-hover:underline", linkClass)}>
              Open in Maps
            </span>
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

  if (structured.kind === "order") {
    const money = (amount: number) => formatMoney(amount, structured.currency);
    return (
      <div className="w-56 max-w-full rounded-lg border border-black/10 bg-background p-2.5 text-foreground">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <ShoppingBag className="size-4 shrink-0" />
          Order · {structured.itemCount} item{structured.itemCount === 1 ? "" : "s"}
        </div>
        <ul className="mt-1.5 flex flex-col gap-1">
          {structured.items.map((it, i) => (
            <li key={i} className="flex items-baseline justify-between gap-2 text-2xs text-muted-foreground">
              <span className="min-w-0 truncate">
                {it.quantity}× {it.retailerId}
              </span>
              {it.price != null ? (
                <span className="shrink-0 tabular-nums">{money(it.price * it.quantity)}</span>
              ) : null}
            </li>
          ))}
        </ul>
        {structured.total != null ? (
          <div className="mt-1.5 flex justify-between border-t border-black/5 pt-1.5 text-xs font-medium">
            <span>Total</span>
            <span className="tabular-nums">{money(structured.total)}</span>
          </div>
        ) : null}
      </div>
    );
  }

  // Contact card(s) — a vCard the customer shared. Rendered by the interactive
  // ContactCard (a client component): "Message" opens a conversation with this
  // number IN the inbox, "Save contact" creates a CRM Contact — both in-system,
  // never a wa.me hop or a .vcf download.
  return <ContactCard contacts={structured.contacts} isOut={isOut} />;
}

/** Format a money amount with the order's currency (falls back to a plain
 *  fixed-2 number when the currency code is missing or unrecognized). */
function formatMoney(amount: number, currency?: string): string {
  if (currency) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
    } catch {
      // Unknown/invalid ISO code — fall through to a plain formatted number.
    }
  }
  return amount.toFixed(2);
}

/** Rounded icon chip, tinted to sit on either bubble side. */
function cnPin(isOut: boolean): string {
  return [
    "grid size-8 shrink-0 place-items-center rounded-full",
    isOut ? "bg-primary-foreground/15 text-primary-foreground" : "bg-muted text-foreground",
  ].join(" ");
}
