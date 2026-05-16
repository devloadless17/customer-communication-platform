"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { TemplateComponent } from "@/lib/providers/types";
import type { TemplateDto } from "@/lib/types";

import {
  countPlaceholders,
  extractExample,
  firstEmptyIndex,
  renderPlaceholders,
} from "./utils";

export function TemplateFillView({
  template,
  sending,
  sendError,
  onSubmit,
}: {
  template: TemplateDto;
  sending: boolean;
  sendError: string | null;
  onSubmit: (vars: { body: string[]; header?: string }) => Promise<void>;
}) {
  // The DTO carries `components: unknown[]` to keep the boundary loose;
  // narrow once here so the rest of the component sees a real shape.
  const components = (
    Array.isArray(template.components) ? template.components : []
  ) as TemplateComponent[];
  const headerComp = components.find((c) => c.type === "HEADER");
  const footerComp = components.find((c) => c.type === "FOOTER");
  const buttonsComp = components.find((c) => c.type === "BUTTONS");

  const bodyVarCount = countPlaceholders(template.bodyText);
  const headerVarCount =
    headerComp?.format === "TEXT" && headerComp.text
      ? countPlaceholders(headerComp.text)
      : 0;

  const [bodyVars, setBodyVars] = useState<string[]>(() =>
    Array.from({ length: bodyVarCount }, () => ""),
  );
  const [headerVar, setHeaderVar] = useState("");

  // Reset whenever the template changes — agents pick template A, back out,
  // pick template B; we don't want B's slots prefilled with A's values.
  useEffect(() => {
    setBodyVars(Array.from({ length: bodyVarCount }, () => ""));
    setHeaderVar("");
  }, [template.id, bodyVarCount]);

  const firstEmptyRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    firstEmptyRef.current?.focus();
  }, [template.id]);

  const allFilled =
    bodyVars.every((v) => v.trim().length > 0) &&
    (headerVarCount === 0 || headerVar.trim().length > 0);

  return (
    <form
      className="flex max-h-130 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        if (!allFilled || sending) return;
        void onSubmit({
          body: bodyVars,
          ...(headerVarCount > 0 ? { header: headerVar } : {}),
        });
      }}
    >
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {/* Variables form */}
        {bodyVarCount + headerVarCount > 0 ? (
          <div className="flex flex-col gap-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Fill the placeholders
            </div>
            {headerVarCount > 0 && (
              <VarField
                label="Header {{1}}"
                value={headerVar}
                onChange={setHeaderVar}
                placeholder={extractExample(headerComp?.example?.header_text, 0)}
                inputRef={headerVar.length === 0 ? firstEmptyRef : undefined}
              />
            )}
            {bodyVars.map((v, i) => (
              <VarField
                key={i}
                label={`Body {{${i + 1}}}`}
                value={v}
                onChange={(next) => {
                  setBodyVars((cur) => {
                    const copy = cur.slice();
                    copy[i] = next;
                    return copy;
                  });
                }}
                placeholder={extractExample(headerComp?.example?.body_text?.[0], i)}
                inputRef={
                  headerVarCount === 0 && i === firstEmptyIndex(bodyVars)
                    ? firstEmptyRef
                    : undefined
                }
              />
            ))}
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
            This template has no variables — it&apos;ll send as-is.
          </div>
        )}

        {/* Preview */}
        <div className="mt-5">
          <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <span>Preview</span>
            <span className="h-px flex-1 bg-border" />
          </div>
          <PreviewBubble
            headerComp={headerComp}
            headerValue={headerVar}
            bodyText={template.bodyText}
            bodyVars={bodyVars}
            footerComp={footerComp}
            buttonsComp={buttonsComp}
          />
        </div>
      </div>

      {sendError && (
        <div className="flex items-start gap-2 border-t border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="wrap-break-word">{sendError}</span>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-border bg-muted/20 px-4 py-3">
        <div className="text-[11px] text-muted-foreground">
          <Check className="mr-1 inline size-3 text-emerald-500" />
          Sending opens a fresh 24h window after the customer replies.
        </div>
        <Button
          type="submit"
          size="sm"
          disabled={!allFilled || sending}
          className="h-8 gap-1.5"
        >
          {sending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Send className="size-3.5" />
          )}
          {sending ? "Sending…" : "Send template"}
        </Button>
      </div>
    </form>
  );
}

function VarField({
  label,
  value,
  onChange,
  placeholder,
  inputRef,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[11px] font-medium text-foreground">
        {label}
      </span>
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ? `e.g. ${placeholder}` : "Type a value…"}
        className="h-9 text-sm"
      />
    </label>
  );
}

function PreviewBubble({
  headerComp,
  headerValue,
  bodyText,
  bodyVars,
  footerComp,
  buttonsComp,
}: {
  headerComp: TemplateComponent | undefined;
  headerValue: string;
  bodyText: string;
  bodyVars: string[];
  footerComp: TemplateComponent | undefined;
  buttonsComp: TemplateComponent | undefined;
}) {
  const renderedBody = renderPlaceholders(bodyText, bodyVars);
  const renderedHeader =
    headerComp?.format === "TEXT" && headerComp.text
      ? renderPlaceholders(headerComp.text, [headerValue])
      : null;

  return (
    <div className="rounded-lg border border-border bg-card p-3 shadow-xs">
      <div className="rounded-md bg-emerald-500/5 p-3 ring-1 ring-emerald-500/10">
        {/* Header */}
        {headerComp?.format === "TEXT" && renderedHeader && (
          <div className="mb-1 text-sm font-semibold text-foreground">
            {renderedHeader}
          </div>
        )}
        {headerComp && headerComp.format !== "TEXT" && (
          <div className="mb-2 flex h-20 items-center justify-center rounded-md border border-dashed border-emerald-500/30 bg-emerald-500/5 text-[11px] text-muted-foreground">
            {headerComp.format ?? "MEDIA"} header
          </div>
        )}

        {/* Body */}
        <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
          {renderedBody || (
            <span className="text-muted-foreground">No body</span>
          )}
        </div>

        {/* Footer */}
        {footerComp?.text && (
          <div className="mt-2 text-[11px] text-muted-foreground">
            {footerComp.text}
          </div>
        )}
      </div>

      {/* Buttons */}
      {buttonsComp?.buttons && buttonsComp.buttons.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {buttonsComp.buttons.map((b, i) => (
            <div
              key={i}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-center text-[12px] font-medium text-primary"
            >
              {b.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
