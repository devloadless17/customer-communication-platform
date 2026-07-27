"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Languages,
  MapPin,
  MessageSquare,
  MousePointerClick,
  Paperclip,
  Send,
  Smile,
  Sparkles,
  StickyNote,
  UserRound,
  Wand2,
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
  ConversationStatus,
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
import {
  emitOptimisticListBump,
  emitOptimisticListBumpRevert,
} from "@/features/inbox/lib/optimistic-list-bump";
import { onOpenTemplatePicker } from "@/features/inbox/lib/open-template-picker";
import { nextOptimisticSeq } from "@/features/inbox/lib/optimistic-seq";
import {
  buildOptimisticAiChange,
  buildOptimisticAssignment,
  buildOptimisticStatusChange,
} from "@/features/inbox/lib/optimistic-activity";
import { dispatchLocalSocketEvents } from "@/lib/socket-client";
import { apiFetch } from "@/lib/api/client-fetch";
import { computeWindowStatus, effectiveSendWindowMs } from "@ccp/shared/utils/window";
import { CHANNEL_CAPABILITIES, supportsInlineCaption } from "@ccp/shared/providers/capabilities";
import { mediaSizeCap, channelSupportsMediaKind } from "@ccp/shared/providers/media-caps";
import { CHANNEL_LABEL } from "./channel-badge";
import type { Channel } from "@ccp/shared/types";
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
import { renderTemplateBodyNamed } from "@ccp/shared/template-render";

import { renderPlaceholders } from "./template-picker/utils";

// Heavy, open-gated popovers — kept OUT of the inbox critical-path bundle and
// loaded on first open (they all render null when closed). The emoji popover
// alone builds a ~20KB keyword/search index at module eval, so deferring it is
// a real first-load win. Mirrors the TemplatePicker dynamic import above.
const EmojiPopover = dynamic(
  () => import("./reply-box/emoji-popover").then((m) => m.EmojiPopover),
  { ssr: false },
);
const TranslatePopover = dynamic(
  () => import("./reply-box/translate-popover").then((m) => m.TranslatePopover),
  { ssr: false },
);
const RefinePopover = dynamic(
  () => import("./reply-box/refine-popover").then((m) => m.RefinePopover),
  { ssr: false },
);
const InteractivePopover = dynamic(
  () => import("./interactive-popover").then((m) => m.InteractivePopover),
  { ssr: false },
);
const LocationComposer = dynamic(
  () => import("./location-composer").then((m) => m.LocationComposer),
  { ssr: false },
);
const ContactComposer = dynamic(
  () => import("./contact-composer").then((m) => m.ContactComposer),
  { ssr: false },
);

import { AttachmentPreview } from "./reply-box/attachment-preview";
import { ReplyTargetPill } from "./reply-box/reply-target-pill";
import { ToggleButton } from "./reply-box/toggle-button";
import {
  detectSlashQuery,
  kindFromMimeClient,
  newClientTempId,
  safeReadError,
} from "./reply-box/utils";
import {
  MicButton,
  RecordingBar,
  useVoiceRecorder,
} from "./reply-box/voice-recorder";

type Mode = "reply" | "note";

// Meta Cloud API media size caps (per their docs). We trim ~5% off each so a
// borderline file doesn't get rejected after a 4-minute upload due to
// multipart envelope overhead.
const KIND_LABEL: Record<MediaKind, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  sticker: "Sticker",
  document: "Document",
};

// Apply a small safety margin below the server's hard cap so a borderline file
// isn't rejected AFTER a multi-minute upload due to multipart envelope overhead.
const SIZE_SAFETY_MARGIN = 0.96;

// Derive the client guard from the SHARED per-channel cap map (the same source
// `mediaPolicyForChannel` uses on the server), so the two can't disagree — this
// composer previously hardcoded WhatsApp caps and wrongly rejected a valid 20 MB
// Messenger video / accepted an 20 MB Instagram image the server rejects.
//
// The kind mapping mirrors the server's (kindFromMime / kindFromMimeClient): the
// key case is `image/webp`, which both sides classify as a STICKER (tiny cap),
// not an image — so an oversized webp is rejected up-front with the right label.
function pickSizeLimit(file: File, channel: Channel): { bytes: number; label: string } {
  const kind = kindFromMimeClient(file.type);
  return {
    bytes: Math.floor(mediaSizeCap(channel, kind) * SIZE_SAFETY_MARGIN),
    label: KIND_LABEL[kind],
  };
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
// Memoized — the parent MessageThread re-renders on the 60s `now` tick, every
// teammate typing frame, and every in-thread search keystroke. ReplyBox's props
// are stable across those (callbacks are useCallback'd, catalogs are
// per-conversation), so it should bail instead of re-rendering this 1.8k-line
// composer each time. State + context changes still re-render it normally.
function ReplyBoxImpl({
  conversationId,
  currentUser,
  contact,
  channel = "whatsapp",
  stageCatalog,
  tags,
  fieldDefinitions,
  lastInboundAt,
  replyTarget,
  aiEnabled,
  aiAutopilotEnabled,
  status,
  assignedUserId,
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
   * The conversation's channel. Drives capability-derived composer behavior —
   * the free-form send window (WhatsApp 24h vs Messenger/Instagram 24h+7d) and
   * whether the template picker is offered at all. Optional + defaults to
   * `whatsapp` so the WhatsApp path is byte-identical (its capabilities
   * reproduce the previous hardcoded 24h + templates-on constants).
   */
  channel?: Channel;
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
   * Live AI-autopilot state for this conversation. A human reply auto-pauses
   * the AI server-side; when `aiAutopilotEnabled` (team opt-in) AND `aiEnabled`
   * (currently on) are both true, the composer optimistically emits the same
   * `conversation:ai` flip + `ai_paused` activity pill the server will write, so
   * the pill lands pinned right after the just-sent bubble instead of floating
   * in a beat later (above the still-pending send) via the authoritative GET.
   */
  aiEnabled?: boolean;
  aiAutopilotEnabled?: boolean;
  /**
   * Live conversation status + assignee. A human send mirrors the server's
   * `autoAssignOnAgentSend`: an UNASSIGNED conversation is self-assigned, and a
   * non-`open` one is reopened. The composer emits those optimistic pills (in
   * send order, pinned right after the bubble) so "self-assigned" / "reopened"
   * don't float in a beat late ABOVE the still-pending send via the
   * authoritative GET — same treatment as the AI-pause pill above.
   */
  status?: ConversationStatus;
  assignedUserId?: string | null;
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
   *
   * `mediaKind` is set when the failed message carried an attachment. If the
   * cached File is gone (retry after a thread switch remounted the ReplyBox and
   * dropped `pendingFilesRef`), we warn instead of silently resending
   * caption-only text.
   */
  prefill?: {
    body: string;
    nonce: string;
    clientTempId?: string;
    mediaKind?: MediaKind;
  } | null;
}) {
  // Shared 60s tick across the inbox so we don't run N parallel intervals
  // (one in WindowBadge, one here, …). Initialized to the server's clock on
  // SSR so the window state + suffix render identical on first paint —
  // dropping the prior null-then-fill posture that caused a "Window closed"
  // flash on refresh.
  const now = useNow();
  // Capability-driven window: WhatsApp = 24h; Messenger/Instagram = 24h + a
  // 7-day human-agent extension. `effectiveSendWindowMs` collapses that to the
  // widest window an agent may send in. WhatsApp's capability values reproduce
  // the previous hardcoded 24h, so this is behavior-identical there.
  const caps = CHANNEL_CAPABILITIES[channel];
  // A NULL window means the channel has no re-engagement limit at all (webchat
  // widget: a live in-browser session). That is different from "24h" — passing
  // `undefined` down would fall through to computeWindowStatus's 24h default and
  // lock the composer forever on a thread whose visitor last wrote yesterday,
  // with no template escape hatch (caps.templates === false). The server already
  // skips the gate for a null window (send-text-internal.ts), so the UI must too.
  const sendWindowMs = effectiveSendWindowMs(caps);
  const hasSendWindow = sendWindowMs !== null;
  const windowStatus = computeWindowStatus(lastInboundAt, now, sendWindowMs ?? undefined);
  const windowClosed =
    hasSendWindow && (windowStatus.state === "closed" || windowStatus.state === "never");
  const [mode, setMode] = useState<Mode>("reply");
  // Draft persistence: WhatsApp/Slack/Telegram all hold typed-but-unsent text
  // across chat switches. We persist to localStorage keyed by team+conv id so
  // the draft survives chat switches AND refreshes within the same browser.
  // Cleared on successful send + on explicit Cancel of the reply target.
  // Draft keys are MODE-SCOPED: Reply and Note keep independent buffers so
  // toggling between them never carries a half-written customer reply into
  // the internal-note box — or, the dangerous direction, a sensitive internal
  // note into the WhatsApp reply field where one Enter would send it to the
  // customer (irreversible Meta send). `switchMode` handles the handoff.
  const draftKeyFor = useCallback(
    (m: Mode) => `inbox:${currentUser.workspaceId}:draft:${m}:${conversationId}`,
    [currentUser.workspaceId, conversationId],
  );
  // Initial value MUST match SSR (always ""), otherwise the submit button's
  // `disabled` attribute hydrates mismatched when a draft exists. Mount mode
  // is always "reply", so restore that buffer post-mount.
  const [value, setValue] = useState("");
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(draftKeyFor("reply"));
      if (saved) setValue((cur) => (cur === "" ? saved : cur));
    } catch {
      // Privacy mode — no draft restore, composer still works.
    }
  }, [draftKeyFor]);
  // Autoresize fallback for browsers without CSS `field-sizing` (Safari; Firefox
  // by default). Chromium grows the textarea via the `field-sizing-content`
  // class; elsewhere the composer would stay stuck at its min height and
  // multi-line drafts scroll in a cramped box. Grow up to max-h-48 (12rem =
  // 192px), then the class's `overflow-y-auto` scrolls internally.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content")) {
      return; // native handles sizing
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
  }, [value]);
  // Persist the live draft under the CURRENT mode's key. `switchMode` already
  // persists the outgoing buffer before flipping, so this only ever writes the
  // value under the mode that owns it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const key = draftKeyFor(mode);
      if (value) window.localStorage.setItem(key, value);
      else window.localStorage.removeItem(key);
    } catch {
      // Quota / privacy mode — draft just won't survive a refresh. The
      // composer still works fine.
    }
  }, [draftKeyFor, mode, value]);
  // Latest-value mirror so async handlers can read the live input without
  // doing side effects inside a setValue updater (React 19 warns).
  const valueRef = useRef(value);
  valueRef.current = value;

  // Toggle Reply↔Note while keeping each mode's draft independent: persist the
  // outgoing buffer, then load the incoming one into the box. Done in the
  // handler (not a setMode updater) so there's no setState-side-effect-in-
  // updater warning, and so the outgoing text is saved BEFORE mode flips.
  const switchMode = useCallback(
    (next: Mode) => {
      if (next === mode) return;
      try {
        const outKey = draftKeyFor(mode);
        if (valueRef.current)
          window.localStorage.setItem(outKey, valueRef.current);
        else window.localStorage.removeItem(outKey);
        setValue(window.localStorage.getItem(draftKeyFor(next)) ?? "");
      } catch {
        setValue("");
      }
      setMode(next);
    },
    [mode, draftKeyFor],
  );

  const [error, setError] = useState<string | null>(null);
  const [attachment, setAttachment] = useState<File | null>(null);
  // A file whose caption can't be inlined (WhatsApp audio, ALL Messenger/IG
  // media) sends on its OWN — the textarea is disabled while it's attached so no
  // caption gets typed, dropped, and lost. The agent sends text as its own
  // message. Kept here (not per-render) so disabled + placeholder agree.
  const attachmentSendsAlone =
    attachment != null &&
    !supportsInlineCaption(channel, kindFromMimeClient(attachment.type));
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [translateOpen, setTranslateOpen] = useState(false);
  const [refineOpen, setRefineOpen] = useState(false);
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
  // clientTempId of a failed message being RETRIED (set when a retry prefill
  // fires; consumed by the next send). The next send REUSES it instead of
  // minting a fresh one so the server's jobId (`msg-send-<clientTempId>`) +
  // OutboundSendAttempt idempotency dedupe the retry against the original —
  // the send pipeline is explicitly designed around this (see send-queue.ts).
  // Minting a new id on retry defeated it: an ambiguously-failed original that
  // Meta actually delivered would double-send on retry.
  const retryClientTempIdRef = useRef<string | null>(null);

  // Accidental double-fire guard. Holding Enter or double-clicking sends the
  // SAME draft twice — the input clears synchronously, but the second keydown
  // fires before React re-renders, so its `value` closure still has the
  // original text, and each fires a fresh `clientTempId` → Meta delivers the
  // same message twice. We drop an IDENTICAL submission (same text + file)
  // within ~800ms. This replaces the old blanket in-flight lock,
  // which also froze the composer for the ENTIRE round-trip — so an agent
  // couldn't send a quick text while a 90s video upload was still going. The
  // pipeline already supports concurrent sends (per-`clientTempId` optimistic
  // bubbles, confirm listeners, watchdogs, and `pendingFilesRef`); only this
  // lock was serializing them.
  const lastSubmitRef = useRef<{ sig: string; at: number }>({ sig: "", at: 0 });
  // Number of sends whose HTTP request is still in flight. A COUNTER (not a
  // boolean) so overlapping sends don't corrupt each other's lifecycle. Only
  // used to gate the auto-assign/reopen pill re-arm during in-flight prop churn.
  const inFlightCountRef = useRef(0);

  // Tracks whether THIS tab already emitted the optimistic AI-pause for the
  // current "AI on" stretch, so a rapid burst of replies fires exactly one
  // optimistic `ai_paused` pill (the server only writes one — it's idempotent
  // on the conversation's current value). Reset whenever AI flips back on
  // (explicit resume), so the next reply after a resume pauses again.
  const aiPauseEmittedRef = useRef(false);
  useEffect(() => {
    if (aiEnabled) aiPauseEmittedRef.current = false;
  }, [aiEnabled]);
  // Same once-per-stretch guards for the auto-assign + reopen pills. Without
  // them a rapid second send — fired before the parent re-passes the updated
  // `assignedUserId`/`status` props (the optimistic flip is only a local socket
  // frame, the props lag a render) — would emit a duplicate "self-assigned" /
  // "reopened" pill. Reset when the conversation actually becomes unassigned /
  // non-open again (a teammate unassigns, the chat closes), mirroring the
  // aiEnabled-keyed reset above.
  // Reset the once-guards only when the conversation GENUINELY becomes
  // unassigned / non-open AND no send is in flight. The props mirror live
  // socket state, so during an in-flight send they can transiently flip (a
  // stale authoritative frame, the optimistic dispatch settling, a rollback) —
  // resetting on that transient would let a rapid second send emit a DUPLICATE
  // assign/reopen pill. Gating on `inFlightCountRef.current === 0` ignores the
  // in-flight churn; a real teammate change (no send active) still re-arms.
  const selfAssignEmittedRef = useRef(false);
  useEffect(() => {
    if (assignedUserId == null && inFlightCountRef.current === 0) {
      selfAssignEmittedRef.current = false;
    }
  }, [assignedUserId]);
  const reopenEmittedRef = useRef(false);
  useEffect(() => {
    if (status != null && status !== "open" && inFlightCountRef.current === 0) {
      reopenEmittedRef.current = false;
    }
  }, [status]);
  // Live mirrors of the conversation fields the send-failure rollback compares
  // against. The handleSend closure captured the PRE-SEND prop values; the catch
  // runs seconds later and must read the CURRENT state (after this tab's
  // optimistic flip AND any teammate/server change that landed in the in-flight
  // window) to decide whether a revert would clobber a legitimate change.
  const statusRef = useRef(status);
  statusRef.current = status;
  const assignedUserIdRef = useRef(assignedUserId);
  assignedUserIdRef.current = assignedUserId;
  const aiEnabledLiveRef = useRef(aiEnabled);
  aiEnabledLiveRef.current = aiEnabled;
  // Active post-send stuck-watchdogs (timer + window-listener pairs). Tracked
  // so a chat-switch (this reply-box unmounts) before a send confirms can't
  // leave a 30s timer that later fires `onOptimisticFail` for the PREVIOUS
  // conversation's bubble (the parent inbox-shell stays mounted, so a stale
  // timer would mark a possibly-delivered message failed in the cached thread).
  const watchdogCleanupsRef = useRef<Set<() => void>>(new Set());
  // minor#13: a send registers its stuck-watchdog AFTER an awaited fetch. If this
  // reply-box unmounts (chat switch) DURING that await, the unmount drain below
  // has already run, so a watchdog registered afterward would never be drained —
  // it would fire onOptimisticFail for the PREVIOUS conversation 30s later. Track
  // mounted state so the post-await registration can skip once unmounted.
  const mountedRef = useRef(true);
  useEffect(() => {
    // Set true in the effect BODY (not just the useRef initializer): under React
    // StrictMode (dev) the component mounts → unmounts → remounts on the SAME
    // refs, and the simulated unmount's cleanup flips this to false. Without
    // resetting here, mountedRef stays false for the rest of the dev lifetime and
    // the post-send stuck-watchdog below would never register (safety net off in
    // dev). Prod (single mount) is unaffected either way.
    mountedRef.current = true;
    const cleanups = watchdogCleanupsRef.current;
    return () => {
      mountedRef.current = false;
      for (const c of cleanups) c();
      cleanups.clear();
    };
  }, []);

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
    [
      slashRange,
      value,
      contact,
      currentUser,
      lastInboundAt,
      windowStatus.state,
      stageCatalog,
      tags,
    ],
  );

  const isNote = mode === "note";
  // When the WhatsApp window is closed, only Notes + Templates are allowed.
  // Per-channel text cap in the SAME unit the server gate (checkTextCap) and
  // Meta enforce: Instagram counts UTF-8 bytes (caps.textLimitIsBytes), everyone
  // else UTF-16 chars. Measuring bytes here means a multibyte (Arabic/emoji) IG
  // draft that would 400 server-side is caught BEFORE we paint an optimistic
  // "sent" bubble, and the counter warns with the real remaining budget.
  // Measure the TRIMMED value — submit() sends value.trim() and the server's
  // checkTextCap measures that trimmed body, so counting the raw value would
  // wrongly block a valid message padded with trailing/leading whitespace.
  const byteTextMode = caps.textLimitIsBytes === true;
  const trimmedValue = value.trim();
  const textSize = byteTextMode
    ? new TextEncoder().encode(trimmedValue).length
    : trimmedValue.length;
  const overTextCap = !isNote && textSize > caps.messageTextMaxChars;

  // Free-form text and media both require the 24h customer-service window
  // to be open — Meta would reject them with error 131047 otherwise.
  const canSend =
    (attachment !== null || value.trim().length > 0) &&
    (isNote || !windowClosed) &&
    !overTextCap;

  // Single entry point for attaching a file — reused by the file-input,
  // paste-to-attach, and drag-and-drop paths. Enforces the same Meta size cap
  // up-front so a too-large file is rejected before a multi-minute upload.
  const acceptFile = useCallback(
    (file: File | null | undefined) => {
      if (!file) return;
      if (isNote || windowClosed) return; // notes + closed window can't attach
      // Per-channel supported-KIND gate (mirrors the server): Instagram DM can't
      // send documents, so reject one up front instead of burning an upload that
      // 400s. Size/mime still gate below.
      const fileKind = kindFromMimeClient(file.type);
      if (!channelSupportsMediaKind(channel, fileKind)) {
        setError(
          `${CHANNEL_LABEL[channel]} doesn't support sending ${
            fileKind === "document" ? "documents" : `${fileKind}s`
          }.`,
        );
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }
      const limit = pickSizeLimit(file, channel);
      if (file.size > limit.bytes) {
        setError(
          `${limit.label} attachments can't exceed ${formatMb(limit.bytes)}. Try a smaller file.`,
        );
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }
      setError(null);
      setAttachment(file);
    },
    [isNote, windowClosed, channel],
  );

  // -------------------------------------------------------------------------
  // Template picker state
  // -------------------------------------------------------------------------
  const [pickerOpen, setPickerOpen] = useState(false);
  // The contact panel's "Send template" button opens THIS picker (the full flow
  // lives here). Only for a WhatsApp thread that actually supports templates,
  // and only this thread's composer (conversationId guard). Reuses the exact
  // same picker + send path the closed-window button uses.
  useEffect(() => {
    if (!caps.templates) return;
    return onOpenTemplatePicker((cid) => {
      if (cid === conversationId) setPickerOpen(true);
    });
  }, [caps.templates, conversationId]);
  // Interactive (buttons) popover state. Synchronous-send agent-side
  // counterpart of the workflow ask_question step's interactive path.
  const [interactiveOpen, setInteractiveOpen] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
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
      const res = await apiFetch("/api/workspace/whatsapp/templates");
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
      const res = await apiFetch("/api/workspace/whatsapp/templates", { method: "POST" });
      const data = (await res.json()) as {
        templates?: TemplateDto[];
        error?: string;
        detail?: string;
      };
      if (!res.ok) {
        // 409 with `waba_id_missing` → flag the picker so it renders the
        // setup nudge instead of a generic error. This key is a WIRE CONTRACT:
        // renaming it server-side without this line silently degrades the
        // nudge into a generic toast, which is why the two move together.
        if (res.status === 409 && data.error === "waba_id_missing") {
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
      variables: {
        body: string[];
        bodyNamed?: Array<{ name: string; text: string }>;
        header?: string;
        headerMedia?: { kind: "image" | "video" | "document"; link: string; filename?: string };
        headerLocation?: { latitude: string; longitude: string; name: string; address: string };
        buttons?: Array<{ index: number; subType: "url" | "copy_code" | "quick_reply"; text: string }>;
        /** Limited-time offer expiry, UNIX ms. Required when the template shows a
         *  countdown — Meta has nothing to count to without it. */
        limitedTimeOfferExpiresAtMs?: number;
        /** Per-card values for a media-card carousel, in card order. The length
         *  must equal the card count the template was APPROVED with. */
        cards?: Array<{
          headerMedia: { kind: "image" | "video"; link?: string; id?: string };
          body?: string[];
          buttons?: Array<{
            index: number;
            subType: "url" | "quick_reply" | "copy_code";
            text: string;
          }>;
        }>;
      };
    }) => {
      const clientTempId = newClientTempId();
      try {
        const res = await apiFetch("/api/messages/template", {
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
          // Named templates substitute by NAME — rendering them positionally
          // left `{{order_id}}` visible in the list preview until the real
          // `message:new` frame replaced it.
          preview: (args.variables.bodyNamed
            ? renderTemplateBodyNamed(args.template.bodyText, args.variables.bodyNamed)
            : renderPlaceholders(args.template.bodyText, args.variables.body)
          ).slice(0, 200),
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

  // Auto-focus the composer once when a thread opens (the box remounts per
  // thread via ThreadWorkspace `key`), so the agent can type immediately —
  // matches WhatsApp Web / Slack / Telegram. Desktop only (pointer: fine) so a
  // touch device doesn't pop the soft keyboard on open; skipped in note mode.
  // `preventScroll` so focusing doesn't nudge the thread's scroll position.
  useEffect(() => {
    if (typeof window === "undefined" || isNote) return;
    if (!window.matchMedia?.("(pointer: fine)").matches) return;
    const id = window.requestAnimationFrame(() =>
      ref.current?.focus({ preventScroll: true }),
    );
    return () => window.cancelAnimationFrame(id);
    // Mount-only — see the per-thread remount note above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    // Reuse the failed message's clientTempId on the next send so the server
    // dedupes the retry against the original (jobId + OutboundSendAttempt).
    retryClientTempIdRef.current = prefill.clientTempId ?? null;
    let restoredCaption: string | null = null;
    let fileRestored = false;
    if (prefill.clientTempId) {
      const entry = pendingFilesRef.current.get(prefill.clientTempId);
      if (entry) {
        setAttachment(entry.file);
        restoredCaption = entry.caption;
        fileRestored = true;
        pendingFilesRef.current.delete(prefill.clientTempId);
      }
    }
    // The failed message had an attachment but its File is no longer cached
    // (retry after a thread switch remounted this ReplyBox, dropping
    // `pendingFilesRef`). Warn + prompt a re-attach instead of silently
    // resending caption-only text — the customer would otherwise get the
    // caption with no file and no indication anything was lost.
    if (prefill.mediaKind && !fileRestored) {
      toast.error("Original file is no longer available", {
        description: "Please re-attach it before resending.",
      });
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

    // Drop an IDENTICAL submission fired within ~800ms (held Enter / double
    // click) — that's the accidental double-send this guards. A DIFFERENT
    // message is NOT blocked, so a quick text can go out while an earlier
    // media upload is still in flight. `lastModified` disambiguates two
    // different files that happen to share a name+size.
    const submitSig = `${isNote ? "note" : "msg"}|${trimmed}|${
      file ? `${file.name}:${file.size}:${file.lastModified}` : ""
    }|${overrideVoice ? "v" : ""}`;
    const nowMs = Date.now();
    if (
      submitSig === lastSubmitRef.current.sig &&
      nowMs - lastSubmitRef.current.at < 800
    ) {
      return;
    }
    lastSubmitRef.current = { sig: submitSig, at: nowMs };

    // Reuse a retried message's clientTempId (set by the retry prefill) so the
    // server dedupes this against the original send; otherwise mint a fresh
    // one. Consumed once — a subsequent fresh compose gets a new id.
    // `isRetry` is captured BEFORE the ref is cleared: only a retry can collide
    // with a lingering failed job, so it tells the server to run its failed-job
    // cleanup probe (skipped on the common first-send path).
    const isRetry = retryClientTempIdRef.current !== null;
    const clientTempId = retryClientTempIdRef.current ?? newClientTempId();
    retryClientTempIdRef.current = null;
    const snapshotValue = value;
    // Set when this send optimistically pauses AI / self-assigns / reopens (see
    // the block after the optimistic paint); the catch path rolls each back if
    // the send fails.
    let aiPauseOptimisticId: string | null = null;
    let assignOptimisticId: string | null = null;
    let statusOptimisticId: string | null = null;
    // Did this send's bubble get CONFIRMED by message:new before the HTTP
    // settled? If so the send actually reached the server — even when the HTTP
    // response was then lost (502 / mobile timeout AFTER delivery) — so the
    // auto-assign/reopen/AI-pause genuinely persisted and the authoritative
    // frames + pills already landed. Reverting them in the catch (and deleting
    // the now-confirmed pills) would leave the header/timeline wrong until a
    // reconnect refetch. The reconcile dispatches `ccp:optimistic-confirmed:
    // <clientTempId>` (same signal the stuck-watchdog below uses); we latch it
    // so the rollback can no-op, mirroring how markOptimisticFailed /
    // removeOptimistic only ever touch a STILL-pending bubble.
    let sendConfirmed = false;
    const confirmEv = `ccp:optimistic-confirmed:${clientTempId}`;
    const onSendConfirmed = () => {
      sendConfirmed = true;
    };
    if (!isNote) window.addEventListener(confirmEv, onSendConfirmed);
    // A caption only rides along when the channel + media kind actually inline
    // it (WhatsApp image/video/document). Everywhere else — WhatsApp audio,
    // ALL Messenger/Instagram media — the file is sent ON ITS OWN: Meta can't
    // attach text to it, and delivering the text as a separate follow-up echoed
    // back as a corrupt "via app" duplicate. So the textarea contents don't leak
    // onto the file; the agent sends text as its own message. Voice-only sends
    // (overrideFile) likewise carry no caption.
    const attachmentInlineCaption =
      file != null && supportsInlineCaption(channel, kindFromMimeClient(file.type));
    const effectiveCaption = overrideFile || !attachmentInlineCaption ? "" : trimmed;
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
        // Whether Meta lets the caption ride INLINE on this media (WhatsApp
        // image/video/document). When it can't (WhatsApp audio/sticker, all
        // social media) the server delivers + persists the caption as a SEPARATE
        // tracked message, so paint the optimistic media with NO caption from the
        // start — otherwise the caption flashes ON the audio for a beat, then
        // the server's split yanks it into its own bubble (the flicker).
        const inlineCaption = supportsInlineCaption(channel, kind);
        const mediaCaptionText = inlineCaption ? effectiveCaption : "";
        // Local blob URL works as the bubble's media src until the server
        // reply swaps in /api/media/<id>. The browser keeps the blob alive
        // as long as some element references it.
        const blobUrl = URL.createObjectURL(file);
        optimisticMessage = {
          id: clientTempId,
          workspaceId: currentUser.workspaceId,
          conversationId,
          externalId: clientTempId,
          senderUserId: currentUser.id,
          body: mediaCaptionText,
          direction: "out",
          channel,
          status: "sent",
          rawPayload: {},
          timestamp: ts,
          clientTempId,
          pending: true,
          // Send-order stamp; assigned here (synchronously, before the
          // auto-pause pill dispatch below) so the message orders before the
          // pill it triggers. See optimistic-seq.ts.
          optimisticSeq: nextOptimisticSeq(),
          // Anchor the auto-claim pills (below) to THIS message's timeline slot
          // by sharing its clientTempId as the group key — so "reopened" /
          // "self-assigned" stay docked under the reply regardless of their
          // racy/late server audit `at`. See message-thread.tsx anchor sort.
          optimisticGroupId: clientTempId,
          ...(reply ? { replyToMessageId: reply.id, replyTo: reply } : {}),
          media: {
            kind,
            url: blobUrl,
            mimeType,
            sizeBytes: file.size,
            ...(mediaCaptionText ? { caption: mediaCaptionText } : {}),
            ...(kind === "document" ? { filename: file.name } : {}),
            // Voice recording → show the mic affordance on the optimistic
            // bubble immediately (server confirms it via mediaVoice).
            ...(overrideVoice ? { voice: true } : {}),
          },
        };
        // Caption-less media has an empty body — use the same media label the
        // server writes so the list preview reads "🎤 Voice message" etc.
        listPreview = (effectiveCaption || mediaPreviewLabel(kind)).slice(0, 200);
      } else if (trimmed) {
        optimisticMessage = {
          id: clientTempId,
          workspaceId: currentUser.workspaceId,
          conversationId,
          externalId: clientTempId,
          senderUserId: currentUser.id,
          body: trimmed,
          direction: "out",
          channel,
          status: "sent",
          rawPayload: {},
          timestamp: ts,
          clientTempId,
          pending: true,
          // Send-order stamp; see the media branch above + optimistic-seq.ts.
          optimisticSeq: nextOptimisticSeq(),
          // Anchor the auto-claim pills to this message — see the media branch.
          optimisticGroupId: clientTempId,
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

        // Mirror EVERY side-effect the server's autoAssignOnAgentSend writes on
        // a human reply (messages.service.ts): pause AI, self-assign an
        // unassigned chat, and reopen a non-`open` one. Each writes an activity
        // log that otherwise arrives a round-trip later via the authoritative
        // events GET as a server-clocked, NON-pinned row — which floats ABOVE
        // the still-pending send, then snaps BELOW once the send reconciles (the
        // "logs jump up then down" glitch the user sees). Emitting them here
        // pins each pill in send order right after the bubble (shared
        // optimisticSeq), correct from the first paint.
        //
        // Build order = ai → REOPEN → self-assign. The ascending optimisticSeq
        // assigned here is the order these pills KEEP after the send confirms,
        // because all three share a `sendGroupId` (this send's clientTempId) and
        // the timeline sorts pills WITHIN one group by seq — NOT by the racy
        // server audit `at`, which the server writes near-simultaneously and so
        // can come back in either order (see message-thread.tsx pin/sort). So
        // this IS the final settled order: "reopened" then "self-assigned". The
        // old build order (ai → assigned → reopen) flashed the self-assign pill
        // ABOVE reopen optimistically, then it dropped below once the server
        // pills un-pinned and re-sorted by `at` — the upper-thread "vibration" on
        // an auto-claim into a pending/closed + unassigned + AI-on chat. The
        // group key is what keeps this NARROW: only these same-send pills are
        // seq-ordered; every independent log (dropdown status/assign, teammate
        // actions, stage/tag, history) has no group and still sorts purely by
        // `at`. Every header flip + pill goes into ONE dispatch so they commit in
        // a single paint (separate dispatches each flushSync → multiple paints →
        // the "log lags everything else" gap). Each is gated once-per-stretch
        // (see the *EmittedRef guards) so a rapid burst before the props catch up
        // doesn't double-emit.
        const sendFrames: Parameters<typeof dispatchLocalSocketEvents>[0] = [];
        if (aiAutopilotEnabled && aiEnabled && !aiPauseEmittedRef.current) {
          aiPauseEmittedRef.current = true;
          const aiActivity = buildOptimisticAiChange({
            workspaceId: currentUser.workspaceId,
            conversationId,
            actorName: currentUser.name,
            aiEnabled: false,
            sendGroupId: clientTempId,
          });
          aiPauseOptimisticId = aiActivity.id;
          sendFrames.push(
            [
              "conversation:ai",
              { workspaceId: currentUser.workspaceId, conversationId, aiEnabled: false, optimistic: true },
            ],
            aiActivity.frame,
          );
        }
        // Auto-reopen: the server promotes a non-`open` conversation to open on
        // send (covers both the unassigned-claim and the already-assigned paths).
        // Emitted BEFORE the self-assign so the pills settle "reopened" then
        // "self-assigned" (see the build-order note above).
        if (status != null && status !== "open" && !reopenEmittedRef.current) {
          reopenEmittedRef.current = true;
          const statusActivity = buildOptimisticStatusChange({
            workspaceId: currentUser.workspaceId,
            conversationId,
            actorName: currentUser.name,
            status: "open",
            sendGroupId: clientTempId,
          });
          statusOptimisticId = statusActivity.id;
          sendFrames.push(
            [
              "conversation:status",
              { workspaceId: currentUser.workspaceId, conversationId, status: "open", optimistic: true },
            ],
            statusActivity.frame,
          );
        }
        // Auto-claim: the server self-assigns an UNASSIGNED conversation on send.
        if (assignedUserId == null && !selfAssignEmittedRef.current) {
          selfAssignEmittedRef.current = true;
          const assignActivity = buildOptimisticAssignment({
            workspaceId: currentUser.workspaceId,
            conversationId,
            actorName: currentUser.name,
            assignedToName: currentUser.name,
            sendGroupId: clientTempId,
          });
          assignOptimisticId = assignActivity.id;
          sendFrames.push(
            [
              "conversation:assigned",
              { workspaceId: currentUser.workspaceId, conversationId, assignedUser: currentUser, optimistic: true },
            ],
            assignActivity.frame,
          );
        }
        if (sendFrames.length > 0) dispatchLocalSocketEvents(sendFrames);
      }
    }

    // Clear input now so the user can keep typing. Skip clearing `value`
    // when this is a voice-only send so the user's draft in the textarea
    // survives. Also skip it when a "sends-alone" attachment (WhatsApp
    // audio/sticker, ALL Messenger/IG media) just went out WITHOUT the
    // typed text: with no inline caption and no separate follow-up, that
    // text was never delivered, so wiping it here would silently destroy
    // the agent's reply (and the persisted draft with it). Leaving it lets
    // a second Send deliver it — exactly what the placeholder instructs.
    const textWentUnsent = file != null && !attachmentInlineCaption && trimmed !== "";
    if (!overrideFile && !textWentUnsent) setValue("");
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

    // Mark this send in flight (balanced in the finally below) — gates the
    // pill re-arm against transient prop churn while any send is outstanding.
    inFlightCountRef.current += 1;
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
          const res = await apiFetch("/api/messages/media", {
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
          const url = isNote
            ? "/api/notes"
            : `/api/messages${isRetry ? "?retry=1" : ""}`;
          // apiFetch (not bare fetch) so the two highest-frequency sends route
          // through fetchWithSessionGuard like every sibling call — a 401 mid-
          // session cleanly re-auths instead of surfacing a generic send error.
          const res = await apiFetch(url, {
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
        // FE-2: the optimistic list-bump painted a preview for this send; the
        // send failed, so roll the row's preview back to its pre-bump value
        // (no server message:new will arrive to overwrite it). Notes don't bump.
        if (!isNote) emitOptimisticListBumpRevert(conversationId);
        // Roll back the optimistic takeover (AI-pause / self-assign / reopen),
        // but ONLY when this is a genuine failure that left the field as THIS
        // send wrote it. Two guards:
        //   1. `!sendConfirmed` — skip everything if the bubble already
        //      reconciled (the send WAS delivered; its side-effects persisted +
        //      their authoritative frames/pills landed — reverting would wrongly
        //      revert them AND delete the confirmed pills).
        //   2. still-mine — revert a field only if it STILL holds this send's
        //      optimistic value (read live via refs, since the closure captured
        //      pre-send props). A teammate/dropdown change during the in-flight
        //      window must not be clobbered.
        if (!sendConfirmed) {
          // Collect every header revert + its pill removal into ONE dispatch so
          // they commit in a single paint — separate dispatchLocalSocketEvent
          // calls each wrap their own flushSync, which on a 3-pill rollback was
          // up to 6 back-to-back paints (a visible cascade). Mirrors the batched
          // SEND path.
          const tid = currentUser.workspaceId;
          const rollbackFrames: Parameters<typeof dispatchLocalSocketEvents>[0] = [];
          if (aiPauseOptimisticId && aiEnabledLiveRef.current === false) {
            rollbackFrames.push(
              ["conversation:ai", { workspaceId: tid, conversationId, aiEnabled: true }],
              ["conversation:activity", { workspaceId: tid, conversationId, event: null, removeId: aiPauseOptimisticId }],
            );
            aiPauseEmittedRef.current = false;
          }
          if (assignOptimisticId && assignedUserIdRef.current === currentUser.id) {
            rollbackFrames.push(
              ["conversation:assigned", { workspaceId: tid, conversationId, assignedUser: null }],
              ["conversation:activity", { workspaceId: tid, conversationId, event: null, removeId: assignOptimisticId }],
            );
            selfAssignEmittedRef.current = false;
          }
          // `status` is the pre-send value captured in this closure; revert to it
          // only if the live status is still the "open" we optimistically set.
          if (statusOptimisticId && status != null && statusRef.current === "open") {
            rollbackFrames.push(
              ["conversation:status", { workspaceId: tid, conversationId, status }],
              ["conversation:activity", { workspaceId: tid, conversationId, event: null, removeId: statusOptimisticId }],
            );
            reopenEmittedRef.current = false;
          }
          if (rollbackFrames.length > 0) dispatchLocalSocketEvents(rollbackFrames);
        }
        // Restore the user's text (only if they haven't started typing again).
        // Read the live value via ref instead of a setValue updater — putting
        // the onOptimisticRetry side effect inside a state updater triggers
        // React 19's "setState while rendering another component" warning,
        // because updaters can run during render.
        // Only remove the failed bubble + restore the composer for a TEXT send:
        // the text lives in `snapshotValue`, so dropping the bubble loses
        // nothing. For a MEDIA send the attachment File lives only in the
        // failed bubble's retry path (prefill re-seats it from pendingFilesRef
        // via clientTempId); removing the bubble here would orphan the File and
        // restore only the caption — silently losing the attachment. So keep
        // the failed bubble (already flipped by onOptimisticFail) so its Retry
        // stays actionable.
        if (valueRef.current === "" && !file) {
          if (!isNote) onOptimisticRetry?.(clientTempId);
          setValue(snapshotValue);
        }
      } finally {
        // Always clear the timeout — fetch resolved OK, errored, or
        // aborted; either way the timer would otherwise leak until it
        // fires harmlessly later.
        window.clearTimeout(timeoutId);
        // Drop the confirm latch listener — the rollback decision (catch, above)
        // already read `sendConfirmed`. The post-HTTP stuck-watchdog below keeps
        // its own (separate) confirm listener for the success path.
        if (!isNote) window.removeEventListener(confirmEv, onSendConfirmed);
        // Balance the in-flight counter. In finally (not after setValue) so an
        // unexpected throw can't leak a count and wedge the pill-gate.
        inFlightCountRef.current = Math.max(0, inFlightCountRef.current - 1);
      }

      // Post-HTTP watchdog: if the HTTP request returned successfully but
      // the server never emits the confirming `message:new` socket frame
      // (worker crashed mid-Meta-send, bus subscriber threw, browser missed
      // the frame between subscribe-conversation and emit), the optimistic
      // bubble would sit in `pending: true` forever. After 30s, flip it to
      // failed so the user sees a Retry affordance. The matching reducer
      // dispatches `ccp:optimistic-confirmed` when the frame DOES arrive,
      // which cancels this watchdog.
      // minor#13: skip if the reply-box unmounted during the awaited send — the
      // unmount drain already ran, so a watchdog registered now would leak and
      // fire for the previous conversation. No await between this check and the
      // synchronous registration below, so the guard can't go stale mid-block.
      if (!isNote && mountedRef.current) {
        const STUCK_WATCHDOG_MS = 30_000;
        const ev = `ccp:optimistic-confirmed:${clientTempId}`;
        let cleanup = () => {};
        const watchdogId = window.setTimeout(() => {
          cleanup();
          onOptimisticFail?.(clientTempId);
        }, STUCK_WATCHDOG_MS);
        const onConfirmed = () => {
          cleanup();
          // The send is confirmed by message:new — no Retry will ever need this
          // cached File again, so drop it. Successful media sends would
          // otherwise leak their File for the ReplyBox mount lifetime (pasted /
          // dropped screenshots are memory-backed Blobs). Failed sends keep
          // their entry — the catch path left the bubble's Retry actionable.
          pendingFilesRef.current.delete(clientTempId);
        };
        cleanup = () => {
          window.clearTimeout(watchdogId);
          window.removeEventListener(ev, onConfirmed);
          watchdogCleanupsRef.current.delete(cleanup);
        };
        // Registered so unmount (chat-switch) clears it; self-removes on
        // confirm or after firing.
        watchdogCleanupsRef.current.add(cleanup);
        window.addEventListener(ev, onConfirmed, { once: true });
      }
    })();
  };

  return (
    <div className="relative border-t border-border bg-background">
      {/* max-w-6xl: keep in sync with the message-list container
          (message-thread.tsx) so the composer and messages line up at the same
          width — otherwise the two columns look misaligned / gappy. */}
      <div className="mx-auto w-full max-w-6xl px-4 pt-3 pb-4">
        {/* flex-wrap + gap-y so that if the thread is ever narrow enough that
            the toggle + window badge + Send template can't share one line, they
            wrap onto the next line instead of overlapping. The resizers also
            clamp the thread to MIN_THREAD_WIDTH so this is just a safety net. */}
        <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <div className="inline-flex shrink-0 rounded-md border border-border bg-muted/40 p-0.5">
            <ToggleButton active={mode === "reply"} onClick={() => switchMode("reply")} icon={MessageSquare} label="Reply" />
            <ToggleButton active={mode === "note"} onClick={() => switchMode("note")} icon={StickyNote} label="Note" />
          </div>
          {!isNote && <WindowBadgeFromStatus status={windowStatus} size="sm" />}
          {!isNote && windowClosed && caps.templates && (
            <Button
              type="button"
              size="sm"
              className="ml-auto h-7 shrink-0 gap-1.5 text-xs"
              onClick={() => setPickerOpen(true)}
            >
              <Sparkles className="size-3.5" />
              Send template
            </Button>
          )}
        </div>

        <motion.div
          // NO `layout`: it made framer-motion spring-animate every size change
          // — including the WIDTH change while the user drags the list/thread
          // resize handle, so the composer visibly lagged behind the edge in
          // slow motion. The inner reply-pill / attachment previews animate
          // their own height via AnimatePresence, so the card still grows
          // smoothly on content changes without the outer layout animation.
          // Drag-and-drop a file anywhere onto the composer card to attach it
          // (mirrors the paste-to-attach path). No-op in note / closed-window
          // mode where attachments aren't allowed.
          onDragOver={(e) => {
            if (!isNote && !windowClosed) e.preventDefault();
          }}
          onDrop={(e) => {
            if (isNote || windowClosed) return;
            const f = e.dataTransfer?.files?.[0];
            if (f) {
              e.preventDefault();
              acceptFile(f);
            }
          }}
          className={cn(
            // Neutral focus-within on the CARD (matches the input.tsx recipe):
            // border darkens + soft neutral halo when the textarea inside is
            // focused. Replaces the old loud green ring.
            "relative rounded-xl border transition-[color,box-shadow,border-color] focus-within:ring-2 focus-within:ring-foreground/10",
            isNote
              ? "border-note-border bg-note-bg/40 focus-within:border-note-border"
              : "border-border bg-card focus-within:border-foreground/30",
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
                transition={{ duration: 0.2, ease: "easeOut" }}
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
            // Accessible name — the placeholder alone is a weak label and
            // vanishes on input, leaving the composer unnamed for screen readers.
            aria-label={isNote ? "Internal note" : "Reply message"}
            // dir="auto" so an agent typing Arabic/Hebrew sees the composer
            // right-align with correct base direction, matching the bubble it
            // produces. Latin input stays LTR.
            dir="auto"
            // Per-channel text cap (WhatsApp 4096 / Messenger 2000 / Instagram
            // 1000) from the capability map. Cap the input in reply mode so a
            // long paste can't sail through and 400 server-side after painting an
            // optimistic bubble — with the counter below reading the same cap so a
            // Retry isn't hopeless. A char `maxLength` can't express Instagram's
            // BYTE cap (a multibyte body is under 1000 chars but over 1000 bytes),
            // so in byte mode we drop the hard limit and let the byte counter +
            // disabled Send below govern. Notes are DB-only (no cap).
            maxLength={isNote || byteTextMode ? undefined : caps.messageTextMaxChars}
            value={value}
            // Paste an image/file straight onto the composer to attach it —
            // the single most common support gesture. Falls through to normal
            // text paste when the clipboard carries no file.
            onPaste={(e) => {
              if (isNote || windowClosed) return;
              const f = e.clipboardData?.files?.[0];
              if (f) {
                e.preventDefault();
                acceptFile(f);
              }
            }}
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
            disabled={!isNote && (windowClosed || attachmentSendsAlone)}
            placeholder={
              isNote
                ? "Leave an internal note for your teammates…"
                : windowClosed
                  ? caps.templates
                    ? "Free-form replies blocked — send a pre-approved template to re-engage."
                    : "Free-form replies blocked — wait for the customer to message again to re-open the conversation."
                  : attachment
                    ? attachmentSendsAlone
                      ? "This file sends on its own — send a message separately after."
                      : "Add a caption (optional)…"
                    : `Reply on ${CHANNEL_LABEL[channel]}…`
            }
            className={cn(
              // field-sizing-content grows the box with the draft from the
              // min-h floor up to max-h-48, then scrolls internally — so a
              // multi-line reply is fully visible instead of trapped in a
              // fixed 88px window.
              // No focus ring on the textarea itself — the composer CARD shows
              // the focus state (focus-within) so we don't double up. Green ring
              // removed here too (see input.tsx neutral recipe).
              "max-h-48 min-h-22 resize-none overflow-y-auto border-0 bg-transparent px-3.5 py-3 text-sm shadow-none focus-visible:ring-0 field-sizing-content",
              !isNote && windowClosed && "cursor-not-allowed opacity-60",
            )}
            onKeyDown={(e) => {
              // ⌘/Ctrl+Enter is an explicit "send now" — fires even when the
              // slash picker is open or the agent has trained Enter=newline
              // muscle memory in another tool.
              if (
                e.key === "Enter" &&
                (e.metaKey || e.ctrlKey) &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                setSlashRange(null);
                submit();
                return;
              }
              // Snippet picker has first dibs on Enter / Tab / Arrows / Esc
              // when it's open. Its global keydown listener calls
              // preventDefault + inserts the highlighted snippet, but React's
              // synthetic pipeline still delivers the key here — so the send
              // branch below must be skipped whenever the popup owns the
              // keypress. We preventDefault here too so the composer is
              // self-sufficient: even when the popup has NO match (its listener
              // returns without preventDefault), Enter/Tab must never send NOR
              // leak a stray newline into the draft. Enter only sends when the
              // popup is closed (slashRange === null).
              if (
                slashRange &&
                (e.key === "Enter" || e.key === "Tab" || e.key === "ArrowUp" || e.key === "ArrowDown")
              ) {
                e.preventDefault();
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
                // A fast typist can hit Enter within the 50ms slash-detect
                // debounce — before `slashRange` is set — which would otherwise
                // send the literal "/snippet" text. Detect synchronously here:
                // if the caret sits on a /query, open the picker instead of
                // sending.
                const el = e.currentTarget;
                const pendingSlash = detectSlashQuery(
                  el.value,
                  el.selectionStart ?? el.value.length,
                );
                if (pendingSlash) {
                  setSlashRange(pendingSlash);
                  return;
                }
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
                // Guard BEFORE collecting — `stopAndCollect()` finalizes and
                // tears down the recording, so if `submit` then no-ops (the 24h
                // window flipped closed mid-recording) the captured audio would
                // vanish silently. Keep the recording running + surface why.
                // (A send already in flight no longer blocks this — sends run
                // concurrently now — so only the window check remains.)
                if (!isNote && windowClosed) {
                  toast.error("Can't send: the messaging window has closed.", {
                    description: caps.templates
                      ? "Send a template to re-open the conversation."
                      : "Wait for the customer to message again to re-open it.",
                  });
                  return;
                }
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
          <div className="@container flex items-center gap-1 px-2 pb-2 pt-0">
            <input
              ref={fileInputRef}
              type="file"
              hidden
              // Wide accept list — server validates by mime type and size.
              accept="image/*,video/*,audio/*,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain"
              // Client-side guardrails against Meta's hard caps live in
              // acceptFile (shared with the paste + drag-drop paths). Without
              // them a 12MB iPhone photo would upload for minutes on 3G before
              // the server rejected it. See
              // https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media
              onChange={(e) => acceptFile(e.target.files?.[0])}
            />
            <Button
              variant="ghost"
              size="icon"
              className="size-8 pointer-coarse:size-9 text-muted-foreground disabled:text-muted-foreground/40"
              type="button"
              disabled={isNote || windowClosed}
              aria-label="Attach file"
              title={
                isNote
                  ? "Notes can't have attachments"
                  : windowClosed
                    ? caps.templates
                      ? "Window closed — only templates can be sent"
                      : "Window closed — wait for the customer to message again"
                    : "Attach image, video, audio, or document"
              }
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip className="size-4" />
            </Button>
            {caps.templates && (
              <Button
                variant="ghost"
                size="icon"
                className="size-8 pointer-coarse:size-9 text-muted-foreground disabled:text-muted-foreground/40"
                type="button"
                disabled={isNote}
                aria-label="Send a template"
                title={
                  isNote
                    ? "Templates can only be sent in Reply mode"
                    : "Send a pre-approved template"
                }
                onClick={() => setPickerOpen(true)}
              >
                <Sparkles className="size-4" />
              </Button>
            )}
            {caps.interactive && (
            <div className="relative">
              <Button
                variant="ghost"
                size="icon"
                className="size-8 pointer-coarse:size-9 text-muted-foreground disabled:text-muted-foreground/40"
                type="button"
                disabled={isNote || windowClosed}
                aria-label="Send buttons"
                title={
                  isNote
                    ? "Buttons can only be sent in Reply mode"
                    : windowClosed
                      ? "Window closed — buttons require the messaging window to be open"
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
                    window.localStorage.removeItem(draftKeyFor("reply"));
                  } catch {
                    // ignore quota / private-mode failures
                  }
                }}
              />
            </div>
            )}
            {caps.sendLocation && (
              <div className="relative">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 pointer-coarse:size-9 text-muted-foreground disabled:text-muted-foreground/40"
                  type="button"
                  disabled={isNote || windowClosed}
                  aria-label="Send location"
                  title={
                    isNote
                      ? "Locations can only be sent in Reply mode"
                      : windowClosed
                        ? "Window closed — reopen the messaging window to send a location"
                        : "Send a location"
                  }
                  onClick={() => setLocationOpen(true)}
                >
                  <MapPin className="size-4" />
                </Button>
                <LocationComposer
                  open={locationOpen}
                  onClose={() => setLocationOpen(false)}
                  conversationId={conversationId}
                  onSent={() => {}}
                />
              </div>
            )}
            {caps.sendContacts && (
              <div className="relative">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 pointer-coarse:size-9 text-muted-foreground disabled:text-muted-foreground/40"
                  type="button"
                  disabled={isNote || windowClosed}
                  aria-label="Send a contact"
                  title={
                    isNote
                      ? "Contacts can only be sent in Reply mode"
                      : windowClosed
                        ? "Window closed — reopen the messaging window to send a contact"
                        : "Send a contact"
                  }
                  onClick={() => setContactOpen(true)}
                >
                  <UserRound className="size-4" />
                </Button>
                <ContactComposer
                  open={contactOpen}
                  onClose={() => setContactOpen(false)}
                  conversationId={conversationId}
                  onSent={() => {}}
                />
              </div>
            )}
            <div className="relative">
              <Button
                variant="ghost"
                size="icon"
                className="size-8 pointer-coarse:size-9 text-muted-foreground"
                type="button"
                /* Emojis are valid in NOTES regardless of the messaging
                   window (a note is internal, never sent to the customer), so
                   this is gated only on the reply-mode window — matching the
                   textarea it types into. Leaving it always-enabled let an
                   agent open the picker and "insert" into a disabled composer
                   on a closed window: the character appeared and could not be
                   sent. Templates stay the one action a closed window allows. */
                disabled={!isNote && windowClosed}
                aria-label="Insert emoji"
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
              ariaLabel="Record voice message"
              title={
                isNote
                  ? "Voice messages aren't supported in Note mode"
                  : windowClosed
                    ? caps.templates
                      ? "Window closed — only templates can be sent"
                      : "Window closed — wait for the customer to message again"
                    : "Record a voice message"
              }
            />
            {/* Translate the current draft to a language of choice (DeepL).
                Sits right next to the voice button; replaces the composer text
                with the translation. */}
            <div className="relative">
              <Button
                variant="ghost"
                size="icon"
                className="size-8 pointer-coarse:size-9 text-muted-foreground"
                type="button"
                title="Translate this message"
                aria-label="Translate this message"
                onClick={() => {
                  setEmojiOpen(false);
                  setTranslateOpen((v) => !v);
                }}
              >
                <Languages className="size-4" />
              </Button>
              <TranslatePopover
                open={translateOpen}
                onClose={() => setTranslateOpen(false)}
                text={value}
                onTranslated={(translated) => setValue(translated)}
              />
            </div>

            {/* AI-refine the current draft (Formalise / Friendly / Shorten /
                Fix grammar — Gmail-"Polish"-style). Replaces the composer
                text with the rewrite once the agent hits Apply. */}
            <div className="relative">
              <Button
                variant="ghost"
                size="icon"
                className="size-8 pointer-coarse:size-9 text-muted-foreground"
                type="button"
                title="Refine with AI"
                aria-label="Refine with AI"
                onClick={() => {
                  setEmojiOpen(false);
                  setRefineOpen((v) => !v);
                }}
              >
                <Wand2 className="size-4" />
              </Button>
              <RefinePopover
                open={refineOpen}
                onClose={() => setRefineOpen(false)}
                text={value}
                onRefined={(refined) => setValue(refined)}
              />
            </div>

            <AnimatePresence>
              {isNote && (
                <motion.span
                  key="note-tag"
                  initial={{ opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -4 }}
                  className="ml-1 text-2xs font-medium text-note-fg"
                >
                  Internal · not sent to {CHANNEL_LABEL[channel]}
                </motion.span>
              )}
            </AnimatePresence>

            {/* Trailing cluster: keyboard hint + Send. As the composer is
                squished (resizable list/details eat the thread width), the hint
                drops first, then the Send button collapses to a round
                icon-only button — driven by the @container on this row. */}
            <div className="ml-auto flex items-center gap-2">
              {!isNote && textSize > caps.messageTextMaxChars * 0.85 && (
                <span
                  className={cn(
                    "text-3xs tabular-nums",
                    textSize >= caps.messageTextMaxChars
                      ? "text-destructive"
                      : "text-muted-foreground",
                  )}
                >
                  {textSize}/{caps.messageTextMaxChars}
                </span>
              )}
              <span className="hidden text-3xs text-muted-foreground @[34rem]:inline">
                ↵ to send · ⇧↵ for newline
              </span>
              <Button
                size="sm"
                onClick={() => submit()}
                // No longer disabled while a send is in flight — sends run
                // concurrently (a quick text can go out while a video uploads),
                // and the in-thread optimistic bubble's pending state is the
                // "sending" feedback. Accidental double-fire is caught by the
                // same-content dedupe in `submit()`.
                disabled={!canSend}
                aria-label={isNote ? "Save note" : attachment ? "Send media" : "Send"}
                title={isNote ? "Save note" : attachment ? "Send media" : "Send"}
                className={cn(
                  "h-8 gap-1.5 shadow-xs hover:shadow-sm @max-[26rem]:w-8 @max-[26rem]:gap-0 @max-[26rem]:rounded-full @max-[26rem]:px-0",
                  // Note mode: a warm caramel that complements the beige note
                  // palette (not the dark `note-fg`, which is the note TEXT
                  // color and reads as muddy on a button).
                  isNote && "bg-note-accent text-white hover:bg-note-accent-hover",
                )}
              >
                <Send className="size-3.5" />
                <span className="@max-[26rem]:hidden">
                  {isNote ? "Save note" : attachment ? "Send media" : "Send"}
                </span>
              </Button>
            </div>
          </div>
          )}
        </motion.div>

        {error && (
          <p className="mt-2 text-2xs text-destructive">
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

export const ReplyBox = memo(ReplyBoxImpl);
