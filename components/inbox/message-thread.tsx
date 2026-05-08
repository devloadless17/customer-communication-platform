"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronDown,
  MoreHorizontal,
  CircleCheck,
  CircleDashed,
  Archive,
  Check,
  Loader2,
} from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { avatarGradient } from "@/lib/avatar-color";
import { cn, formatDaySeparator, formatPhone, initials } from "@/lib/utils";
import type {
  ConversationStatus,
  ConversationWithRefs,
  InternalNote,
  Message,
  ReplySnapshot,
  User,
} from "@/lib/types";
import { useConversationEvents } from "@/hooks/use-conversation-events";
import { useTyping } from "@/hooks/use-typing";

import { MessageBubble } from "./message-bubble";
import { InternalNote as InternalNoteCard } from "./internal-note";
import { ReplyBox } from "./reply-box";

type TimelineEntry =
  | { kind: "message"; data: Message }
  | { kind: "note"; data: InternalNote };

export function MessageThread({
  data: initialData,
  teamMembers,
  currentUser,
  nextOlderCursor,
}: {
  data: ConversationWithRefs;
  teamMembers: User[];
  currentUser: User;
  nextOlderCursor: string | null;
}) {
  const {
    data,
    hasMoreOlder,
    loadingOlder,
    loadOlder,
    addOptimistic,
    markOptimisticFailed,
    removeOptimistic,
  } = useConversationEvents(initialData, nextOlderCursor);
  const { conversation, contact, assignedUser, messages, notes } = data;

  const memberById = useMemo(() => {
    return new Map(teamMembers.map((u) => [u.id, u]));
  }, [teamMembers]);

  // The 24h window is driven by the server-provided lastInboundAt — it's
  // contact-level and may predate the loaded message slice.
  const { lastInboundAt } = data;

  // -------------------------------------------------------------------------
  // Reply target — the message the composer's next send will quote. Lives in
  // the thread (not the composer) because clicks come from message bubbles.
  // -------------------------------------------------------------------------
  const [replyTarget, setReplyTarget] = useState<ReplySnapshot | null>(null);

  // Re-snapshot when the user changes conversation — the previous reply
  // target belongs to the old thread.
  useEffect(() => {
    setReplyTarget(null);
  }, [conversation.id]);

  const beginReply = useCallback(
    (msg: Message) => {
      const senderName =
        msg.direction === "out"
          ? msg.senderUserId
            ? memberById.get(msg.senderUserId)?.name ?? null
            : null
          : null;
      setReplyTarget({
        id: msg.id,
        body: msg.body,
        direction: msg.direction,
        senderName,
        ...(msg.media ? { mediaKind: msg.media.kind } : {}),
      });
    },
    [memberById],
  );

  const cancelReply = useCallback(() => setReplyTarget(null), []);

  const jumpToOriginal = useCallback((originalId: string) => {
    const el = document.querySelector<HTMLElement>(
      `[data-message-id="${originalId}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    // Subtle flash so the user's eye lands on the right bubble.
    el.classList.add("ring-2", "ring-primary/60", "ring-offset-2");
    setTimeout(() => {
      el.classList.remove("ring-2", "ring-primary/60", "ring-offset-2");
    }, 1500);
  }, []);

  const { typingUserIds, notifyTyping, stopTyping } = useTyping(
    conversation.id,
    currentUser.id,
  );

  const timeline = useMemo<TimelineEntry[]>(() => {
    return [
      ...messages.map((m): TimelineEntry => ({ kind: "message", data: m })),
      ...notes.map((n): TimelineEntry => ({ kind: "note", data: n })),
    ].sort(
      (a, b) =>
        new Date(a.data.timestamp).getTime() - new Date(b.data.timestamp).getTime(),
    );
  }, [messages, notes]);

  // ---------------------------------------------------------------------
  // Scroll behavior
  // ---------------------------------------------------------------------
  // Three rules:
  //   1) On first mount of a thread, jump straight to the bottom (newest).
  //   2) On a NEW timeline entry, only auto-scroll if the user is already
  //      near the bottom — otherwise they're reading history and we
  //      shouldn't yank them.
  //   3) When older messages are prepended, hold the visual position so the
  //      content the user was looking at stays under their eyes.
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRootRef = useRef<HTMLElement | null>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);

  // Find the actual scrolling element (Radix ScrollArea viewport) once.
  useEffect(() => {
    const el = bottomRef.current?.parentElement;
    if (!el) return;
    let root: HTMLElement | null = el;
    while (root && root !== document.body) {
      const o = getComputedStyle(root).overflowY;
      if (o === "auto" || o === "scroll") break;
      root = root.parentElement;
    }
    scrollRootRef.current = root;
  }, []);

  function isNearBottom(slack = 120): boolean {
    const el = scrollRootRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < slack;
  }

  // (1) jump to bottom on conversation change.
  const conversationId = conversation.id;
  useLayoutEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [conversationId]);

  // (2) auto-scroll on growth — only when user is at the bottom AND the
  // newest entry was appended (not prepended via loadOlder). Track the id of
  // the most-recent entry; when it changes, scroll.
  const lastEntryIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const last = timeline.at(-1);
    const lastId = last ? `${last.kind}_${last.data.id}` : null;
    if (lastId !== lastEntryIdRef.current) {
      const wasAtBottom = isNearBottom();
      lastEntryIdRef.current = lastId;
      if (wasAtBottom) {
        bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
      }
    }
  }, [timeline]);

  // (3) infinite scroll up. When the top sentinel comes into view, fetch the
  // next older page and preserve the visual position by re-anchoring after
  // DOM mutation.
  const pendingPreserveRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  useEffect(() => {
    if (!hasMoreOlder) return;
    const sentinel = topSentinelRef.current;
    const root = scrollRootRef.current;
    if (!sentinel || !root) return;

    const obs = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        if (loadingOlder) return;
        // Snapshot scroll geometry; restore after the prepend by adding the
        // delta in scrollHeight.
        pendingPreserveRef.current = {
          scrollHeight: root.scrollHeight,
          scrollTop: root.scrollTop,
        };
        void loadOlder().then((added) => {
          if (added === 0) pendingPreserveRef.current = null;
        });
      },
      { root, rootMargin: "100px" },
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, [hasMoreOlder, loadingOlder, loadOlder]);

  // Scroll preservation runs synchronously after the prepend has rendered.
  useLayoutEffect(() => {
    const pending = pendingPreserveRef.current;
    const root = scrollRootRef.current;
    if (!pending || !root) return;
    const delta = root.scrollHeight - pending.scrollHeight;
    if (delta > 0) root.scrollTop = pending.scrollTop + delta;
    pendingPreserveRef.current = null;
  }, [messages.length]);

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-background">
      <ThreadHeader
        conversationId={conversation.id}
        contactId={contact.id}
        contactName={contact.name}
        phone={contact.phoneNumber}
        status={conversation.status}
        assignedUserId={assignedUser?.id ?? null}
        assignedUserName={assignedUser?.name ?? null}
        teamMembers={teamMembers}
      />

      <ScrollArea className="flex-1">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-6 py-6">
          {/* Top sentinel — IntersectionObserver target for "load older". */}
          <div ref={topSentinelRef} className="h-px" />
          {hasMoreOlder && (
            <div className="flex items-center justify-center py-2 text-[11px] text-muted-foreground">
              {loadingOlder ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="size-3 animate-spin" />
                  Loading older messages…
                </span>
              ) : (
                <button
                  type="button"
                  className="hover:text-foreground"
                  onClick={() => void loadOlder()}
                >
                  Load older messages
                </button>
              )}
            </div>
          )}
          {timeline.map((entry, idx) => {
            const prev = timeline[idx - 1];
            const showDay =
              !prev ||
              formatDaySeparator(entry.data.timestamp) !==
                formatDaySeparator(prev.data.timestamp);

            return (
              <div key={`${entry.kind}_${entry.data.id}`} className="contents">
                {showDay && (
                  <div className="my-3 flex items-center gap-3">
                    <div className="h-px flex-1 bg-border" />
                    <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      {formatDaySeparator(entry.data.timestamp)}
                    </span>
                    <div className="h-px flex-1 bg-border" />
                  </div>
                )}
                <motion.div
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                  data-message-id={entry.kind === "message" ? entry.data.id : undefined}
                  className="rounded-2xl transition-shadow"
                >
                  {entry.kind === "message" ? (
                    <MessageBubble
                      message={entry.data}
                      sender={
                        entry.data.senderUserId
                          ? memberById.get(entry.data.senderUserId) ?? null
                          : null
                      }
                      contactName={contact.name}
                      contactSeed={contact.id}
                      onReply={beginReply}
                      onJumpToOriginal={jumpToOriginal}
                    />
                  ) : (
                    <InternalNoteCard
                      note={entry.data}
                      author={memberById.get(entry.data.authorUserId) ?? unknownAuthor(entry.data.authorUserId)}
                    />
                  )}
                </motion.div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      <TypingIndicator
        typingUserIds={typingUserIds}
        memberById={memberById}
      />

      <ReplyBox
        conversationId={conversation.id}
        currentUser={currentUser}
        contactName={contact.name}
        lastInboundAt={lastInboundAt}
        replyTarget={replyTarget}
        onCancelReply={cancelReply}
        onTyping={notifyTyping}
        onStopTyping={stopTyping}
        onOptimistic={addOptimistic}
        onOptimisticFail={markOptimisticFailed}
        onOptimisticRetry={removeOptimistic}
      />
    </section>
  );
}

function unknownAuthor(id: string): User {
  return {
    id,
    teamId: "",
    role: "agent",
    name: "Unknown",
    email: "",
  };
}

// ---------------------------------------------------------------------------
// Typing indicator — appears just above the reply box. Renders the names of
// other teammates currently typing in this thread (already filtered against
// the caller's userId by useTyping).
// ---------------------------------------------------------------------------

function TypingIndicator({
  typingUserIds,
  memberById,
}: {
  typingUserIds: string[];
  memberById: Map<string, User>;
}) {
  const names = typingUserIds
    .map((id) => memberById.get(id)?.name.split(" ")[0])
    .filter((n): n is string => Boolean(n));

  return (
    <AnimatePresence>
      {names.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 4, height: 0 }}
          animate={{ opacity: 1, y: 0, height: "auto" }}
          exit={{ opacity: 0, y: 4, height: 0 }}
          transition={{ duration: 0.14 }}
          className="border-t border-border bg-background"
        >
          <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 py-1.5 text-[11px] text-muted-foreground">
            <TypingDots />
            <span>
              {names.length === 1
                ? `${names[0]} is typing…`
                : names.length === 2
                  ? `${names[0]} and ${names[1]} are typing…`
                  : `${names.length} teammates are typing…`}
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="size-1 rounded-full bg-muted-foreground"
          animate={{ opacity: [0.3, 1, 0.3], y: [0, -1, 0] }}
          transition={{
            duration: 0.9,
            repeat: Infinity,
            ease: "easeInOut",
            delay: i * 0.15,
          }}
        />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function ThreadHeader({
  conversationId,
  contactId,
  contactName,
  phone,
  status,
  assignedUserId,
  assignedUserName,
  teamMembers,
}: {
  conversationId: string;
  contactId: string;
  contactName: string;
  phone: string;
  status: ConversationStatus;
  assignedUserId: string | null;
  assignedUserName: string | null;
  teamMembers: User[];
}) {
  return (
    <header className="flex h-[60px] shrink-0 items-center gap-3 border-b border-border px-4">
      <Avatar className="size-9">
        <AvatarFallback
          className="text-xs text-white"
          style={{ backgroundImage: avatarGradient(contactId) }}
        >
          {initials(contactName)}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-sm font-semibold">{contactName}</h2>
        </div>
        <div className="font-mono text-[11px] text-muted-foreground">{formatPhone(phone)}</div>
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <AssignmentDropdown
          conversationId={conversationId}
          currentId={assignedUserId}
          currentName={assignedUserName}
          teamMembers={teamMembers}
        />
        <StatusDropdown conversationId={conversationId} current={status} />
        <Button variant="ghost" size="icon" className="size-8">
          <MoreHorizontal className="size-4" />
        </Button>
      </div>
    </header>
  );
}

function AssignmentDropdown({
  conversationId,
  currentId,
  currentName,
  teamMembers,
}: {
  conversationId: string;
  currentId: string | null;
  currentName: string | null;
  teamMembers: User[];
}) {
  const [pending, setPending] = useState(false);

  const assign = async (assignedUserId: string | null) => {
    if (assignedUserId === currentId || pending) return;
    setPending(true);
    try {
      await fetch(`/api/conversations/${conversationId}/assign`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assignedUserId }),
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5" disabled={pending}>
          {currentName ? (
            <>
              <span className="inline-flex size-4 items-center justify-center rounded-full bg-secondary text-[9px] font-medium">
                {initials(currentName)}
              </span>
              <span className="font-normal">{currentName.split(" ")[0]}</span>
            </>
          ) : (
            <span className="text-muted-foreground">Unassigned</span>
          )}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>Assign to…</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void assign(null)}>
          {currentId === null && <Check className="size-3.5" />}
          <span className={cn("text-muted-foreground", currentId === null && "ml-1")}>
            Unassigned
          </span>
        </DropdownMenuItem>
        {teamMembers.map((u) => (
          <DropdownMenuItem key={u.id} onSelect={() => void assign(u.id)}>
            {currentId === u.id ? (
              <Check className="size-3.5" />
            ) : (
              <span className="inline-flex size-5 items-center justify-center rounded-full bg-secondary text-[10px] font-medium">
                {initials(u.name)}
              </span>
            )}
            <span>{u.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StatusDropdown({
  conversationId,
  current,
}: {
  conversationId: string;
  current: ConversationStatus;
}) {
  const [pending, setPending] = useState(false);

  const map: Record<
    ConversationStatus,
    { label: string; icon: typeof CircleCheck; cls: string }
  > = {
    open: { label: "Open", icon: CircleDashed, cls: "text-emerald-600 dark:text-emerald-400" },
    pending: { label: "Pending", icon: CircleDashed, cls: "text-amber-600 dark:text-amber-400" },
    closed: { label: "Closed", icon: Archive, cls: "text-muted-foreground" },
  };
  const Icon = map[current].icon;

  const setStatus = async (status: ConversationStatus) => {
    if (status === current || pending) return;
    setPending(true);
    try {
      await fetch(`/api/conversations/${conversationId}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
    } finally {
      setPending(false);
    }
  };

  const items: { value: ConversationStatus; icon: typeof CircleCheck; cls: string }[] = [
    { value: "open", icon: CircleDashed, cls: "text-emerald-600" },
    { value: "pending", icon: CircleDashed, cls: "text-amber-600" },
    { value: "closed", icon: CircleCheck, cls: "text-muted-foreground" },
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5" disabled={pending}>
          <Icon className={cn("size-3.5", map[current].cls)} />
          <span className="font-normal">{map[current].label}</span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map(({ value, icon: ItemIcon, cls }) => (
          <DropdownMenuItem key={value} onSelect={() => void setStatus(value)}>
            {value === current ? (
              <Check className="size-3.5" />
            ) : (
              <ItemIcon className={cn("size-3.5", cls)} />
            )}
            {map[value].label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
