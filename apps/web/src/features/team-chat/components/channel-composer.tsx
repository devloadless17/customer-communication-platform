"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  FileText,
  Image as ImageIcon,
  Mic,
  Paperclip,
  SendHorizontal,
  SmilePlus,
  Video,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import { getClientSocket } from "@/lib/socket-client";
import { detectActiveTrigger, insertMention } from "@ccp/shared/team-chat/mentions";
import type { TeamChannelMessageDto } from "@ccp/shared/team-chat/types";
import type { User } from "@ccp/shared/types";

import { MentionPopup, filterMembersByQuery } from "./mention-popup";

// Reused from the inbox reply box rather than rebuilt. Dynamic so its emoji
// tables stay out of the team-chat entry bundle.
const EmojiPopover = dynamic(
  () =>
    import("@/features/inbox/components/reply-box/emoji-popover").then(
      (m) => m.EmojiPopover,
    ),
  { ssr: false },
);

/**
 * Composer for both the channel feed and the thread side panel. The only
 * difference is the POST URL: pass `threadRootId` to post into a thread.
 *
 * Wires up:
 *   - Enter to send (Shift+Enter for newline)
 *   - @ autocomplete with arrow keys / Enter to pick
 *   - file upload via the paperclip (drag-and-drop is still absent)
 *   - emoji insertion at the caret (reuses the inbox EmojiPopover)
 *   - per-(channel, thread) draft persistence across navigation
 *   - server-side reconcile via the matching `team:channel:message` event
 *
 * Optimistic message is added through `onOptimistic*` callbacks so the
 * channel-feed AND thread-panel can use the same composer with their own
 * state hooks.
 */
export function ChannelComposer({
  channelId,
  channelName,
  threadRootId,
  currentUser,
  teamMembers,
  onOptimisticAdd,
  onOptimisticFail,
  onOptimisticConfirm,
}: {
  channelId: string;
  /** Null in a DM — DMs have no channel name, so the composer drops the
   *  "#name" affordance and falls back to a plain prompt. */
  channelName: string | null;
  threadRootId?: string;
  currentUser: User;
  teamMembers: User[];
  onOptimisticAdd: (m: TeamChannelMessageDto) => void;
  onOptimisticFail: (clientTempId: string) => void;
  /**
   * Reconcile the optimistic row from the send's OWN POST response DTO —
   * swaps the tmp id for the server id so a lost `team:channel:message` echo
   * (a send that lands while the socket is dropped past the 30s recovery
   * window) can't leave the bubble pending forever, nor duplicate it on the
   * next reconnect converge. Optional: the thread panel's composer relies on
   * the socket echo alone for now.
   */
  onOptimisticConfirm?: (message: TeamChannelMessageDto, clientTempId: string) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Initial value MUST be "" to match SSR — a lazy initializer reading
  // localStorage would hydrate the Send button's `disabled` attribute
  // mismatched whenever a draft exists. Restore happens post-mount below.
  const [body, setBody] = useState("");
  const [caret, setCaret] = useState(0);
  const [trigger, setTrigger] = useState<{ query: string; length: number } | null>(null);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [popupPos, setPopupPos] = useState<{ left: number; top: number } | null>(null);
  const [busy, setBusy] = useState(false);
  // Staged file from the paperclip picker. We hold it locally and show a
  // preview chip until the user clicks Send — matches the inbox composer's
  // UX. Previously the picker fired the upload immediately, which made
  // accidental clicks impossible to recover from.
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);

  // ARIA combobox wiring for the @-mention popup. Stable ids so the textarea
  // can point aria-controls at the listbox and aria-activedescendant at the
  // highlighted option. Candidates are recomputed at render (same pure filter
  // the keyboard handler uses) so the active-descendant id stays in sync.
  const mentionListboxId = useId();
  // ---- Draft persistence ------------------------------------------------
  //
  // Per (team, channel, thread) so the main composer and each thread panel
  // keep independent buffers.
  const draftKey = `team-chat:${currentUser.workspaceId}:draft:${channelId}${
    threadRootId ? `:t:${threadRootId}` : ""
  }`;

  // Mirror of `body` for the cleanup closure below. Without this the cleanup
  // captures the value from the render in which the effect was CREATED, so it
  // would persist stale text (usually "") over the real draft.
  const bodyRef = useRef(body);
  bodyRef.current = body;

  // ONE effect keyed on draftKey, doing restore-on-enter + save-on-leave.
  //
  // The trap that doesn't exist in the inbox: TeamChatWorkspace is rendered
  // WITHOUT a key, so this composer is NOT remounted when you navigate
  // /team/A → /team/B. A naive mount-only restore would therefore carry
  // channel A's text into channel B and then overwrite A's saved draft with
  // it. Handling both directions here is what makes channel switching safe.
  useEffect(() => {
    let restored = "";
    try {
      restored = window.localStorage.getItem(draftKey) ?? "";
    } catch {
      // Private mode / storage disabled — drafts silently off, composer fine.
    }
    setBody(restored);
    setCaret(restored.length);
    // Everything else that belongs to the channel we just LEFT must go with
    // it. This composer is not remounted on /team/A → /team/B (see above), so
    // a staged attachment stayed on screen and the next Send uploaded it to
    // the new channel — a private file could land in the wrong room with no
    // warning. Drafts are text-only and deliberately per-channel; a picked
    // file has nowhere to be saved, so it is dropped, not carried.
    setPendingFile(null);
    setEmojiOpen(false);
    setTrigger(null);
    setPopupPos(null);

    const persist = () => {
      try {
        const outgoing = bodyRef.current;
        if (outgoing.trim()) window.localStorage.setItem(draftKey, outgoing);
        else window.localStorage.removeItem(draftKey);
      } catch {
        // Ignore — see above.
      }
    };

    // React does NOT run effect cleanups on reload / tab close / hard
    // navigation, and this feature ships two hard navigations of its own
    // (leave-channel and join-channel both use window.location). Without a
    // pagehide save, a refresh silently drops the draft. `pagehide` fires on
    // bfcache navigations where `beforeunload` doesn't.
    window.addEventListener("pagehide", persist);

    return () => {
      window.removeEventListener("pagehide", persist);
      // Persist whatever is in the box for the channel we're LEAVING.
      persist();
    };
  }, [draftKey]);

  /** Drop the saved draft after a successful send. */
  const clearDraft = useCallback(() => {
    try {
      window.localStorage.removeItem(draftKey);
    } catch {
      // Ignore.
    }
  }, [draftKey]);

  /**
   * Splice an emoji in at the tracked caret and restore the selection after
   * React commits — same shape as the @-mention insert path, so the caret
   * never jumps to the end of the box mid-sentence.
   */
  const insertEmoji = useCallback(
    (emoji: string) => {
      setBody((prev) => {
        const at = Math.min(caret, prev.length);
        const next = `${prev.slice(0, at)}${emoji}${prev.slice(at)}`;
        const nextCaret = at + emoji.length;
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (!el) return;
          el.focus();
          el.setSelectionRange(nextCaret, nextCaret);
        });
        setCaret(nextCaret);
        return next;
      });
    },
    [caret],
  );

  // A DM has no channel name, so it gets a plain prompt instead of the
  // "Message #channel" affordance. Same string drives the a11y label.
  const composerPrompt = threadRootId
    ? "Reply in thread…"
    : channelName
      ? `Message #${channelName}`
      : "Send a message…";

  const mentionCandidates = trigger
    ? filterMembersByQuery(teamMembers, trigger.query)
    : [];
  const activeMentionOptionId =
    trigger && mentionCandidates[activeMentionIndex]
      ? `${mentionListboxId}-opt-${mentionCandidates[activeMentionIndex]!.id}`
      : undefined;

  // Recompute mention trigger whenever body or caret moves.
  const recomputeTrigger = useCallback(
    (nextBody: string, nextCaret: number) => {
      const t = detectActiveTrigger(nextBody, nextCaret);
      setTrigger(t);
      if (t && textareaRef.current) {
        const rect = textareaRef.current.getBoundingClientRect();
        // Anchor the popup just above the textarea — caret-position math
        // would be more precise but adds a coord-measurement helper for a
        // marginal UX win. Above-the-input is unambiguous + always visible.
        //
        // Viewport clamps for narrow / short screens:
        //   - left: keep the 256px (w-64) popup fully on-screen — never let
        //     it run past the right edge (8px gutter → innerWidth - 264).
        //   - top: the ~288px-tall popup would clip off the top on a short
        //     viewport, so flip it BELOW the textarea when there's no room
        //     above.
        const POPUP_W = 256;
        const POPUP_H = 280;
        const GUTTER = 8;
        const left = Math.max(
          GUTTER,
          Math.min(rect.left + GUTTER, window.innerWidth - POPUP_W - GUTTER),
        );
        const flipBelow = rect.top - GUTTER - POPUP_H < 0;
        setPopupPos({
          left,
          top: flipBelow ? rect.bottom + GUTTER : rect.top - GUTTER - POPUP_H,
        });
      } else {
        setPopupPos(null);
      }
    },
    [],
  );

  useEffect(() => {
    recomputeTrigger(body, caret);
  }, [body, caret, recomputeTrigger]);

  // Typing indicator emit. Debounced "stop" so a brief pause doesn't drop
  // the dot — same pattern as the conversation composer. When `threadRootId`
  // is set, we emit thread-scoped events instead so the indicator renders
  // in the thread side panel, not the channel.
  const typingStopTimer = useRef<number | null>(null);
  const isTypingRef = useRef(false);
  const emitTypingStart = () => {
    const socket = getClientSocket();
    if (!isTypingRef.current) {
      if (threadRootId) {
        socket.emit("typing:thread:start", { channelId, threadRootId });
      } else {
        socket.emit("typing:channel:start", { channelId });
      }
      isTypingRef.current = true;
    }
    if (typingStopTimer.current) window.clearTimeout(typingStopTimer.current);
    typingStopTimer.current = window.setTimeout(() => {
      if (threadRootId) {
        socket.emit("typing:thread:stop", { channelId, threadRootId });
      } else {
        socket.emit("typing:channel:stop", { channelId });
      }
      isTypingRef.current = false;
    }, 3000);
  };
  const emitTypingStop = () => {
    const socket = getClientSocket();
    if (typingStopTimer.current) window.clearTimeout(typingStopTimer.current);
    if (isTypingRef.current) {
      if (threadRootId) {
        socket.emit("typing:thread:stop", { channelId, threadRootId });
      } else {
        socket.emit("typing:channel:stop", { channelId });
      }
      isTypingRef.current = false;
    }
  };
  // Runs on unmount AND on every thread switch (threadRootId change), so the
  // OLD render's closure emits stop for the root we're leaving and resets
  // isTypingRef — otherwise the next keystroke in the new thread sees
  // isTypingRef=true and never emits start, and the server keeps the user
  // parked in the old thread's typing set until the socket disconnects.
  useEffect(() => {
    return () => emitTypingStop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, threadRootId]);

  const handleMentionPick = (u: User) => {
    if (!trigger) return;
    const next = insertMention(body, caret, trigger.length, {
      id: u.id,
      name: u.name,
    });
    setBody(next.body);
    setTrigger(null);
    setPopupPos(null);
    setActiveMentionIndex(0);
    // Move caret programmatically after React commits the new value.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.cursor, next.cursor);
      setCaret(next.cursor);
    });
  };

  const submit = async () => {
    if (busy) return;
    // Pending file takes the media path; text-only takes the text path.
    // The user is allowed to have both (file + caption); we route through
    // handleFile in that case since it already accepts the caption from
    // `body`. Send is disabled when there's neither — see the button's
    // `disabled` prop.
    if (pendingFile) {
      const file = pendingFile;
      setPendingFile(null);
      emitTypingStop();
      await handleFile(file);
      return;
    }
    const trimmed = body.trim();
    if (!trimmed) return;
    emitTypingStop();
    const clientTempId = `tmp_${Math.random().toString(36).slice(2)}_${Date.now()}`;
    const optimistic: TeamChannelMessageDto = {
      id: clientTempId,
      channelId,
      workspaceId: currentUser.workspaceId,
      authorUserId: currentUser.id,
      authorName: currentUser.name,
      authorAvatarUrl: currentUser.avatarUrl ?? null,
      body: trimmed,
      editedAt: null,
      threadRootId: threadRootId ?? null,
      threadReplyCount: 0,
      threadLastReplyAt: null,
      mentionedUserIds: [],
      reactions: [],
      pinned: false,
      createdAt: new Date().toISOString(),
      clientTempId,
      pending: true,
    };
    onOptimisticAdd(optimistic);
    setBody("");
    clearDraft();
    setTrigger(null);
    setPopupPos(null);
    setBusy(true);
    const url = threadRootId
      ? `/api/team-chat/channels/${channelId}/messages/${threadRootId}/thread`
      : `/api/team-chat/channels/${channelId}/messages`;
    try {
      const res = await fetchWithSessionGuard(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: trimmed, clientTempId }),
      });
      if (!res.ok) {
        onOptimisticFail(clientTempId);
      } else {
        // Confirm from the POST response instead of relying solely on the
        // `team:channel:message` echo — if the socket dropped after the send,
        // the echo never arrives and the bubble would stay pending forever
        // (then double-render on the next reconnect converge). Idempotent with
        // the echo: whichever lands first reconciles, the other dedupes.
        const { message } = (await res.json()) as {
          message: TeamChannelMessageDto;
        };
        onOptimisticConfirm?.(message, clientTempId);
      }
    } catch {
      onOptimisticFail(clientTempId);
    } finally {
      setBusy(false);
    }
  };

  const handleFile = async (file: File) => {
    const clientTempId = `tmp_${Math.random().toString(36).slice(2)}_${Date.now()}`;
    // Client-only marker so the failed-state UI HIDES Retry for media sends:
    // the original File bytes aren't retained, so a re-POST would only resend
    // the caption-as-text (or 400 on an empty caption). The flag rides on the
    // optimistic row (never persisted, never echoed by the server) and is read
    // by channel-message.tsx's Retry gate. We don't set a real `media` object
    // because that would render a broken attachment on the pending bubble.
    const optimistic: TeamChannelMessageDto & { hasOptimisticMedia: true } = {
      id: clientTempId,
      channelId,
      workspaceId: currentUser.workspaceId,
      authorUserId: currentUser.id,
      authorName: currentUser.name,
      authorAvatarUrl: currentUser.avatarUrl ?? null,
      body: body.trim(),
      editedAt: null,
      threadRootId: threadRootId ?? null,
      threadReplyCount: 0,
      threadLastReplyAt: null,
      mentionedUserIds: [],
      reactions: [],
      pinned: false,
      createdAt: new Date().toISOString(),
      clientTempId,
      pending: true,
      hasOptimisticMedia: true,
    };
    onOptimisticAdd(optimistic);
    const captionAtStart = body.trim();
    setBody("");
    clearDraft();
    setBusy(true);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("body", captionAtStart);
    fd.append("clientTempId", clientTempId);
    if (threadRootId) fd.append("threadRootId", threadRootId);
    try {
      const res = await fetchWithSessionGuard(
        `/api/team-chat/channels/${channelId}/media`,
        { method: "POST", body: fd },
      );
      if (!res.ok) onOptimisticFail(clientTempId);
    } catch {
      onOptimisticFail(clientTempId);
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="border-t border-border bg-background p-3">
      {pendingFile && (
        <PendingFileChip
          file={pendingFile}
          onRemove={() => setPendingFile(null)}
        />
      )}
      <div className="flex items-end gap-2 rounded-xl border border-border bg-muted/30 p-2 transition-all duration-150 focus-within:border-primary/70 focus-within:bg-background focus-within:shadow-sm focus-within:ring-1 focus-within:ring-primary/20">
        <Textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            emitTypingStart();
          }}
          onSelect={(e) => {
            setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0);
          }}
          onKeyDown={(e) => {
            if (trigger) {
              const candidates = filterMembersByQuery(teamMembers, trigger.query);
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveMentionIndex((i) => Math.min(i + 1, candidates.length - 1));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveMentionIndex((i) => Math.max(i - 1, 0));
                return;
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                const pick = candidates[activeMentionIndex];
                if (pick) {
                  handleMentionPick(pick);
                  return;
                }
                // No matching member (e.g. "@qa" matches nobody) — don't swallow
                // Enter: close the trigger and send the message as typed.
                setTrigger(null);
                setPopupPos(null);
                void submit();
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setTrigger(null);
                setPopupPos(null);
                return;
              }
            }
            // `isComposing` — don't send while an IME candidate is being picked
            // (Enter confirms the IME selection, not the message).
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={composerPrompt}
          aria-label={composerPrompt}
          // Combobox ONLY while the @-mention popup is active — otherwise this is
          // a plain message textbox (a permanent combobox role would make every
          // message input announce as a combobox to screen readers).
          role={trigger ? "combobox" : undefined}
          aria-expanded={trigger ? true : undefined}
          aria-controls={trigger ? mentionListboxId : undefined}
          aria-activedescendant={activeMentionOptionId}
          aria-autocomplete="list"
          rows={1}
          className="min-h-9 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              // A Radix tooltip is exposed as aria-describedby, not as the
              // accessible NAME — and only while it's open, which on touch is
              // never. Every sibling icon button here carries a label; this one
              // was the miss.
              aria-label="Attach file"
              title="Attach file"
              className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Paperclip className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Attach file</TooltipContent>
        </Tooltip>
        {/* `relative` wrapper: EmojiPopover positions itself absolutely
            against its offset parent. */}
        <div className="relative">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setEmojiOpen((v) => !v)}
                aria-label="Insert emoji"
                aria-expanded={emojiOpen}
                className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <SmilePlus className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Emoji</TooltipContent>
          </Tooltip>
          {/* Deliberately stays OPEN after a pick so several emoji can be
              inserted in a row — don't "fix" that into auto-close. */}
          {/* `left-auto right-0`: this trigger sits at the RIGHT edge of the
              composer, so the default left-anchored panel ran 250px off the
              page (a real horizontal scrollbar on the whole app). `left-auto`
              is required — `left-0` and `right-0` are different tailwind-merge
              groups, so `right-0` alone wouldn't have won. */}
          <EmojiPopover
            open={emojiOpen}
            onClose={() => setEmojiOpen(false)}
            onPick={insertEmoji}
            className="left-auto right-0"
          />
        </div>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) setPendingFile(f);
            // Clear the input so picking the same file again still fires
            // onChange. Browsers suppress the event when the picked value
            // is identical to the previous one.
            if (fileInputRef.current) fileInputRef.current.value = "";
          }}
        />
        <Button
          type="button"
          size="icon"
          aria-label="Send message"
          onClick={() => void submit()}
          disabled={(!body.trim() && !pendingFile) || busy}
          className="size-9 shrink-0"
        >
          <SendHorizontal className="size-4" />
        </Button>
      </div>

      {trigger && popupPos && (
        <MentionPopup
          listboxId={mentionListboxId}
          teamMembers={teamMembers}
          query={trigger.query}
          position={popupPos}
          onPick={handleMentionPick}
          onClose={() => {
            setTrigger(null);
            setPopupPos(null);
          }}
          activeIndex={activeMentionIndex}
          onActiveIndexChange={setActiveMentionIndex}
        />
      )}
    </div>
  );
}

/**
 * Compact preview row shown above the composer when a file is staged for
 * send. Click X to discard before sending. Same shape as the inbox
 * composer's attachment preview — kept inline here to avoid coupling the
 * two trees, since the team-chat composer is narrower.
 */
function PendingFileChip({
  file,
  onRemove,
}: {
  file: File;
  onRemove: () => void;
}) {
  const Icon = iconForFile(file);
  return (
    <div className="mb-2 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2 py-1.5">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background">
        <Icon className="size-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium">{file.name}</div>
        <div className="text-2xs text-muted-foreground">
          {formatBytes(file.size)}
        </div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label="Remove attachment"
        title="Remove"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function iconForFile(file: File): typeof FileText {
  if (file.type.startsWith("image/")) return ImageIcon;
  if (file.type.startsWith("video/")) return Video;
  if (file.type.startsWith("audio/")) return Mic;
  return FileText;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
