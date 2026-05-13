"use client";

import { ImageIcon, FileText as FileTextIcon, Video, ExternalLink, Phone, Reply } from "lucide-react";

import type { TemplateComponent } from "@/lib/providers/types";
import { cn } from "@/lib/utils";

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
  className,
}: {
  components: TemplateComponent[];
  bodyValues?: string[];
  headerValue?: string;
  headerMediaUrl?: string | null;
  className?: string;
}) {
  const header = components.find((c) => c.type === "HEADER");
  const body = components.find((c) => c.type === "BODY");
  const footer = components.find((c) => c.type === "FOOTER");
  const buttons = components.find((c) => c.type === "BUTTONS");

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="w-full max-w-sm overflow-hidden rounded-2xl rounded-tl-sm border border-emerald-500/15 bg-emerald-500/[0.04] shadow-sm">
        {header && <HeaderBlock header={header} value={headerValue} mediaUrl={headerMediaUrl ?? null} />}
        <div className="px-3 py-2.5">
          <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-foreground">
            {body?.text
              ? renderPlaceholders(body.text, bodyValues)
              : <span className="text-muted-foreground">No body</span>}
          </p>
          {footer?.text && (
            <p className="mt-1.5 text-[11px] text-muted-foreground">{footer.text}</p>
          )}
        </div>
      </div>

      {buttons?.buttons && buttons.buttons.length > 0 && (
        <div className="flex w-full max-w-sm flex-col gap-1">
          {buttons.buttons.map((b, i) => (
            <ButtonChip key={i} button={b} />
          ))}
        </div>
      )}
    </div>
  );
}

function HeaderBlock({
  header,
  value,
  mediaUrl,
}: {
  header: TemplateComponent;
  value: string;
  mediaUrl: string | null;
}) {
  if (header.format === "TEXT") {
    const text = header.text ?? "";
    return (
      <div className="px-3 pt-2.5 text-[14px] font-semibold text-foreground">
        {renderPlaceholders(text, [value])}
      </div>
    );
  }

  // Media headers. If we have a real URL (object URL during create), preview
  // it directly; otherwise show a typed placeholder so the agent knows what's
  // going to land in the customer's WhatsApp.
  const fmt = header.format ?? "TEXT";
  if (mediaUrl && fmt === "IMAGE") {
    return (
      <div className="bg-muted/40">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={mediaUrl} alt="Header preview" className="h-44 w-full object-cover" />
      </div>
    );
  }
  if (mediaUrl && fmt === "VIDEO") {
    return (
      <video src={mediaUrl} className="h-44 w-full bg-black object-cover" controls />
    );
  }
  const Icon =
    fmt === "IMAGE" ? ImageIcon : fmt === "VIDEO" ? Video : FileTextIcon;
  return (
    <div className="flex h-32 items-center justify-center gap-2 border-b border-emerald-500/10 bg-emerald-500/[0.06] text-[12px] text-muted-foreground">
      <Icon className="size-5" />
      <span>{fmt} header</span>
    </div>
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
        : Reply;
  return (
    <div className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-background px-2 py-2 text-center text-[13px] font-medium text-primary">
      <Icon className="size-3.5" />
      {button.text}
    </div>
  );
}

function renderPlaceholders(text: string, values: string[]): string {
  return text.replace(/\{\{(\d+)\}\}/g, (_match, idxStr) => {
    const idx = Number(idxStr) - 1;
    const v = values[idx];
    return v && v.length > 0 ? v : `{{${idxStr}}}`;
  });
}
