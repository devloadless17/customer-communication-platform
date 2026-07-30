"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, MousePointerClick, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client-fetch";
import { emitOptimisticListBump } from "@/features/inbox/lib/optimistic-list-bump";
import { useFocusTrap } from "@/hooks/use-modal-overlay";

/**
 * Inbox-side composer for interactive messages (buttons / location request /
 * link button). Which modes appear is driven entirely by the channel's
 * capabilities, so Instagram gets the buttons + link-button modes and WhatsApp
 * gets all three — no channel name is read here.
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

/**
 * One card of Meta's generic template, as the composer holds it.
 *
 * Buttons here are LINK buttons only. The wire also allows `postback`, but a
 * postback is an author-assigned id that means something to a workflow — it is
 * not something an agent invents mid-conversation, and a card whose button does
 * nothing visible would be worse than no button. Workflows and `/v1` can still
 * send postback cards; the ad-hoc composer offers the one an agent can reason
 * about.
 */
interface CardDraft {
  title: string;
  subtitle?: string;
  imageUrl?: string;
  buttons: Array<{ title: string; url: string }>;
}

/** Meta's caps: "A maximum of 10 elements" and "3 buttons per element". */
const MAX_CARDS = 10;
const MAX_CARD_BUTTONS = 3;

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
  /** Channel capability `locationRequest` — shows the "Request location" mode
   *  (WhatsApp's interactive location_request_message). */
  allowLocationRequest?: boolean;
  /** Channel capability `ctaUrlButton` — shows the "Link button" mode: one
   *  URL-opening button (WhatsApp `interactive.type:"cta_url"`, Instagram's
   *  button template). */
  allowCtaUrl?: boolean;
  /** Channel capability `genericTemplate` — shows the "Cards" mode: Meta's
   *  generic template, 1-10 image/title/subtitle/button cards. */
  allowCards?: boolean;
  /** Channel capability `templateTextMaxChars` — the tighter text ceiling a
   *  STRUCTURED template carries on this channel (Instagram: 640 vs its 1,000
   *  plain-text limit). Applied to the body only in link-button mode, so the
   *  agent is stopped at the real limit instead of being rejected on send. */
  templateTextMax?: number;
}

export function InteractivePopover({
  open,
  onClose,
  conversationId,
  initialBody,
  onSent,
  allowLocationRequest = false,
  allowCtaUrl = false,
  allowCards = false,
  templateTextMax,
}: Props) {
  const [body, setBody] = useState("");
  // "buttons" = agent-authored quick replies; "location_request" = WhatsApp's
  // own "send location" button (reply arrives as a normal location pin);
  // "cta_url" = one URL-opening button so the raw link stays out of the body.
  const [mode, setMode] = useState<"buttons" | "location_request" | "cta_url" | "generic">(
    "buttons",
  );
  // Meta's caps for the generic template: 1-10 cards, ≤3 buttons each.
  const [cards, setCards] = useState<CardDraft[]>([{ title: "", buttons: [] }]);
  const [ctaLabel, setCtaLabel] = useState("");
  const [ctaUrl, setCtaUrl] = useState("");
  const [options, setOptions] = useState<ButtonOption[]>([
    { id: "yes", title: "Yes" },
    { id: "no", title: "No" },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Reset state on open. Pre-fill the body from the composer so the agent
  // doesn't have to retype what they already wrote. Reset the buttons too so a
  // prior send's customized options don't persist into the next open.
  useEffect(() => {
    if (open) {
      setBody(initialBody);
      setMode("buttons");
      setCtaLabel("");
      setCtaUrl("");
      setOptions([
        { id: "yes", title: "Yes" },
        { id: "no", title: "No" },
      ]);
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
    // Unique id: `opt_N` keyed off a monotonic max over existing numeric
    // suffixes, not `options.length + 1` — the latter mints a duplicate after
    // a remove (delete opt_1 of [opt_1,opt_2] → length 1 → "opt_2" again),
    // which trips idsUnique and dead-ends Send (mirrors the workflow fix in
    // step-editors.tsx addOption).
    let maxN = 0;
    for (const o of options) {
      const m = /^opt_(\d+)$/.exec(o.id);
      if (m) maxN = Math.max(maxN, Number.parseInt(m[1]!, 10));
    }
    setOptions([...options, { id: `opt_${maxN + 1}`, title: "" }]);
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
      ? "Button titles must be unique — Meta rejects duplicates."
      : null;

  const locationMode = mode === "location_request";
  const ctaMode = mode === "cta_url";
  const cardsMode = mode === "generic";
  // Meta requires a card to carry something BEYOND its title, or it renders
  // empty — the same rule the server schema refines, checked here so the agent
  // is stopped at the keyboard rather than by a 422.
  const cardsValid =
    cards.length >= 1 &&
    cards.length <= MAX_CARDS &&
    cards.every(
      (c) =>
        c.title.trim().length > 0 &&
        (c.subtitle?.trim() || c.imageUrl?.trim() || c.buttons.length > 0) &&
        c.buttons.every(
          (b) => b.title.trim().length > 0 && /^https?:\/\/\S+$/i.test(b.url.trim()),
        ),
    );
  const ctaUrlValid = /^https?:\/\/\S+$/i.test(ctaUrl.trim());
  const canSend =
    (cardsMode || body.trim().length > 0) &&
    !busy &&
    (cardsMode
      ? cardsValid
      : locationMode ||
      (ctaMode
        ? ctaLabel.trim().length > 0 && ctaUrlValid
        : options.length >= 1 &&
          titles.every((t) => t.length > 0) &&
          ids.every((id) => id.length > 0) &&
          idsUnique &&
          titlesUnique));

  async function send() {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    // Idempotency key — the server's SendInteractiveSchema + runWithSendIdempotency
    // dedupe on this, so a network-retry or fast double-submit can't deliver the
    // interactive message to the customer twice. text/media/template already send
    // one; interactive was the gap (the busy flag alone doesn't cover a retry).
    const clientTempId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `tmp_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    try {
      const res = await apiFetch("/api/messages/interactive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId,
          clientTempId,
          // The generic template has no body of its own — each card is the
          // content — but the send path stores a message body for the list
          // preview, so give it the first card's title rather than "".
          body: cardsMode ? (cards[0]?.title.trim() ?? "Cards") : body.trim(),
          kind: locationMode
            ? "location_request"
            : ctaMode
              ? "cta_url"
              : cardsMode
                ? "generic"
                : "buttons",
          // location_request / cta_url carry no options — WhatsApp renders the button.
          options:
            locationMode || ctaMode || cardsMode
              ? []
              : options.map((o) => ({ id: o.id.trim(), title: o.title.trim() })),
          ...(cardsMode
            ? {
                // Trimmed and pruned here so an empty optional never reaches the
                // wire as `""` — Meta treats a present-but-blank subtitle as
                // content and renders a gap.
                genericCards: cards.map((c) => ({
                  title: c.title.trim(),
                  ...(c.subtitle?.trim() ? { subtitle: c.subtitle.trim() } : {}),
                  ...(c.imageUrl?.trim() ? { imageUrl: c.imageUrl.trim() } : {}),
                  ...(c.buttons.length > 0
                    ? {
                        buttons: c.buttons.map((b) => ({
                          type: "web_url" as const,
                          title: b.title.trim(),
                          url: b.url.trim(),
                        })),
                      }
                    : {}),
                })),
              }
            : {}),
          ...(ctaMode
            ? { ctaUrl: { displayText: ctaLabel.trim(), url: ctaUrl.trim() } }
            : {}),
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
      aria-label={
        locationMode
          ? "Request location"
          : ctaMode
            ? "Send link button"
            : cardsMode
              ? "Send cards"
              : "Send buttons"
      }
      tabIndex={-1}
      // left-0 (opens to the RIGHT): the trigger is a LEFT-side composer-toolbar
      // icon, so right-0 anchored the 320px panel to the button's right edge and
      // it spilled off-screen to the LEFT. max-w cap keeps it inside a narrow
      // viewport. bottom-… opens it above the toolbar.
      className="absolute bottom-[calc(100%+8px)] left-0 z-40 w-80 max-w-[calc(100vw-1.5rem)] rounded-xl border border-border bg-popover p-3 shadow-xl focus:outline-none animate-slide-up"
    >
      <div className="mb-2 flex items-center gap-2">
        <MousePointerClick className="size-4 text-info-fg" />
        <div className="text-sm font-semibold">
          {locationMode
            ? "Request location"
            : ctaMode
              ? "Send a link button"
              : cardsMode
                ? "Send cards"
                : "Send with buttons"}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="ml-auto inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {(allowLocationRequest || allowCtaUrl) && (
        <div
          role="radiogroup"
          aria-label="Interactive message kind"
          className="mb-2 flex gap-1 rounded-lg bg-muted p-0.5"
        >
          {(
            [
              ["buttons", "Buttons"] as const,
              ...(allowLocationRequest
                ? [["location_request", "Location"] as const]
                : []),
              ...(allowCtaUrl ? [["cta_url", "Link button"] as const] : []),
              ...(allowCards ? [["generic", "Cards"] as const] : []),
            ] as ReadonlyArray<readonly [string, string]>
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              onClick={() => setMode(value as typeof mode)}
              className={`flex-1 rounded-md px-2 py-1 text-2xs font-medium transition-colors ${
                mode === value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* The generic template carries NO body text — each card is the content —
          so the question box would be a field the send silently discards. */}
      <label className={cardsMode ? "hidden" : "mb-2 flex flex-col gap-1"}>
        <span className="text-xs font-medium text-muted-foreground">Question</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={2}
          maxLength={ctaMode && templateTextMax ? templateTextMax : 1024}
          placeholder="Want a callback?"
          className="min-h-15 resize-y rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </label>

      {locationMode && (
        // No authored options in this mode — WhatsApp draws its own
        // "Send location" button; the customer's pick lands in the thread as
        // a normal location pin.
        <p className="mb-2 rounded-md bg-muted/40 px-2 py-1.5 text-2xs text-muted-foreground">
          WhatsApp shows a <strong>Send location</strong> button under your
          message. The customer&apos;s location arrives as a map pin in this
          conversation.
        </p>
      )}

      {ctaMode && (
        <div className="mb-2 flex flex-col gap-1.5">
          <Input
            value={ctaLabel}
            onChange={(e) => setCtaLabel(e.target.value)}
            placeholder="Button label (max 20)"
            maxLength={20}
            className="text-xs"
            aria-label="Link button label"
          />
          <Input
            value={ctaUrl}
            onChange={(e) => setCtaUrl(e.target.value)}
            placeholder="https://…"
            type="url"
            className="text-xs"
            aria-label="Link button URL"
          />
          {ctaUrl.trim().length > 0 && !ctaUrlValid && (
            <p className="text-2xs text-warning-fg">
              The link must start with http:// or https://.
            </p>
          )}
        </div>
      )}

      {cardsMode && (
        <div className="mb-2 flex max-h-72 flex-col gap-2 overflow-y-auto">
          {cards.map((card, i) => (
            <div key={i} className="flex flex-col gap-1.5 rounded-lg border border-border p-2">
              <div className="flex items-center justify-between">
                <span className="text-2xs font-medium text-muted-foreground">
                  Card {i + 1}
                </span>
                {cards.length > 1 && (
                  <button
                    type="button"
                    aria-label={`Remove card ${i + 1}`}
                    onClick={() => setCards((p) => p.filter((_, j) => j !== i))}
                    className="text-2xs text-muted-foreground hover:text-destructive-fg"
                  >
                    Remove
                  </button>
                )}
              </div>
              <Input
                value={card.title}
                onChange={(e) =>
                  setCards((p) => p.map((c, j) => (j === i ? { ...c, title: e.target.value } : c)))
                }
                placeholder="Title"
                maxLength={80}
                className="text-xs"
                aria-label={`Card ${i + 1} title`}
              />
              <Input
                value={card.subtitle ?? ""}
                onChange={(e) =>
                  setCards((p) =>
                    p.map((c, j) => (j === i ? { ...c, subtitle: e.target.value } : c)),
                  )
                }
                placeholder="Subtitle (optional)"
                maxLength={80}
                className="text-xs"
                aria-label={`Card ${i + 1} subtitle`}
              />
              <Input
                value={card.imageUrl ?? ""}
                onChange={(e) =>
                  setCards((p) =>
                    p.map((c, j) => (j === i ? { ...c, imageUrl: e.target.value } : c)),
                  )
                }
                placeholder="Image URL (optional)"
                className="text-xs"
                aria-label={`Card ${i + 1} image URL`}
              />
              {card.buttons.map((b, bi) => (
                <div key={bi} className="flex items-center gap-1.5">
                  <Input
                    value={b.title}
                    onChange={(e) =>
                      setCards((p) =>
                        p.map((c, j) =>
                          j === i
                            ? {
                                ...c,
                                buttons: c.buttons.map((x, k) =>
                                  k === bi ? { ...x, title: e.target.value } : x,
                                ),
                              }
                            : c,
                        ),
                      )
                    }
                    placeholder="Button"
                    maxLength={20}
                    className="text-xs"
                    aria-label={`Card ${i + 1} button ${bi + 1} label`}
                  />
                  <Input
                    value={b.url}
                    onChange={(e) =>
                      setCards((p) =>
                        p.map((c, j) =>
                          j === i
                            ? {
                                ...c,
                                buttons: c.buttons.map((x, k) =>
                                  k === bi ? { ...x, url: e.target.value } : x,
                                ),
                              }
                            : c,
                        ),
                      )
                    }
                    placeholder="https://…"
                    className="text-xs"
                    aria-label={`Card ${i + 1} button ${bi + 1} URL`}
                  />
                  <button
                    type="button"
                    aria-label={`Remove card ${i + 1} button ${bi + 1}`}
                    onClick={() =>
                      setCards((p) =>
                        p.map((c, j) =>
                          j === i
                            ? { ...c, buttons: c.buttons.filter((_, k) => k !== bi) }
                            : c,
                        ),
                      )
                    }
                    className="shrink-0 text-2xs text-muted-foreground hover:text-destructive-fg"
                  >
                    ×
                  </button>
                </div>
              ))}
              {card.buttons.length < MAX_CARD_BUTTONS && (
                <button
                  type="button"
                  onClick={() =>
                    setCards((p) =>
                      p.map((c, j) =>
                        j === i ? { ...c, buttons: [...c.buttons, { title: "", url: "" }] } : c,
                      ),
                    )
                  }
                  className="self-start text-2xs font-medium text-primary hover:underline"
                >
                  + Link button
                </button>
              )}
            </div>
          ))}
          {cards.length < MAX_CARDS && (
            <button
              type="button"
              onClick={() => setCards((p) => [...p, { title: "", buttons: [] }])}
              className="self-start text-2xs font-medium text-primary hover:underline"
            >
              + Add card ({cards.length}/{MAX_CARDS})
            </button>
          )}
        </div>
      )}

      <div className={locationMode || ctaMode || cardsMode ? "hidden" : "mb-2 flex flex-col gap-1.5"}>
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
              <X className="size-3.5" />
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

      {!error && !locationMode && validationHint && (
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
