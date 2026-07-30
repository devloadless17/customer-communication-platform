"use client";

import { Eye } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { avatarGradient } from "@ccp/shared/utils/avatar-color";
import { cn, initials } from "@ccp/shared/utils";
import type { ConversationViewer } from "@/features/inbox/contexts/conversation-viewers-context";

/**
 * "Someone else is reading this chat."
 *
 * ONE component for both surfaces — the conversation list row and the thread
 * header — so the two can't drift into meaning different things. It replaced a
 * header-only avatar pill: that pill sat next to the customer's name (the top
 * of the thread, competing with the identity it belongs to) and it only ever
 * appeared on the chat you had already opened, which is exactly one chat too
 * late to prevent a double-reply.
 *
 * An eye reads as "being watched" at 14px with no text, so it costs a row
 * almost nothing; hovering names the people. The tooltip is PORTALLED (Radix)
 * because the list row is `overflow-hidden` inside a virtualized scroller — a
 * CSS-only hover card would be clipped by both.
 *
 * It rides the row's TOP line, next to the name and time — where "who else is
 * on this" belongs — and it is deliberately NOT a filled chip: as a pill in the
 * badge lane it was a second amber counter sitting where the flag badge lives,
 * which read as another thing to action rather than as presence.
 *
 * Renders nothing for an empty list, which is the overwhelmingly common case.
 */
export function ViewersEye({
  viewers,
  className,
}: {
  viewers: ConversationViewer[];
  className?: string;
}) {
  if (viewers.length === 0) return null;

  const names = viewers.map((v) => v.name);
  const label =
    viewers.length === 1
      ? `${names[0]} is viewing this chat`
      : `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are viewing this chat`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A <span>, not a button: this sits inside the list row's own <button>,
            and it is a passive indicator — there is nothing to click. */}
        <span
          className={cn(
            // Bare icon, no pill. The badge lane below (unread, flags) is for
            // things that need HANDLING and each owns a filled chip; this is
            // ambient presence, so it reads as a mark on the row rather than
            // another counter competing with them.
            //
            // Deliberately NOT a new accent colour: the row already spends
            // primary on "open", blue on "unread" and amber on "flagged", and a
            // fourth hue would make all four mean less. An eye is unmistakable
            // by shape alone, so a quiet neutral is enough — it reads on a
            // glance down the list without shouting over the badges.
            "inline-flex shrink-0 cursor-default items-center gap-px text-foreground/65",
            className,
          )}
        >
          <Eye className="size-3.5" aria-hidden />
          {viewers.length > 1 && (
            <span className="text-3xs font-semibold leading-none tabular-nums">
              {viewers.length}
            </span>
          )}
          {/* The tooltip is hover/pointer-only (this span isn't focusable — it
              lives inside the list row's button). Screen readers get the same
              sentence inline instead; `aria-label` on a plain <span> carries no
              role and is not reliably announced. */}
          <span className="sr-only">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" align="end" className="px-2 py-1.5">
        <p className="mb-1 text-3xs font-medium uppercase tracking-wide text-muted-foreground">
          {viewers.length === 1 ? "Viewing now" : `${viewers.length} viewing now`}
        </p>
        <ul className="flex flex-col gap-1">
          {viewers.map((v) => (
            <li key={v.id} className="flex items-center gap-1.5">
              <Avatar className="size-4">
                {v.avatarUrl ? <AvatarImage src={v.avatarUrl} alt="" /> : null}
                <AvatarFallback
                  className="text-4xs text-white"
                  style={{ backgroundImage: avatarGradient(v.id) }}
                >
                  {initials(v.name)}
                </AvatarFallback>
              </Avatar>
              <span className="truncate">{v.name}</span>
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}
