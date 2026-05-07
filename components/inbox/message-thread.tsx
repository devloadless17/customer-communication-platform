"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";
import {
  ChevronDown,
  MoreHorizontal,
  CircleCheck,
  CircleDashed,
  Archive,
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
import { cn, formatDaySeparator, formatPhone, initials } from "@/lib/utils";
import type {
  ConversationStatus,
  ConversationWithRefs,
  InternalNote,
  Message,
  User,
} from "@/lib/types";
import { useConversationEvents } from "@/hooks/use-conversation-events";

import { MessageBubble } from "./message-bubble";
import { InternalNote as InternalNoteCard } from "./internal-note";
import { ReplyBox } from "./reply-box";

type TimelineEntry =
  | { kind: "message"; data: Message }
  | { kind: "note"; data: InternalNote };

export function MessageThread({
  data: initialData,
  teamMembers,
}: {
  data: ConversationWithRefs;
  teamMembers: User[];
}) {
  const data = useConversationEvents(initialData);
  const { conversation, contact, assignedUser, messages, notes } = data;

  const memberById = useMemo(() => {
    return new Map(teamMembers.map((u) => [u.id, u]));
  }, [teamMembers]);

  const timeline = useMemo<TimelineEntry[]>(() => {
    return [
      ...messages.map((m): TimelineEntry => ({ kind: "message", data: m })),
      ...notes.map((n): TimelineEntry => ({ kind: "note", data: n })),
    ].sort(
      (a, b) =>
        new Date(a.data.timestamp).getTime() - new Date(b.data.timestamp).getTime(),
    );
  }, [messages, notes]);

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-background">
      <ThreadHeader
        contactName={contact.name}
        phone={contact.phoneNumber}
        status={conversation.status}
        assignedUserName={assignedUser?.name ?? null}
        teamMembers={teamMembers}
      />

      <ScrollArea className="flex-1">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-6 py-6">
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
        </div>
      </ScrollArea>

      <ReplyBox conversationId={conversation.id} />
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
// Header
// ---------------------------------------------------------------------------

function ThreadHeader({
  contactName,
  phone,
  status,
  assignedUserName,
  teamMembers,
}: {
  contactName: string;
  phone: string;
  status: ConversationStatus;
  assignedUserName: string | null;
  teamMembers: User[];
}) {
  return (
    <header className="flex h-[60px] shrink-0 items-center gap-3 border-b border-border px-4">
      <Avatar className="size-9">
        <AvatarFallback className="text-xs">{initials(contactName)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-sm font-semibold">{contactName}</h2>
        </div>
        <div className="font-mono text-[11px] text-muted-foreground">{formatPhone(phone)}</div>
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <AssignmentDropdown current={assignedUserName} teamMembers={teamMembers} />
        <StatusDropdown current={status} />
        <Button variant="ghost" size="icon" className="size-8">
          <MoreHorizontal className="size-4" />
        </Button>
      </div>
    </header>
  );
}

function AssignmentDropdown({
  current,
  teamMembers,
}: {
  current: string | null;
  teamMembers: User[];
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5">
          {current ? (
            <>
              <span className="inline-flex size-4 items-center justify-center rounded-full bg-secondary text-[9px] font-medium">
                {initials(current)}
              </span>
              <span className="font-normal">{current.split(" ")[0]}</span>
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
        <DropdownMenuItem>
          <span className="text-muted-foreground">Unassigned</span>
        </DropdownMenuItem>
        {teamMembers.map((u) => (
          <DropdownMenuItem key={u.id}>
            <span className="inline-flex size-5 items-center justify-center rounded-full bg-secondary text-[10px] font-medium">
              {initials(u.name)}
            </span>
            <span>{u.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StatusDropdown({ current }: { current: ConversationStatus }) {
  const map: Record<
    ConversationStatus,
    { label: string; icon: typeof CircleCheck; cls: string }
  > = {
    open: { label: "Open", icon: CircleDashed, cls: "text-emerald-600 dark:text-emerald-400" },
    pending: { label: "Pending", icon: CircleDashed, cls: "text-amber-600 dark:text-amber-400" },
    closed: { label: "Closed", icon: Archive, cls: "text-muted-foreground" },
  };
  const Icon = map[current].icon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5">
          <Icon className={cn("size-3.5", map[current].cls)} />
          <span className="font-normal">{map[current].label}</span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem>
          <CircleDashed className="size-3.5 text-emerald-600" />
          Open
        </DropdownMenuItem>
        <DropdownMenuItem>
          <CircleDashed className="size-3.5 text-amber-600" />
          Pending
        </DropdownMenuItem>
        <DropdownMenuItem>
          <CircleCheck className="size-3.5 text-muted-foreground" />
          Closed
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
