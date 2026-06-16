"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, MousePointerClick, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client-fetch";
import { emitOptimisticListBump } from "@/features/inbox/lib/optimistic-list-bump";
import { useFocusTrap } from "@/hooks/use-modal-overlay";

/**
 * Inbox-side composer for WhatsApp interactive messages (buttons).
 *
 * Triggered from the reply-box toolbar. Pre-fills the body from the
 * composer's current text; the agent adds 1-3 buttons (id + title) and
 * sends. POSTs to /api/messages/interactive (synchronous — interactive
 * sends are rare admin actions, no queue scaffolding needed).
 *
 * Scope decisions:
 *   - Buttons-only for the inbox composer. List support is on the
 *     workflow side; for agent ad-hoc messages 3-button quick replies
 *     cover the common case ("schedule now / later / never").
 *   - On success, the parent reply-box clears the composer. The new
 *     message bubble appears via the same `message.sent` socket event
 *     that text sends use (sendInteractiveInternal publishes it).
 */

interface ButtonOption {
  id: string;
  title: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  conversationId: string;
  /** Pre-fill body from the composer's current value. */
  initialBody: string;
  /** Called on successful send. The parent clears its composer. */
  onSent: () => void;
}

export function InteractivePopover({
  open,
  onClose,
  conversationId,
  initialBody,
  onSent,
}: Props) {
  const [body, setBody] = useState("");
  const [options, setOptions] = useState<ButtonOption[]>([
    { id: "yes", title: "Yes" },
    { id: "no", title: "No" },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Reset state on open. Pre-fill the body from the composer so the agent
  // doesn't have to retype what they already wrote.
  useEffect(() => {
    if (open) {
      setBody(initialBody);
      setError(null);
    }
  }, [open, initialBody]);

  // Focus trap + Escape-to-close + focus enter/return. Replaces the prior
  // hand-rolled Escape listener — useFocusTrap moves focus INTO the popover
  // on open, traps Tab inside it, and returns focus to the opener on close
  // (role="dialog" was a lie without this). Outside-click stays below.
  useFocusTrap(wrapperRef, open, onClose);

  // Outside-click close. Same idiom as the template picker. (Escape + Tab
  // trapping now live in useFocusTrap above.)
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) onClose();
    }
    const t = window.setTimeout(() => {
      window.addEventListener("mousedown", onDocClick);
    }, 0);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("mousedown", onDocClick);
    };
  }, [open, onClose]);

  function setOption(idx: number, patch: Partial<ButtonOption>) {
    const next = [...options];
    next[idx] = { ...next[idx]!, ...patch };
    setOptions(next);
  }
  function addOption() {
    if (options.length >= 3) return;
    setOptions([...options, { id: `opt_${options.length + 1}`, title: "" }]);
  }
  function removeOption(idx: number) {
    setOptions(options.filter((_, i) => i !== idx));
  }

  const ids = options.map((o) => o.id.trim());
  const titles = options.map((o) => o.title.trim());
  const idsUnique = new Set(ids).size === ids.length;
  // Case-insensitive so "Yes"/"yes" are caught — Meta rejects duplicate
  // titles (error 131009 "Duplicate button title") and two near-identical
  // titles are confusing for the recipient regardless.
  const titlesUnique =
    new Set(titles.map((t) => t.toLowerCase())).size === titles.length;

  // Surfaced as a hint so a disabled Send button always has a visible reason.
  const validationHint = !idsUnique
    ? "Button IDs must be unique."
    : !titlesUnique
      ? "Button titles must be unique — WhatsApp rejects duplicates."
      : null;

  const canSend =
    body.trim().length > 0 &&
    options.length >= 1 &&
    titles.every((t) => t.length > 0) &&
    ids.every((id) => id.length > 0) &&
    idsUnique &&
    titlesUnique &&
    !busy;

  async function send() {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    // Idempotency key — the server's SendInteractiveSchema + runWithSendIdempotency
    // dedupe on this, so a network-retry or fast double-submit can't deliver the
    // interactive message to the customer twice. text/media/template already send
    // one; interactive was the gap (the busy flag alone doesn't cover a retry).
    const clientTempId = crypto.randomUUID();
    try {
      const res = await apiFetch("/api/messages/interactive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId,
          clientTempId,
          body: body.trim(),
          kind: "buttons",
          options: options.map((o) => ({ id: o.id.trim(), title: o.title.trim() })),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          detail?: string;
          message?: string;
        };
        const msg =
          data.detail ||
          data.message ||
          data.error ||
          `Send failed (HTTP ${res.status})`;
        setError(msg);
        return;
      }
      // Bump the list on success — the interactive send is synchronous and
      // paints no optimistic bubble, so this keeps the sidebar row fresh even
      // if the socket misses the server `message:new`. Preview matches what the
      // server stores (the body text, sliced to 200).
      emitOptimisticListBump({
        conversationId,
        preview: body.trim().slice(0, 200),
        lastMessageAt: new Date().toISOString(),
      });
      onSent();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  return (
    <div
      ref={wrapperRef}
      role="dialog"
      aria-modal="true"
      aria-label="Send buttons"
      tabIndex={-1}
      className="absolute bottom-[calc(100%+8px)] right-0 z-30 w-80 rounded-lg border border-border bg-popover p-3 shadow-xl focus:outline-none"
    >
      <div className="mb-2 flex items-center gap-2">
        <MousePointerClick className="size-4 text-violet-600" />
        <div className="text-sm font-semibold">Send with buttons</div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="ml-auto inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <label className="mb-2 flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Question</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={2}
          maxLength={1024}
          placeholder="Want a callback?"
          className="min-h-15 resize-y rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </label>

      <div className="mb-2 flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">
            Buttons (1–3)
          </span>
        </div>
        {options.map((opt, idx) => (
          <div key={idx} className="flex items-center gap-1.5">
            <Input
              value={opt.id}
              onChange={(e) => setOption(idx, { id: e.target.value })}
              placeholder="id"
              className="max-w-20 font-mono text-2xs"
              aria-label={`Button ${idx + 1} id`}
            />
            <Input
              value={opt.title}
              onChange={(e) => setOption(idx, { title: e.target.value })}
              placeholder="Title (max 20)"
              maxLength={20}
              className="flex-1 text-xs"
              aria-label={`Button ${idx + 1} title`}
            />
            <button
              type="button"
              onClick={() => removeOption(idx)}
              disabled={options.length <= 1}
              className="inline-flex size-7 pointer-coarse:size-9 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-30"
              aria-label={`Remove button ${idx + 1}`}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addOption}
          disabled={options.length >= 3}
          className="inline-flex w-fit items-center gap-1 rounded-md border border-dashed border-border px-2 py-0.5 text-2xs text-muted-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          + Add button
        </button>
      </div>

      {error && (
        <div className="mb-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-2xs text-destructive">
          {error}
        </div>
      )}

      {!error && validationHint && (
        <div className="mb-2 rounded border border-warning-border bg-warning-bg px-2 py-1 text-2xs text-warning-fg">
          {validationHint}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void send()} disabled={!canSend}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Send
        </Button>
      </div>
    </div>
  );
}
