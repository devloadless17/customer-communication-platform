"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  MessageSquare,
  MousePointerClick,
  Paperclip,
  Send,
  Smile,
  Sparkles,
  StickyNote,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/lib/toast";
import { cn } from "@ccp/shared/utils";
import type {
  Contact,
  ContactFieldDefinition,
  ContactStage,
  MediaKind,
  Message,
  ReplySnapshot,
  SnippetItem,
  Tag,
  TemplateDto,
  User,
} from "@ccp/shared/types";
import type { ContactLike } from "@ccp/shared/field-tokens";
import { mediaPreviewLabel } from "@ccp/shared/types";
import { emitOptimisticListBump } from "@/features/inbox/lib/optimistic-list-bump";
import { computeWindowStatus } from "@ccp/shared/utils/window";
import { resolveFieldTokens } from "@ccp/shared/field-tokens";
import { useNow } from "@/hooks/use-now";

import dynamic from "next/dynamic";

import { WindowBadgeFromStatus } from "./window-badge";
// Lazy-load the template picker — it ships its own framer-motion +
// list/fill subviews and only mounts when the user explicitly opens it
// from the composer. SSR-disabled because it's strictly interactive.
const TemplatePicker = dynamic(
  () => import("./template-picker").then((m) => m.TemplatePicker),
  { ssr: false },
);
import { SnippetPopup } from "./snippet-popup";
import { useSnippets } from "./snippets-context";
import { renderPlaceholders } from "./template-picker/utils";

import { AttachmentPreview } from "./reply-box/attachment-preview";
import { InteractivePopover } from "./interactive-popover";
import { ReplyTargetPill } from "./reply-box/reply-target-pill";
import { ToggleButton } from "./reply-box/toggle-button";
import {
  detectSlashQuery,
  kindFromMimeClient,
  newClientTempId,
  safeReadError,
} from "./reply-box/utils";
import { EmojiPopover } from "./reply-box/emoji-popover";
import {
  MicButton,
  RecordingBar,
  useVoiceRecorder,
} from "./reply-box/voice-recorder";

type Mode = "reply" | "note";

// Meta Cloud API media size caps (per their docs). We trim ~5% off each so a
// borderline file doesn't get rejected after a 4-minute upload due to
// multipart envelope overhead.
const MEDIA_SIZE_LIMITS = {
  image: { bytes: 4_800_000, label: "Image" }, // Meta: 5 MB
  video: { bytes: 15_000_000, label: "Video" }, // Meta: 16 MB
  audio: { bytes: 15_000_000, label: "Audio" }, // Meta: 16 MB
  document: { bytes: 95_000_000, label: "Document" }, // Meta: 100 MB
} as const;

function pickSizeLimit(file: File): { bytes: number; label: string } {
  const mime = file.type;
  if (mime.startsWith("image/")) return MEDIA_SIZE_LIMITS.image;
  if (mime.startsWith("video/")) return MEDIA_SIZE_LIMITS.video;
  if (mime.startsWith("audio/")) return MEDIA_SIZE_LIMITS.audio;
  return MEDIA_SIZE_LIMITS.document;
}

function formatMb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(0)} MB`;
}

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
  stageCatalog,
  tags,
  fieldDefinitions,
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
  /** Team stage + tag catalogs — used to resolve the derived
   *  `$var.contact.stage_name` / `$var.contact.tag_names` tokens when an
   *  agent inserts a snippet (the contact carries only ids). */
  stageCatalog: ContactStage[];
  tags: Tag[];
  /** Team custom-field schema — forwarded to TemplatePicker so the per-
   *  variable field-token dropdown lists known custom keys. */
  fieldDefinitions: ContactFieldDefinition[];
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
   *
   * `clientTempId` ties this prefill back to a specific failed optimistic
   * send. When set, we also pop any cached File from `pendingFilesRef`,
   * restoring the attachment preview so the agent can resend a media
   * message without re-picking the file.
   */
  prefill?: { body: string; nonce: string; clientTempId?: string } | null;
}) {
  // Shared 60s tick across the inbox so we don't run N parallel intervals
  // (one in WindowBadge, one here, …). Initialized to the server's clock on
  // SSR so the window state + suffix render identical on first paint —
  // dropping the prior null-then-fill posture that caused a "Window closed"
  // flash on refresh.
  const now = useNow();
  const windowStatus = computeWindowStatus(lastInboundAt, now);
  const windowClosed =
    windowStatus.state === "closed" || windowStatus.state === "never";
  const [mode, setMode] = useState<Mode>("reply");
  // Draft persistence: WhatsApp/Slack/Telegram all hold typed-but-unsent text
  // across chat switches. We persist to localStorage keyed by team+conv id so
  // the draft survives chat switches AND refreshes within the same browser.
  // Cleared on successful send + on explicit Cancel of the reply target.
  const draftKey = `inbox:${currentUser.teamId}:draft:${conversationId}`;
  // Initial value MUST match SSR (always ""), otherwise the submit button's
  // `disabled` attribute hydrates mismatched when a draft exists. Load the
  // saved draft post-mount.
  const [value, setValue] = useState("");
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(draftKey);
      if (saved) setValue((cur) => (cur === "" ? saved : cur));
    } catch {
      // Privacy mode — no draft restore, composer still works.
    }
  }, [draftKey]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (value) window.localStorage.setItem(draftKey, value);
      else window.localStorage.removeItem(draftKey);
    } catch {
      // Quota / privacy mode — draft just won't survive a refresh. The
      // composer still works fine.
    }
  }, [draftKey, value]);
  // Latest-value mirror so async handlers can read the live input without
  // doing side effects inside a setValue updater (React 19 warns).
  const valueRef = useRef(value);
  valueRef.current = value;
  const [error, setError] = useState<string | null>(null);
  const [attachment, setAttachment] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Voice recorder lives in a hook so the recorder lifecycle (MediaRecorder
  // + AudioContext) survives re-renders of the toolbar. `start()` kicks
  // off mic capture; the recording bar replaces the toolbar until
  // Cancel or Send is clicked.
  const voice = useVoiceRecorder({
    onError: (message) => {
      setError(message);
      toast.error("Couldn't record voice message", { description: message });
    },
  });

  // Splice an emoji into the textarea at the current caret position.
  // Keep the popover open so an agent can insert several in a row; the
  // smile button itself toggles it shut.
  const insertEmoji = useCallback((emoji: string) => {
    const el = ref.current;
    if (!el) {
      setValue((v) => v + emoji);
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = el.value.slice(0, start) + emoji + el.value.slice(end);
    setValue(next);
    // Restore the caret right after the inserted emoji on next paint.
    // setSelectionRange before the DOM commits the new value would
    // clamp against the OLD length.
    requestAnimationFrame(() => {
      const elNow = ref.current;
      if (!elNow) return;
      const pos = start + emoji.length;
      elNow.focus();
      elNow.setSelectionRange(pos, pos);
    });
  }, []);

  // Holds the File for every in-flight or failed media send, keyed by
  // clientTempId. Lets a "Retry" on a failed media bubble restore the
  // attachment in the composer without forcing the agent to re-pick the
  // file. Lives in a ref (not state) — mutating doesn't need to re-render.
  // Cleared per-entry on retry; full ref is naturally dropped on unmount
  // (i.e. when navigating away from the conversation), matching the
  // optimistic state's per-thread lifecycle.
  const pendingFilesRef = useRef(
    new Map<
      string,
      { file: File; caption: string; replyToMessageId?: string }
    >(),
  );

  // Idempotency guard: while a submit is in flight, additional Enter
  // presses / Send-button clicks no-op. The fetch IIFE clears the flag in
  // its finally block. Without this, holding Enter or double-clicking
  // sends the SAME draft twice — the input is cleared synchronously, but
  // the second keydown fires before React re-renders, so its `value`
  // closure still has the original text. The DB unique on `externalId`
  // doesn't save us: each click generates a fresh `clientTempId`, and
  // Meta returns a different wamid for each accepted send → the customer
  // gets the same message twice.
  const sendInFlightRef = useRef(false);
  const [sendInFlight, setSendInFlight] = useState(false);

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

  // Debounced variant for the keystroke path. detectSlashQuery scans the
  // entire textarea on every call; on a fast typist with an 8KB draft that's
  // ~60 regex scans/sec — measurable jank on low-end mobile. Showing the
  // popup 50ms after typing stops is imperceptible. Cursor-move paths
  // (onSelect/onClick) still call updateSlashRange synchronously — those
  // fire infrequently and the popup must follow the caret without lag.
  const slashDebounceRef = useRef<number | null>(null);
  const updateSlashRangeDebounced = useCallback(() => {
    if (slashDebounceRef.current !== null) {
      window.clearTimeout(slashDebounceRef.current);
    }
    slashDebounceRef.current = window.setTimeout(() => {
      slashDebounceRef.current = null;
      updateSlashRange();
    }, 50);
  }, [updateSlashRange]);
  useEffect(() => {
    return () => {
      if (slashDebounceRef.current !== null) {
        window.clearTimeout(slashDebounceRef.current);
      }
    };
  }, []);

  // Map the chosen snippet to "splice resolved body into the textarea".
  const onSelectSnippet = useCallback(
    (s: SnippetItem) => {
      if (!slashRange) return;
      // Resolve `$var.contact.*` against the live conversation contact and
      // `$var.agent.*` against the agent inserting it — that's `currentUser`.
      // The contact carries only stageId / tagIds, so derive the display
      // values (stage_name, tag_names) from the catalogs and fold in the
      // window state + lastInboundAt — otherwise those tokens resolve empty.
      const contactForTokens: ContactLike = {
        name: contact.name,
        phoneNumber: contact.phoneNumber,
        email: contact.email ?? null,
        location: contact.location ?? null,
        customFields: contact.customFields ?? {},
        lastInboundAt,
        windowState: windowStatus.state,
        stageName: contact.stageId
          ? stageCatalog.find((s2) => s2.id === contact.stageId)?.name ?? null
          : null,
        tagNames: (contact.tagIds ?? [])
          .map((id) => tags.find((t) => t.id === id)?.name)
          .filter((n): n is string => typeof n === "string"),
      };
      const resolved = resolveFieldTokens(s.body, contactForTokens, currentUser);
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
  // Interactive (buttons) popover state. Synchronous-send agent-side
  // counterpart of the workflow ask_question step's interactive path.
  const [interactiveOpen, setInteractiveOpen] = useState(false);
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
        // Bump the list on success (not before — a template send is
        // synchronous and can be rejected, and unlike the reply box it paints
        // no optimistic bubble, so we don't want a phantom preview on failure).
        // The rendered body matches what the server stores as the preview
        // (same renderPlaceholders the picker uses), so this won't flicker
        // when the real `message:new` arrives.
        emitOptimisticListBump({
          conversationId,
          preview: renderPlaceholders(args.template.bodyText, args.variables.body).slice(0, 200),
          lastMessageAt: new Date().toISOString(),
        });
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
  //
  // For media retries: prefill carries the original clientTempId. We pop the
  // cached File entry and re-seat it as the attachment so the agent doesn't
  // have to re-pick. caption from the entry takes precedence over body (the
  // bubble's `body` is the caption for media messages, but if the user
  // already typed something into the composer we honor the prefill order).
  //
  // useLayoutEffect (not useEffect) so the setValue commits BEFORE the
  // browser paints — without it, the user sees the empty textarea for one
  // frame on retry click and then the restored text pops in. Cheaper to do
  // the sync write than to ship a one-frame flash.
  useLayoutEffect(() => {
    if (!prefill) return;
    setMode("reply");
    setError(null);
    let restoredCaption: string | null = null;
    if (prefill.clientTempId) {
      const entry = pendingFilesRef.current.get(prefill.clientTempId);
      if (entry) {
        setAttachment(entry.file);
        restoredCaption = entry.caption;
        pendingFilesRef.current.delete(prefill.clientTempId);
      }
    }
    setValue(restoredCaption ?? prefill.body);
    ref.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.nonce]);

  // `override.file` lets the voice-recorder path inject a freshly captured
  // audio File without going through `setAttachment` first — React state
  // updates are async, but the recorder wants to send the moment the user
  // taps the send-recording button. `override.voice` rides along to flag
  // the audio as a WhatsApp voice note (waveform UI on the recipient side).
  const submit = (override?: { file: File; voice?: boolean }) => {
    if (sendInFlightRef.current) return;
    const overrideFile = override?.file ?? null;
    const overrideVoice = override?.voice === true;

    const trimmed = value.trim();
    const file = overrideFile ?? attachment;
    if (!file && !trimmed) return;
    // Without an override we still respect the existing gate (window open
    // or note mode). Voice messages bypass the empty-text gate but still
    // need the window open / note mode — same content-side rules.
    if (!file && !canSend) return;
    if (overrideFile && !isNote && windowClosed) return;

    sendInFlightRef.current = true;
    setSendInFlight(true);

    const clientTempId = newClientTempId();
    const snapshotValue = value;
    // For voice-only sends the caption is the empty string (we don't want
    // the textarea contents leaking into a voice message — they'll get sent
    // separately on the next submit). Otherwise the trimmed value rides
    // along as the caption.
    const effectiveCaption = overrideFile ? "" : trimmed;
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
      let optimisticMessage: Message | null = null;
      let listPreview = "";
      if (file) {
        const mimeType = file.type || "application/octet-stream";
        const kind: MediaKind = kindFromMimeClient(mimeType);
        // Local blob URL works as the bubble's media src until the server
        // reply swaps in /api/media/<id>. The browser keeps the blob alive
        // as long as some element references it.
        const blobUrl = URL.createObjectURL(file);
        optimisticMessage = {
          id: clientTempId,
          teamId: currentUser.teamId,
          conversationId,
          externalId: clientTempId,
          senderUserId: currentUser.id,
          body: effectiveCaption,
          direction: "out",
          channel: "whatsapp",
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
            ...(effectiveCaption ? { caption: effectiveCaption } : {}),
            ...(kind === "document" ? { filename: file.name } : {}),
          },
        };
        // Caption-less media has an empty body — use the same media label the
        // server writes so the list preview reads "🎤 Voice message" etc.
        listPreview = (effectiveCaption || mediaPreviewLabel(kind)).slice(0, 200);
      } else if (trimmed) {
        optimisticMessage = {
          id: clientTempId,
          teamId: currentUser.teamId,
          conversationId,
          externalId: clientTempId,
          senderUserId: currentUser.id,
          body: trimmed,
          direction: "out",
          channel: "whatsapp",
          status: "sent",
          rawPayload: {},
          timestamp: ts,
          clientTempId,
          pending: true,
          ...(reply ? { replyToMessageId: reply.id, replyTo: reply } : {}),
        };
        listPreview = trimmed.slice(0, 200);
      }

      if (optimisticMessage) {
        onOptimistic(optimisticMessage);
        // Optimistically bump the conversation LIST (left sidebar) for the
        // sender's OWN send. The thread bubble above (addOptimistic) was the
        // only optimistic path; the list row (preview + recency sort) waited
        // on the server's `message:new` round-trip. On a long-lived tab whose
        // socket missed that frame (sleep/reconnect gap), the sender's list
        // preview stayed pinned to the previous message — most visibly a
        // stale text preview when the new message is a caption-less voice
        // note. The list-only channel avoids the other `message:new`
        // subscribers (notably the contact panel's un-deduped message tally).
        emitOptimisticListBump({ conversationId, preview: listPreview, lastMessageAt: ts });
      }
    }

    // Clear input now so the user can keep typing. Skip clearing `value`
    // when this is a voice-only send so the user's draft in the textarea
    // survives.
    if (!overrideFile) setValue("");
    setAttachment(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (reply) onCancelReply?.();
    onStopTyping?.();
    ref.current?.focus();
    setError(null);

    // Cache the File for a possible Retry. Without this, a failed media send
    // would force the agent to re-pick the file from disk — frustrating
    // when the only problem was a transient network hiccup. Skip caching
    // for voice messages: they're not re-pickable from disk anyway, and
    // a failed voice send is better re-recorded fresh.
    if (file && !isNote && !overrideFile) {
      pendingFilesRef.current.set(clientTempId, {
        file,
        caption: effectiveCaption,
        ...(replyToMessageId ? { replyToMessageId } : {}),
      });
    }

    void (async () => {
      // 30s hard cap on the request. Without this, a lost response (mobile
      // network blip, Caddy 502 mid-flight, browser sleep) leaves the
      // bubble in `pending: true` forever — the user wonders if it sent.
      // AbortController + signal aborts the fetch; the catch below surfaces
      // a "failed" bubble + Retry button, same flow as a real error.
      // Media uploads need a generous cap because the body itself may be
      // up to 16 MB — bump to 90s for those.
      const timeoutMs = file ? 90_000 : 30_000;
      const abort = new AbortController();
      const timeoutId = window.setTimeout(() => abort.abort(), timeoutMs);
      try {
        // Fast-fail when the browser knows we're offline. fetch() against a
        // dead connection takes 30-90s to time out — the bubble would sit
        // in "pending" state the whole time. Throwing immediately surfaces
        // a "failed" bubble + Retry button right away. The connection
        // banner is already telling the user why.
        if (typeof navigator !== "undefined" && !navigator.onLine) {
          throw new Error(
            "offline — your device is not connected to the internet",
          );
        }
        if (file && !isNote) {
          const fd = new FormData();
          fd.append("conversationId", conversationId);
          fd.append("file", file);
          if (effectiveCaption) fd.append("caption", effectiveCaption);
          fd.append("clientTempId", clientTempId);
          if (replyToMessageId) fd.append("replyToMessageId", replyToMessageId);
          if (overrideVoice) fd.append("voice", "true");
          const res = await fetch("/api/messages/media", {
            method: "POST",
            body: fd,
            signal: abort.signal,
          });
          if (!res.ok) throw new Error(await safeReadError(res));
          // Soft-warn the agent when the message went out on WhatsApp but our
          // local archival failed (saved=null path in messages.service.ts).
          // The bubble is text-only (caption preserved) — without this toast
          // the agent has no way to know the file isn't archived locally,
          // and may try to re-send (which would double-deliver on WA).
          const parsed = await res.clone().json().catch(() => null);
          if (parsed && typeof parsed === "object" && "warning" in parsed && parsed.warning) {
            toast.warning("Message sent — but the file wasn't archived locally", {
              description: String(parsed.warning),
            });
          }
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
            signal: abort.signal,
          });
          if (!res.ok) throw new Error(await safeReadError(res));
        }
      } catch (err) {
        // Normalize the AbortError so the toast doesn't say "The user aborted
        // a request" — it wasn't the user, it was our timeout.
        const normalized =
          err instanceof Error && err.name === "AbortError"
            ? new Error(
                "send timed out — the server didn't respond in time. Tap Retry.",
              )
            : err;
        const message =
          normalized instanceof Error ? normalized.message : "failed to send";
        setError(message);
        toast.error(isNote ? "Couldn't save note" : "Couldn't send message", {
          description: message,
        });
        if (!isNote) onOptimisticFail?.(clientTempId);
        // Restore the user's text (only if they haven't started typing again).
        // Read the live value via ref instead of a setValue updater — putting
        // the onOptimisticRetry side effect inside a state updater triggers
        // React 19's "setState while rendering another component" warning,
        // because updaters can run during render.
        if (valueRef.current === "") {
          if (!isNote) onOptimisticRetry?.(clientTempId);
          setValue(snapshotValue);
        }
      } finally {
        // Always clear the timeout — fetch resolved OK, errored, or
        // aborted; either way the timer would otherwise leak until it
        // fires harmlessly later.
        window.clearTimeout(timeoutId);
        // Release the idempotency lock — the next Enter / click can now
        // start a fresh send. Doing this in finally (not after setValue)
        // makes sure a thrown setError or unexpected error path can't
        // wedge the button permanently disabled.
        sendInFlightRef.current = false;
        setSendInFlight(false);
      }

      // Post-HTTP watchdog: if the HTTP request returned successfully but
      // the server never emits the confirming `message:new` socket frame
      // (worker crashed mid-Meta-send, bus subscriber threw, browser missed
      // the frame between subscribe-conversation and emit), the optimistic
      // bubble would sit in `pending: true` forever. After 30s, flip it to
      // failed so the user sees a Retry affordance. The matching reducer
      // dispatches `ccp:optimistic-confirmed` when the frame DOES arrive,
      // which cancels this watchdog.
      if (!isNote) {
        const STUCK_WATCHDOG_MS = 30_000;
        const ev = `ccp:optimistic-confirmed:${clientTempId}`;
        const watchdogId = window.setTimeout(() => {
          window.removeEventListener(ev, onConfirmed);
          onOptimisticFail?.(clientTempId);
        }, STUCK_WATCHDOG_MS);
        const onConfirmed = () => {
          window.clearTimeout(watchdogId);
          window.removeEventListener(ev, onConfirmed);
        };
        window.addEventListener(ev, onConfirmed, { once: true });
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
          {!isNote && <WindowBadgeFromStatus status={windowStatus} size="sm" />}
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
              // Re-detect the slash query on every keystroke, debounced 50ms
              // so the popup doesn't refresh at keystroke speed. Cursor-move
              // paths below stay synchronous — those don't fire per character.
              updateSlashRangeDebounced();
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
          {voice.isRecording ? (
            <RecordingBar
              durationSec={voice.durationSec}
              levels={voice.levels}
              onCancel={() => voice.cancel()}
              onSend={() => {
                void (async () => {
                  const file = await voice.stopAndCollect();
                  if (!file) {
                    setError("Recording was empty — try again.");
                    return;
                  }
                  // `voice: true` flags this as a RECORDING so the api transcodes
                  // it to ogg/opus before the Meta send (Chrome records audio/mp4
                  // which Meta accepts then fails to DELIVER; Firefox's ogg passes
                  // through). It is sent as a regular audio clip, NOT a waveform
                  // voice note — Meta's voice-note validator rejects browser
                  // recordings intermittently even as proper ogg. Reliability over
                  // the waveform UI. See [[meta-audio-mime-rules]].
                  submit({ file, voice: true });
                })();
              }}
            />
          ) : (
          <div className="flex items-center gap-1 px-2 pb-2 pt-0">
            <input
              ref={fileInputRef}
              type="file"
              hidden
              // Wide accept list — server validates by mime type and size.
              accept="image/*,video/*,audio/*,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain"
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                if (!file) return;
                // Client-side guardrails against Meta's hard caps. Without
                // these, a 12MB iPhone photo would upload for several minutes
                // on 3G before the server rejected it — terrible UX. Caps are
                // a hair under Meta's documented limits so we don't false-
                // reject borderline files due to multipart envelope overhead.
                // See https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media
                const limit = pickSizeLimit(file);
                if (file.size > limit.bytes) {
                  setError(
                    `${limit.label} attachments can't exceed ${formatMb(limit.bytes)}. Try a smaller file.`,
                  );
                  if (fileInputRef.current) fileInputRef.current.value = "";
                  return;
                }
                setAttachment(file);
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
            <div className="relative">
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground"
                type="button"
                disabled={isNote || windowClosed}
                title={
                  isNote
                    ? "Buttons can only be sent in Reply mode"
                    : windowClosed
                      ? "Window closed — buttons require the 24h window to be open"
                      : "Send a question with buttons"
                }
                onClick={() => setInteractiveOpen(true)}
              >
                <MousePointerClick className="size-4" />
              </Button>
              <InteractivePopover
                open={interactiveOpen}
                onClose={() => setInteractiveOpen(false)}
                conversationId={conversationId}
                initialBody={value}
                onSent={() => {
                  // Mirror the text-send post-success path: clear the
                  // composer + drop any persisted draft so the next focus
                  // starts fresh. The new bubble lands via the
                  // message.sent socket event published by
                  // sendInteractiveInternal.
                  setValue("");
                  try {
                    window.localStorage.removeItem(draftKey);
                  } catch {
                    // ignore quota / private-mode failures
                  }
                }}
              />
            </div>
            <div className="relative">
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground"
                type="button"
                disabled={isNote && false /* emojis valid in notes too */}
                title="Insert emoji"
                onClick={() => setEmojiOpen((v) => !v)}
              >
                <Smile className="size-4" />
              </Button>
              <EmojiPopover
                open={emojiOpen}
                onClose={() => setEmojiOpen(false)}
                onPick={insertEmoji}
              />
            </div>
            <MicButton
              onClick={() => {
                if (isNote) return;
                setEmojiOpen(false);
                void voice.start();
              }}
              disabled={isNote || windowClosed}
              title={
                isNote
                  ? "Voice messages aren't supported in Note mode"
                  : windowClosed
                    ? "Window closed — only templates can be sent"
                    : "Record a voice message"
              }
            />

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
              onClick={() => submit()}
              // Disable while a previous submit is still being POSTed — pairs
              // with the sendInFlightRef guard in `submit()` to make double-
              // click a no-op. The ref is the source of truth; this just
              // mirrors it visually so the user sees the button respond.
              disabled={!canSend || sendInFlight}
              className={cn(
                "h-8 gap-1.5",
                isNote && "bg-note-fg text-background hover:bg-note-fg/90",
              )}
            >
              <Send className="size-3.5" />
              {isNote ? "Save note" : attachment ? "Send media" : "Send"}
            </Button>
          </div>
          )}
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
        contact={contact}
        currentUser={currentUser}
        stageCatalog={stageCatalog}
        tags={tags}
        fieldDefinitions={fieldDefinitions}
        lastInboundAt={lastInboundAt}
        onClose={() => setPickerOpen(false)}
        onRefresh={syncTemplates}
        onSend={sendTemplate}
      />
    </div>
  );
}
