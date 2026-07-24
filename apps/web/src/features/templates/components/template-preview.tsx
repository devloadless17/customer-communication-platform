"use client";

import { useEffect, useRef, useState } from "react";
import {
  Image as ImageIcon,
  FileText as FileTextIcon,
  Video,
  ExternalLink,
  Phone,
  Reply,
  MapPin,
  Copy,
  Clock,
} from "lucide-react";

import type { TemplateComponent } from "@ccp/shared/providers/types";
import { cn } from "@ccp/shared/utils";
// Shared with the server, which stores the RENDERED body — a local copy is how
// the preview and the delivered message drift apart.
import {
  renderTemplateBody as renderPlaceholders,
  renderTemplateBodyNamed as renderNamedPlaceholders,
} from "@ccp/shared/template-render";

/**
 * Rendered WhatsApp message bubble for a template — header, body, footer and
 * buttons in the shape Meta dispatches them. Used by both the templates list
 * (preview drawer) and the create wizard (live preview pane).
 *
 * Placeholders are filled by the caller: `bodyValues[i]` plugs into `{{i+1}}`.
 * When a value is empty we leave the placeholder as `{{n}}` so the agent sees
 * which one they still need to fill.
 */

export function TemplatePreview({
  components,
  bodyValues = [],
  headerValue = "",
  /**
   * When the HEADER is media (image/video/document), the optional preview
   * URL renders the actual file. Either an object URL (during create) or
   * a sample URL — falls back to a placeholder when absent.
   */
  headerMediaUrl,
  /**
   * Variable NAMES in fill order for a NAMED-format template (`["first_name",
   * "order_id"]`), or null/omitted for the positional default.
   *
   * Passed in rather than sniffed from the text: rendering a positional template
   * that happens to contain the literal copy `{{order_id}}` as if it were a
   * variable would substitute a value into prose. The caller always knows the
   * template's real `parameter_format`.
   */
  bodyNames,
  headerName,
  className,
}: {
  components: TemplateComponent[];
  bodyValues?: string[];
  headerValue?: string;
  headerMediaUrl?: string | null;
  bodyNames?: string[] | null;
  headerName?: string | null;
  className?: string;
}) {
  const header = components.find((c) => c.type === "HEADER");
  const body = components.find((c) => c.type === "BODY");
  const footer = components.find((c) => c.type === "FOOTER");
  const buttons = components.find((c) => c.type === "BUTTONS");
  const offer = components.find((c) => c.type === "LIMITED_TIME_OFFER");
  const carousel = components.find((c) => c.type === "CAROUSEL");

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="w-full max-w-sm overflow-hidden rounded-2xl rounded-tl-xs border border-emerald-500/15 bg-emerald-500/4 shadow-xs">
        {header && (
          <HeaderBlock
            header={header}
            value={headerValue}
            name={headerName ?? null}
            mediaUrl={headerMediaUrl ?? null}
          />
        )}
        <div className="px-3 py-2.5">
          <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-foreground">
            {body?.text ? (
              bodyNames && bodyNames.length > 0 ? (
                renderNamedPlaceholders(
                  body.text,
                  bodyNames.map((name, i) => ({ name, text: bodyValues[i] ?? "" })),
                )
              ) : (
                renderPlaceholders(body.text, bodyValues)
              )
            ) : (
              <span className="text-muted-foreground">No body</span>
            )}
          </p>
          {footer?.text && (
            <p className="mt-1.5 text-2xs text-muted-foreground">{footer.text}</p>
          )}
        </div>
        {/* Countdown card. The expiry INSTANT is a send-time value, so all the
            template can show is the heading and the shape of the timer. */}
        {offer && (
          <div className="flex items-center gap-2 border-t border-emerald-500/10 bg-emerald-500/6 px-3 py-2">
            <Clock className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="truncate text-xs font-medium text-foreground">
                {offer.limited_time_offer?.text || "Expiring offer!"}
              </div>
              <div className="text-3xs text-muted-foreground">
                Countdown ends at the time set when the message is sent
              </div>
            </div>
          </div>
        )}
      </div>

      {buttons?.buttons && buttons.buttons.length > 0 && (
        <div className="flex w-full max-w-sm flex-col gap-1">
          {buttons.buttons.map((b, i) => (
            <ButtonChip key={i} button={b} />
          ))}
        </div>
      )}

      {/* Card strip. Scrolls horizontally exactly as it does on the phone —
          the cards are deliberately narrow so the "there is more to the right"
          affordance is visible at this width. */}
      {carousel?.cards && carousel.cards.length > 0 && (
        <div className="flex w-full max-w-sm gap-2 overflow-x-auto pb-1">
          {carousel.cards.map((card, i) => {
            const comps = card.components ?? [];
            const header = comps.find((c) => c.type === "HEADER");
            const cardBody = comps.find((c) => c.type === "BODY");
            const cardButtons = comps.find((c) => c.type === "BUTTONS");
            const Icon = (header?.format ?? "").toUpperCase() === "VIDEO" ? Video : ImageIcon;
            return (
              <div
                key={i}
                className="w-40 shrink-0 overflow-hidden rounded-xl border border-emerald-500/15 bg-emerald-500/4"
              >
                <div className="flex h-20 items-center justify-center bg-emerald-500/8 text-muted-foreground">
                  <Icon className="size-5" />
                </div>
                {cardBody?.text && (
                  <p className="px-2 pt-1.5 text-2xs leading-snug text-foreground">
                    {cardBody.text}
                  </p>
                )}
                <div className="flex flex-col gap-1 p-1.5">
                  {(cardButtons?.buttons ?? []).map((b, bi) => (
                    <ButtonChip key={bi} button={b} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function HeaderBlock({
  header,
  value,
  name,
  mediaUrl,
}: {
  header: TemplateComponent;
  value: string;
  name: string | null;
  mediaUrl: string | null;
}) {
  if (header.format === "TEXT") {
    const text = header.text ?? "";
    return (
      <div className="px-3 pt-2.5 text-[14px] font-semibold text-foreground">
        {name
          ? renderNamedPlaceholders(text, [{ name, text: value }])
          : renderPlaceholders(text, [value])}
      </div>
    );
  }

  // A LOCATION header renders as a generic map card. The template itself
  // carries NO coordinates — the pin is supplied per message at send time — so
  // there is nothing here to preview but the shape.
  if (header.format === "LOCATION") {
    return (
      <div className="flex h-28 flex-col items-center justify-center gap-1 border-b border-emerald-500/10 bg-emerald-500/6 text-xs text-muted-foreground">
        <MapPin className="size-5" />
        <span>Map card</span>
        <span className="text-3xs">Pin is set when the message is sent</span>
      </div>
    );
  }

  // Media headers. If we have a real URL (object URL during create), preview
  // it directly; otherwise show a typed placeholder so the agent knows what's
  // going to land in the customer's WhatsApp.
  const fmt = header.format ?? "TEXT";
  if (mediaUrl && fmt === "IMAGE") {
    return <HeaderImage url={mediaUrl} />;
  }
  if (mediaUrl && fmt === "VIDEO") {
    return <HeaderVideo url={mediaUrl} />;
  }
  const Icon =
    fmt === "IMAGE" ? ImageIcon : fmt === "VIDEO" ? Video : FileTextIcon;
  return (
    <div className="flex h-32 items-center justify-center gap-2 border-b border-emerald-500/10 bg-emerald-500/6 text-xs text-muted-foreground">
      <Icon className="size-5" />
      <span>{fmt} header</span>
    </div>
  );
}

// HeaderImage / HeaderVideo: dedicated components so each has its own
// `errored` state. Same SSR-error-recovery pattern as the inbox MediaBlock —
// `complete && naturalWidth === 0` catches loads that finished before React
// attached its onError listener.
function HeaderImage({ url }: { url: string }) {
  const ref = useRef<HTMLImageElement>(null);
  const [errored, setErrored] = useState(false);
  useEffect(() => {
    const img = ref.current;
    if (!img || errored) return;
    if (img.complete && img.naturalWidth === 0) setErrored(true);
  }, [errored, url]);
  if (errored) {
    return (
      <div className="flex h-44 items-center justify-center gap-2 border-b border-emerald-500/10 bg-emerald-500/6 text-xs text-muted-foreground">
        <ImageIcon className="size-5" />
        <span>Image unavailable</span>
      </div>
    );
  }
  return (
    <div className="bg-muted/40">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={ref}
        src={url}
        alt="Header preview"
        onError={() => setErrored(true)}
        loading="lazy"
        decoding="async"
        className="h-44 w-full object-cover"
      />
    </div>
  );
}

function HeaderVideo({ url }: { url: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [errored, setErrored] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || errored) return;
    if (el.error || el.networkState === 3) setErrored(true);
  }, [errored, url]);
  if (errored) {
    return (
      <div className="flex h-44 items-center justify-center gap-2 border-b border-emerald-500/10 bg-emerald-500/6 text-xs text-muted-foreground">
        <Video className="size-5" />
        <span>Video unavailable</span>
      </div>
    );
  }
  return (
    <video
      ref={ref}
      src={url}
      controls
      onError={() => setErrored(true)}
      className="h-44 w-full bg-black object-cover"
    />
  );
}

function ButtonChip({
  button,
}: {
  button: NonNullable<TemplateComponent["buttons"]>[number];
}) {
  const Icon =
    button.type === "URL"
      ? ExternalLink
      : button.type === "PHONE_NUMBER"
        ? Phone
        : button.type === "COPY_CODE"
          ? Copy
          : Reply;
  // A COPY_CODE button carries no `text` — Meta renders its own "Copy offer
  // code" label. Rendering `button.text` produced an EMPTY chip.
  const label = button.type === "COPY_CODE" ? "Copy offer code" : button.text ?? "";
  return (
    <div className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-background px-2 py-2 text-center text-sm font-medium text-primary">
      <Icon className="size-3.5" />
      {label}
    </div>
  );
}

