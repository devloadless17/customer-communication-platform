"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MessageSquare,
  Mic,
  Paperclip,
  Send,
  Smile,
  Sparkles,
  StickyNote,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type {
  Contact,
  MediaKind,
  Message,
  ReplySnapshot,
  SnippetItem,
  TemplateDto,
  User,
} from "@/lib/types";
import { computeWindowStatus } from "@/lib/window";
import { resolveFieldTokens } from "@/lib/field-tokens";

import { WindowBadgeFromStatus } from "./window-badge";
import { TemplatePicker } from "./template-picker";
import { SnippetPopup } from "./snippet-popup";
import { useSnippets } from "./snippets-context";

import { AttachmentPreview } from "./reply-box/attachment-preview";
import { ReplyTargetPill } from "./reply-box/reply-target-pill";
import { ToggleButton } from "./reply-box/toggle-button";
import {
  detectSlashQuery,
  kindFromMimeClient,
  newClientTempId,
  safeReadError,
} from "./reply-box/utils";

type Mode = "reply" | "note";

/**
 * Reply composer with Reply/Note toggle and media attachments.
 *
 *   Reply (text)  → POST /api/messages       → provider.sendText
 *   Reply (media) → POST /api/messages/media → provider.uploadMedia + sendMedia
 *   Note          → POST /api/notes          → DB only (no WhatsApp call)
 *
 * The thread updates via the same Socket.io event the server fires; we
 * don't optimistic-update here.
 */
export function ReplyBox({
  conversationId,
  currentUser,
  contact,
  lastInboundAt,
  replyTarget,
  onCancelReply,
  onTyping,
  onStopTyping,
  onOptimistic,
  onOptimisticFail,
  onOptimisticRetry,
  prefill,
}: {
  conversationId: string;
  currentUser: User;
  /**
   * The conversation's contact. Drives the "replying to" pill, and resolves
   * `$var.contact.*` tokens when an agent inserts a snippet (`/<name>`).
   */
  contact: Contact;
  /**
   * Most recent inbound timestamp for this contact. Drives the 24h window
   * status — when null or > 24h ago, free-form replies are blocked (Meta
   * Cloud API constraint; only pre-approved templates can be sent).
   */
  lastInboundAt: string | null;
  /**
   * When set, the next send is a quoted reply to this message. Snapshot is
   * built by the parent (it has the team-members map for sender names).
   */
  replyTarget?: ReplySnapshot | null;
  onCancelReply?: () => void;
  onTyping?: () => void;
  onStopTyping?: () => void;
  /** Paint the bubble synchronously while the API call is in flight. */
  onOptimistic?: (message: Message) => void;
  /** Mark the bubble as failed if the network call rejected. */
  onOptimisticFail?: (clientTempId: string) => void;
  /** Drop the failed bubble — used here after restoring the input. */
  onOptimisticRetry?: (clientTempId: string) => void;
  /**
   * Pre-load the composer with text — currently used for "Retry" on a failed
   * bubble. The `nonce` distinguishes back-to-back retries of the same body
   * so the effect re-fires.
   */
  prefill?: { body: string; nonce: string } | null;
}) {
  // Tick once a minute so the "8h left" countdown advances without a refresh.
  // The window itself flips state at the same cadence.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const windowStatus = computeWindowStatus(lastInboundAt, now);
  const windowClosed =
    windowStatus.state === "closed" || windowStatus.state === "never";
  const [mode, setMode] = useState<Mode>("reply");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [attachment, setAttachment] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // -------------------------------------------------------------------------
  // Slash-trigger snippet state.
  //
  // `slashRange` is non-null whenever the cursor is at the end of a `/word`
  // run on the current word (preceded by whitespace, line start, or the
  // beginning of the buffer). When set, we render <SnippetPopup> above the
  // textarea and pass `slashRange.query` for filtering. Inserting splices
  // the snippet body (with tokens resolved against the live contact) into
  // the value at [start, end].
  // -------------------------------------------------------------------------
  // Snippets are team-wide and identical for every chat — they live in a
  // session-scoped Client Context populated server-side by the inbox layout
  // (see snippets-context.tsx). No client fetch, no per-chat refetch.
  const snippets = useSnippets();
  const [slashRange, setSlashRange] = useState<{ start: number; end: number; query: string } | null>(null);

  // Recompute slash range whenever value, cursor, or mode changes. We DON'T
  // show the popup in note mode for v1 — keeps the surface tight; revisit
  // later if internal notes want canned text too.
  const updateSlashRange = useCallback(() => {
    if (mode !== "reply" || windowClosed) {
      setSlashRange(null);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const text = el.value;
    const caret = el.selectionStart ?? text.length;
    const range = detectSlashQuery(text, caret);
    setSlashRange(range);
  }, [mode, windowClosed]);

  // Map the chosen snippet to "splice resolved body into the textarea".
  const onSelectSnippet = useCallback(
    (s: SnippetItem) => {
      if (!slashRange) return;
      // Resolve `$var.contact.*` against the live conversation contact and
      // `$var.agent.*` against the agent inserting it — that's `currentUser`.
      // Both namespaces are valid in snippets (configured by listAvailableTokens
      // in the snippets editor); the runner here doesn't need to gate them.
      const resolved = resolveFieldTokens(s.body, contact, currentUser);
      const before = value.slice(0, slashRange.start);
      const after = value.slice(slashRange.end);
      const next = before + resolved + after;
      setValue(next);
      setSlashRange(null);
      // Restore the caret right after the inserted text so the agent can
      // keep typing without hunting.
      requestAnimationFrame(() => {
        const el = ref.current;
        if (!el) return;
        const pos = before.length + resolved.length;
        el.focus();
        el.setSelectionRange(pos, pos);
      });
    },
    [slashRange, value, contact],
  );

  const isNote = mode === "note";
  // When the WhatsApp window is closed, only Notes + Templates are allowed.
  // Free-form text and media both require the 24h customer-service window
  // to be open — Meta would reject them with error 131047 otherwise.
  const canSend =
    (attachment !== null || value.trim().length > 0) && (isNote || !windowClosed);

  // -------------------------------------------------------------------------
  // Template picker state
  // -------------------------------------------------------------------------
  const [pickerOpen, setPickerOpen] = useState(false);
  const [templates, setTemplates] = useState<TemplateDto[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesSyncing, setTemplatesSyncing] = useState(false);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [wabaMissing, setWabaMissing] = useState(false);

  const syncTemplatesRef = useRef<() => Promise<void>>(async () => {});

  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    setTemplatesError(null);
    try {
      const res = await fetch("/api/team/whatsapp/templates");
      if (!res.ok) throw new Error(await safeReadError(res));
      const data = (await res.json()) as {
        templates?: TemplateDto[];
        hasWabaId?: boolean;
      };
      const list = data.templates ?? [];
      setTemplates(list);
      const hasWaba = Boolean(data.hasWabaId);
      setWabaMissing(!hasWaba);
      setTemplatesLoaded(true);
      // First-open kicker: if the cache is empty but the WABA id IS set,
      // pull from Meta immediately so the agent doesn't have to find the
      // Refresh button to see anything. Subsequent opens hit the cache.
      if (hasWaba && list.length === 0) {
        void syncTemplatesRef.current();
      }
    } catch (err) {
      setTemplatesError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setTemplatesLoading(false);
    }
  }, []);

  const syncTemplates = useCallback(async () => {
    setTemplatesSyncing(true);
    setTemplatesError(null);
    try {
      const res = await fetch("/api/team/whatsapp/templates", { method: "POST" });
      const data = (await res.json()) as {
        templates?: TemplateDto[];
        error?: string;
        detail?: string;
      };
      if (!res.ok) {
        // 409 with "waba id missing" → flag the picker so it renders the
        // setup nudge instead of a generic error.
        if (res.status === 409 && data.error === "waba id missing") {
          setWabaMissing(true);
          return;
        }
        throw new Error(
          [data.error, data.detail].filter(Boolean).join(": ") ||
            `HTTP ${res.status}`,
        );
      }
      setTemplates(data.templates ?? []);
      setWabaMissing(false);
    } catch (err) {
      setTemplatesError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setTemplatesSyncing(false);
    }
  }, []);
  // Keep the ref pointing at the latest sync function so the loader effect
  // can invoke it without depending on a forward declaration.
  useEffect(() => {
    syncTemplatesRef.current = syncTemplates;
  }, [syncTemplates]);

  // Lazy-load on first open. Re-using cached list keeps subsequent opens
  // instant; the explicit Refresh button is the agent's hook for "pull
  // again from Meta".
  useEffect(() => {
    if (pickerOpen && !templatesLoaded) {
      void loadTemplates();
    }
  }, [pickerOpen, templatesLoaded, loadTemplates]);

  const sendTemplate = useCallback(
    async (args: {
      template: TemplateDto;
      variables: { body: string[]; header?: string };
    }) => {
      const clientTempId = newClientTempId();
      try {
        const res = await fetch("/api/messages/template", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversationId,
            templateId: args.template.id,
            variables: args.variables,
            clientTempId,
          }),
        });
        if (!res.ok) {
          const msg = await safeReadError(res);
          return { ok: false as const, error: msg };
        }
        return { ok: true as const };
      } catch (err) {
        return {
          ok: false as const,
          error: err instanceof Error ? err.message : "Send failed",
        };
      }
    },
    [conversationId],
  );

  // Build / tear down the local preview URL when a file is picked.
  useEffect(() => {
    if (!attachment || !attachment.type.startsWith("image/")) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(attachment);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [attachment]);

  // Notes don't accept media — drop any pending file when toggling to note mode.
  useEffect(() => {
    if (isNote && attachment) {
      setAttachment(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [isNote, attachment]);

  // Switching to Note mode invalidates an in-flight reply target — notes
  // never quote a customer message (they're internal only).
  useEffect(() => {
    if (isNote && replyTarget) onCancelReply?.();
  }, [isNote, replyTarget, onCancelReply]);

  // Focus the composer the moment a reply is selected so the user can type.
  useEffect(() => {
    if (replyTarget) ref.current?.focus();
  }, [replyTarget]);

  // Pre-load text from a "Retry" click on a failed bubble. Each retry has a
  // unique nonce so back-to-back retries of the same body still fire. Also
  // flips back to Reply mode if the user happens to be writing a note.
  useEffect(() => {
    if (!prefill) return;
    setMode("reply");
    setValue(prefill.body);
    setError(null);
    ref.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.nonce]);

  const submit = () => {
    if (!canSend) return;

    const trimmed = value.trim();
    const file = attachment;
    if (!file && !trimmed) return;

    const clientTempId = newClientTempId();
    const snapshotValue = value;
    // Capture reply target NOW so the parent can clear the pill while the
    // network call is still in flight (next message in the same thread can
    // start typing immediately). The id rides through the API to the server.
    const reply = replyTarget && !isNote ? replyTarget : null;
    const replyToMessageId = reply?.id;

    // -----------------------------------------------------------------------
    // Optimistic paint. Bubble appears in the thread instantly with the local
    // file blob URL (for images/video) or just the text. The hook swaps it
    // for the server's authoritative copy when message:new arrives.
    //
    // Notes don't go through this path — they're DB-only and already <100ms.
    // -----------------------------------------------------------------------
    if (!isNote && onOptimistic) {
      const ts = new Date().toISOString();
      if (file) {
        const mimeType = file.type || "application/octet-stream";
        const kind: MediaKind = kindFromMimeClient(mimeType);
        // Local blob URL works as the bubble's media src until the server
        // reply swaps in /api/media/<id>. The browser keeps the blob alive
        // as long as some element references it.
        const blobUrl = URL.createObjectURL(file);
        onOptimistic({
          id: clientTempId,
          teamId: currentUser.teamId,
          conversationId,
          externalId: clientTempId,
          senderUserId: currentUser.id,
          body: trimmed,
          direction: "out",
          provider: "meta_cloud",
          status: "sent",
          rawPayload: {},
          timestamp: ts,
          clientTempId,
          pending: true,
          ...(reply ? { replyToMessageId: reply.id, replyTo: reply } : {}),
          media: {
            kind,
            url: blobUrl,
            mimeType,
            sizeBytes: file.size,
            ...(trimmed ? { caption: trimmed } : {}),
            ...(kind === "document" ? { filename: file.name } : {}),
          },
        });
      } else if (trimmed) {
        onOptimistic({
          id: clientTempId,
          teamId: currentUser.teamId,
          conversationId,
          externalId: clientTempId,
          senderUserId: currentUser.id,
          body: trimmed,
          direction: "out",
          provider: "meta_cloud",
          status: "sent",
          rawPayload: {},
          timestamp: ts,
          clientTempId,
          pending: true,
          ...(reply ? { replyToMessageId: reply.id, replyTo: reply } : {}),
        });
      }
    }

    // Clear input now so the user can keep typing.
    setValue("");
    setAttachment(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (reply) onCancelReply?.();
    onStopTyping?.();
    ref.current?.focus();
    setError(null);

    void (async () => {
      try {
        if (file && !isNote) {
          const fd = new FormData();
          fd.append("conversationId", conversationId);
          fd.append("file", file);
          if (trimmed) fd.append("caption", trimmed);
          fd.append("clientTempId", clientTempId);
          if (replyToMessageId) fd.append("replyToMessageId", replyToMessageId);
          const res = await fetch("/api/messages/media", { method: "POST", body: fd });
          if (!res.ok) throw new Error(await safeReadError(res));
        } else if (trimmed) {
          const url = isNote ? "/api/notes" : "/api/messages";
          const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(
              isNote
                ? { conversationId, body: trimmed }
                : {
                    conversationId,
                    body: trimmed,
                    clientTempId,
                    ...(replyToMessageId ? { replyToMessageId } : {}),
                  },
            ),
          });
          if (!res.ok) throw new Error(await safeReadError(res));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "failed to send");
        if (!isNote) onOptimisticFail?.(clientTempId);
        // Restore the user's text (only if they haven't started typing again).
        setValue((cur) => {
          if (cur !== "") return cur;
          // Drop the failed bubble; the input now holds their text again.
          if (!isNote) onOptimisticRetry?.(clientTempId);
          return snapshotValue;
        });
      }
    })();
  };

  return (
    <div className="relative border-t border-border bg-background">
      <div className="mx-auto w-full max-w-3xl px-4 pt-3 pb-4">
        <div className="mb-2 flex items-center gap-2">
          <div className="inline-flex rounded-md border border-border bg-muted/40 p-0.5">
            <ToggleButton active={mode === "reply"} onClick={() => setMode("reply")} icon={MessageSquare} label="Reply" />
            <ToggleButton active={mode === "note"} onClick={() => setMode("note")} icon={StickyNote} label="Note" />
          </div>
          {!isNote && (
            <WindowBadgeFromStatus status={windowStatus} size="sm" />
          )}
          {!isNote && windowClosed && (
            <Button
              type="button"
              size="sm"
              className="ml-auto h-7 gap-1.5 text-xs"
              onClick={() => setPickerOpen(true)}
            >
              <Sparkles className="size-3.5" />
              Send template
            </Button>
          )}
        </div>

        <motion.div
          layout
          className={cn(
            "relative rounded-xl border transition-colors",
            isNote ? "border-note-border bg-note-bg/40" : "border-border bg-card",
          )}
        >
          <AnimatePresence>
            {replyTarget && !isNote && (
              <motion.div
                key="reply-pill"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden border-b border-border"
              >
                <ReplyTargetPill
                  reply={replyTarget}
                  contactName={contact.name}
                  onCancel={() => onCancelReply?.()}
                />
              </motion.div>
            )}
            {attachment && (
              <motion.div
                key="attachment-pill"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden border-b border-border"
              >
                <AttachmentPreview
                  file={attachment}
                  previewUrl={previewUrl}
                  onRemove={() => {
                    setAttachment(null);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                />
              </motion.div>
            )}
          </AnimatePresence>

          {slashRange !== null && (
            <SnippetPopup
              snippets={snippets}
              query={slashRange.query}
              onSelect={onSelectSnippet}
              onClose={() => setSlashRange(null)}
            />
          )}
          <Textarea
            ref={ref}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (!isNote && e.target.value.length > 0) {
                onTyping?.();
              } else if (e.target.value.length === 0) {
                onStopTyping?.();
              }
              // Re-detect the slash query on every keystroke. Defer so the
              // textarea's value/selection settles first.
              requestAnimationFrame(updateSlashRange);
            }}
            onSelect={updateSlashRange}
            onClick={updateSlashRange}
            onBlur={() => {
              onStopTyping?.();
              // Close the popup on blur. The popup itself preventDefaults
              // on mousedown so clicking an entry doesn't blur first.
              setSlashRange(null);
            }}
            disabled={!isNote && windowClosed}
            placeholder={
              isNote
                ? "Leave an internal note for your teammates…"
                : windowClosed
                  ? "Free-form replies blocked — send a pre-approved template to re-engage."
                  : attachment
                    ? "Add a caption (optional)…"
                    : "Reply on WhatsApp…"
            }
            className={cn(
              "min-h-22 resize-none border-0 bg-transparent px-3.5 py-3 text-sm shadow-none focus-visible:ring-0",
              !isNote && windowClosed && "cursor-not-allowed opacity-60",
            )}
            onKeyDown={(e) => {
              // Snippet picker has first dibs on Enter / Tab / Arrows / Esc
              // when it's open. Its global keydown listener calls
              // preventDefault on those keys, but React's synthetic event
              // pipeline still delivers Enter to this handler — so we have
              // to explicitly skip when the popup owns the keypress.
              if (
                slashRange &&
                (e.key === "Enter" || e.key === "Tab" || e.key === "ArrowUp" || e.key === "ArrowDown")
              ) {
                return;
              }
              // Enter sends, Shift+Enter inserts a newline. Skip when an IME
              // composition is active (e.g. Chinese/Japanese input) — Enter
              // there confirms a candidate, not the message.
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="flex items-center gap-1 px-2 pb-2 pt-0">
            <input
              ref={fileInputRef}
              type="file"
              hidden
              // Wide accept list — server validates by mime type and size.
              accept="image/*,video/*,audio/*,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain"
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                if (file) setAttachment(file);
              }}
            />
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground"
              type="button"
              disabled={isNote || windowClosed}
              title={
                isNote
                  ? "Notes can't have attachments"
                  : windowClosed
                    ? "Window closed — only templates can be sent"
                    : "Attach image, video, audio, or document"
              }
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground"
              type="button"
              disabled={isNote}
              title={
                isNote
                  ? "Templates can only be sent in Reply mode"
                  : "Send a pre-approved template"
              }
              onClick={() => setPickerOpen(true)}
            >
              <Sparkles className="size-4" />
            </Button>
            <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" type="button" disabled>
              <Smile className="size-4" />
            </Button>

            <AnimatePresence>
              {isNote && (
                <motion.span
                  key="note-tag"
                  initial={{ opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -4 }}
                  className="ml-1 text-[11px] font-medium text-note-fg"
                >
                  Internal · not sent to WhatsApp
                </motion.span>
              )}
            </AnimatePresence>

            <span className="ml-auto text-[10px] text-muted-foreground">
              ↵ to send · ⇧↵ for newline
            </span>
            <Button
              size="sm"
              onClick={submit}
              disabled={!canSend}
              className={cn(
                "h-8 gap-1.5",
                isNote && "bg-note-fg text-background hover:bg-note-fg/90",
              )}
            >
              <Send className="size-3.5" />
              {isNote ? "Save note" : attachment ? "Send media" : "Send"}
            </Button>
          </div>
        </motion.div>

        {error && (
          <p className="mt-2 text-[11px] text-destructive">
            {error}
          </p>
        )}
      </div>

      <TemplatePicker
        open={pickerOpen}
        templates={templates}
        loading={templatesLoading && !templatesLoaded}
        error={templatesError}
        syncing={templatesSyncing}
        wabaMissing={wabaMissing}
        onClose={() => setPickerOpen(false)}
        onRefresh={syncTemplates}
        onSend={sendTemplate}
      />
    </div>
  );
}
