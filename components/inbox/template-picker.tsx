"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  FileText,
  Loader2,
  RefreshCw,
  Search,
  Send,
  Settings as SettingsIcon,
  Sparkles,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { TemplateComponent } from "@/lib/providers/types";
import type { TemplateDto } from "@/lib/types";

/**
 * Template picker — opens above the composer when the agent wants to send
 * a pre-approved template. Two phases:
 *
 *   1) Browse: search + scrollable list of templates with category chips.
 *      Approved templates are sendable; non-approved are listed but
 *      visually muted with a status pill so the agent knows why.
 *
 *   2) Fill: selected template's preview + an input for each `{{N}}`
 *      placeholder. Preview re-renders as the agent types so they see
 *      exactly what the customer will receive.
 *
 * The component is fully presentational — no fetch logic. Parent provides
 * the templates list and the onSend handler so the picker stays reusable.
 */

interface PickerProps {
  open: boolean;
  templates: TemplateDto[];
  loading: boolean;
  error: string | null;
  syncing: boolean;
  /** True when WABA id isn't configured — picker shows a setup nudge. */
  wabaMissing: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onSend: (args: {
    template: TemplateDto;
    variables: { body: string[]; header?: string };
  }) => Promise<{ ok: boolean; error?: string }>;
}

export function TemplatePicker(props: PickerProps) {
  const { open, onClose } = props;

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Scrim so a click off the panel dismisses without stealing focus
              from the composer. Pointer-events stays on the panel only. */}
          <motion.div
            key="scrim"
            className="absolute inset-0 z-10 bg-background/40 backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
          />
          <motion.div
            key="panel"
            className="absolute inset-x-0 bottom-0 z-20 mx-auto w-full max-w-3xl px-4 pb-4"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ type: "spring", duration: 0.32, bounce: 0.18 }}
          >
            <PickerPanel {...props} />
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function PickerPanel(props: PickerProps) {
  const {
    templates,
    loading,
    error,
    syncing,
    wabaMissing,
    onClose,
    onRefresh,
    onSend,
  } = props;
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const selected = useMemo(
    () => templates.find((t) => t.id === selectedId) ?? null,
    [templates, selectedId],
  );

  // Filter: approved first, matching name/body/category, sorted within group.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter((t) => {
      return (
        t.name.toLowerCase().includes(q) ||
        t.bodyText.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q) ||
        t.language.toLowerCase().includes(q)
      );
    });
  }, [templates, query]);

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-popover shadow-2xl">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-3">
        {selected ? (
          <button
            type="button"
            onClick={() => {
              setSelectedId(null);
              setSendError(null);
            }}
            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Back to templates list"
          >
            <ArrowLeft className="size-4" />
          </button>
        ) : (
          <div className="inline-flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Sparkles className="size-3.5" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">
            {selected ? selected.name : "Send a template"}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {selected
              ? `${selected.language} · ${labelCategory(selected.category)}`
              : "Pre-approved messages — required outside the 24h window."}
          </div>
        </div>
        {!selected && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={onRefresh}
            disabled={syncing || wabaMissing}
            title={
              wabaMissing
                ? "Add your WABA id in Settings → WhatsApp first"
                : "Re-fetch the latest templates from Meta"
            }
          >
            {syncing ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            <span>Refresh</span>
          </Button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Close template picker"
        >
          <X className="size-4" />
        </button>
      </div>

      {wabaMissing && !selected ? (
        <WabaMissingState />
      ) : selected ? (
        <TemplateFillView
          template={selected}
          sending={sending}
          sendError={sendError}
          onSubmit={async (variables) => {
            setSendError(null);
            setSending(true);
            const result = await onSend({ template: selected, variables });
            setSending(false);
            if (!result.ok) {
              setSendError(result.error ?? "Send failed");
              return;
            }
            setSelectedId(null);
            onClose();
          }}
        />
      ) : (
        <TemplateListView
          loading={loading}
          error={error}
          query={query}
          onQueryChange={setQuery}
          templates={filtered}
          onSelect={(id) => setSelectedId(id)}
        />
      )}
    </div>
  );
}

function TemplateListView({
  loading,
  error,
  query,
  onQueryChange,
  templates,
  onSelect,
}: {
  loading: boolean;
  error: string | null;
  query: string;
  onQueryChange: (q: string) => void;
  templates: TemplateDto[];
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex max-h-[480px] flex-col">
      <div className="border-b border-border px-3 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search by name, language, or body…"
            className="h-9 pl-8"
            autoFocus
          />
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center gap-2 px-4 py-12 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span>Loading templates…</span>
          </div>
        ) : templates.length === 0 ? (
          <EmptyState query={query} />
        ) : (
          <ul className="divide-y divide-border">
            {templates.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => t.status === "approved" && onSelect(t.id)}
                  disabled={t.status !== "approved"}
                  className={cn(
                    "group flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left transition-colors",
                    "hover:bg-accent/60 focus:bg-accent/60 focus:outline-none",
                    t.status !== "approved" && "cursor-not-allowed opacity-60 hover:bg-transparent",
                  )}
                >
                  <div className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/8 text-primary">
                    <FileText className="size-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{t.name}</span>
                      <CategoryPill category={t.category} />
                      <span className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {t.language}
                      </span>
                      {t.status !== "approved" && <StatusPill status={t.status} />}
                    </div>
                    <p className="mt-1 line-clamp-2 text-[12px] leading-snug text-muted-foreground">
                      {t.bodyText || "—"}
                    </p>
                  </div>
                  {t.status === "approved" && (
                    <ChevronRight className="mt-2 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function EmptyState({ query }: { query: string }) {
  if (query.trim().length > 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-1 px-4 py-12 text-center">
        <Search className="size-5 text-muted-foreground" />
        <div className="text-sm font-medium">No templates match “{query}”.</div>
        <div className="text-[11px] text-muted-foreground">
          Try a different name or language.
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <FileText className="size-5 text-muted-foreground" />
      <div className="text-sm font-medium">No templates yet</div>
      <p className="max-w-md text-[12px] leading-relaxed text-muted-foreground">
        Submit templates for review in WhatsApp Manager. Once Meta approves
        them, click <span className="font-medium">Refresh</span> to load them
        here.
      </p>
      <a
        className="mt-1 text-[12px] font-medium text-primary hover:underline"
        href="https://business.facebook.com/wa/manage/message-templates"
        target="_blank"
        rel="noreferrer"
      >
        Open WhatsApp Manager →
      </a>
    </div>
  );
}

function WabaMissingState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <div className="inline-flex size-10 items-center justify-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
        <SettingsIcon className="size-5" />
      </div>
      <div className="text-sm font-medium">WhatsApp Business Account ID needed</div>
      <p className="max-w-md text-[12px] leading-relaxed text-muted-foreground">
        Templates live on your WABA, not your phone number. Paste your WABA ID
        in Settings → WhatsApp to load and send approved templates.
      </p>
      <Button asChild variant="outline" size="sm" className="mt-1 h-8">
        <a href="/settings/whatsapp">Open settings</a>
      </Button>
    </div>
  );
}

function TemplateFillView({
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
      className="flex max-h-[520px] flex-col"
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
          <span className="break-words">{sendError}</span>
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
    <div className="rounded-lg border border-border bg-card p-3 shadow-sm">
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

function CategoryPill({ category }: { category: string }) {
  const tone =
    category === "marketing"
      ? "border-pink-500/30 bg-pink-500/10 text-pink-700 dark:text-pink-300"
      : category === "utility"
        ? "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
        : "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300";
  return (
    <span
      className={cn(
        "rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        tone,
      )}
    >
      {labelCategory(category)}
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "pending"
      ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
      : status === "rejected"
        ? "border-destructive/30 bg-destructive/10 text-destructive"
        : "border-border bg-muted/40 text-muted-foreground";
  return (
    <span
      className={cn(
        "rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase",
        tone,
      )}
    >
      {status}
    </span>
  );
}

function labelCategory(c: string): string {
  switch (c) {
    case "marketing":
      return "Marketing";
    case "utility":
      return "Utility";
    case "authentication":
      return "Auth";
    default:
      return c;
  }
}

function countPlaceholders(text: string): number {
  let max = 0;
  const re = /\{\{(\d+)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

function renderPlaceholders(text: string, vars: string[]): string {
  return text.replace(/\{\{(\d+)\}\}/g, (_match, idxStr) => {
    const idx = Number(idxStr) - 1;
    const v = vars[idx];
    return v && v.length > 0 ? v : `{{${idxStr}}}`;
  });
}

function firstEmptyIndex(values: string[]): number {
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (!v || v.length === 0) return i;
  }
  return 0;
}

function extractExample(arr: string[] | undefined, i: number): string | undefined {
  if (!arr) return undefined;
  const v = arr[i];
  return v && v.length > 0 ? v : undefined;
}
