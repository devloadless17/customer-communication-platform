"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  FileText,
  Image as ImageIcon,
  Mic,
  Paperclip,
  SendHorizontal,
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

/**
 * Composer for both the channel feed and the thread side panel. The only
 * difference is the POST URL: pass `threadRootId` to post into a thread.
 *
 * Wires up:
 *   - Enter to send (Shift+Enter for newline)
 *   - @ autocomplete with arrow keys / Enter to pick
 *   - file upload via the paperclip / drag is left out for v0
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
  channelName: string;
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

  // ARIA combobox wiring for the @-mention popup. Stable ids so the textarea
  // can point aria-controls at the listbox and aria-activedescendant at the
  // highlighted option. Candidates are recomputed at render (same pure filter
  // the keyboard handler uses) so the active-descendant id stays in sync.
  const mentionListboxId = useId();
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
      teamId: currentUser.teamId,
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
    setTrigger(null);
    setPopupPos(null);
    setBusy(true);
    const url = threadRootId
      ? `/api/team/channels/${channelId}/messages/${threadRootId}/thread`
      : `/api/team/channels/${channelId}/messages`;
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
      teamId: currentUser.teamId,
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
    setBusy(true);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("body", captionAtStart);
    fd.append("clientTempId", clientTempId);
    if (threadRootId) fd.append("threadRootId", threadRootId);
    try {
      const res = await fetchWithSessionGuard(
        `/api/team/channels/${channelId}/media`,
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
          placeholder={threadRootId ? "Reply in thread…" : `Message #${channelName}`}
          aria-label={threadRootId ? "Reply in thread" : `Message #${channelName}`}
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
              className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Paperclip className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Attach file</TooltipContent>
        </Tooltip>
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
