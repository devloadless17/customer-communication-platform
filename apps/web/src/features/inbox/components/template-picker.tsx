"use client";

import { useMemo, useRef, useState } from "react";

import { useModalOverlay } from "@/hooks/use-modal-overlay";
import {
  ArrowLeft,
  Loader2,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

import { Button } from "@/components/ui/button";
import type { TemplateDto } from "@ccp/shared/types";

import { TemplateFillView } from "./template-picker/fill-view";
import { TemplateListView } from "./template-picker/list-view";
import { labelCategory } from "./template-picker/utils";
import { WabaMissingState } from "./template-picker/waba-missing";

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
  const panelRef = useRef<HTMLDivElement>(null);

  // Body-scroll-lock + focus-trap + Escape — shared overlay primitives.
  useModalOverlay(panelRef, true, onClose);

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
    <div
      ref={panelRef}
      className="overflow-hidden rounded-xl border border-border bg-popover shadow-2xl"
    >
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
