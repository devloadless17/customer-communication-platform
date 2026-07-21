"use client";

import { Check, Flag, FlagOff, RotateCcw, Trash2, X } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LocalTime } from "@/components/local-time";
import { useMessageFlags } from "@/features/inbox/components/message-flags-context";
import { cn } from "@ccp/shared/utils";
import { tagColorClasses } from "@ccp/shared/utils/tag-colors";
import type { MessageFlag } from "@ccp/shared/types";

/**
 * Triage-flag chips under a message bubble.
 *
 * An OPEN flag is solid and colored — it's an open loop and should read as
 * one. A resolved / dismissed flag stays visible but goes quiet (muted,
 * struck-through, no fill): the record that "this was a complaint and it was
 * handled" is the whole point of the feature, so hiding it on resolve would
 * throw away the answer to "did we deal with it?".
 *
 * Each chip is its own menu — resolve / dismiss / reopen / remove. Nothing is
 * optimistic: the chip re-renders from the `message:flag` socket frame, so
 * every open tab converges on the same state and there is no local reconcile
 * to get wrong (the same contract as reactions).
 */
export function FlagChips({ flags }: { flags: MessageFlag[] }) {
  const ctx = useMessageFlags();
  if (!flags.length) return null;

  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {flags.map((flag) => (
        <FlagChip key={flag.id} flag={flag} ctx={ctx} />
      ))}
    </div>
  );
}

function FlagChip({
  flag,
  ctx,
}: {
  flag: MessageFlag;
  ctx: ReturnType<typeof useMessageFlags>;
}) {
  const open = flag.status === "open";
  const colors = tagColorClasses(flag.definition.color);
  const Icon = open ? Flag : flag.status === "dismissed" ? FlagOff : Check;

  const chip = (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full border px-1.5 py-0.5 text-2xs leading-tight transition-colors",
        open
          ? colors.pill
          : "border-border/60 bg-transparent text-muted-foreground line-through decoration-1",
        ctx && "cursor-pointer hover:brightness-105",
      )}
      // The title carries the WHY and the WHO — the things that make a flag
      // worth coming back to — without spending bubble width on them.
      title={buildTooltip(flag)}
    >
      <Icon className="size-2.5 shrink-0" />
      <span className="truncate">{flag.definition.name}</span>
      {flag.source === "ai" && (
        <span className="shrink-0 rounded-sm bg-foreground/10 px-1 text-[9px] uppercase tracking-wide">
          AI
        </span>
      )}
    </span>
  );

  // No provider (e.g. a bubble rendered inside the forward preview) → the chip
  // is read-only rather than a dead menu trigger.
  if (!ctx) return chip;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="max-w-full" aria-label={`${flag.definition.name} flag`}>
          {chip}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuLabel className="text-2xs font-normal text-muted-foreground">
          {open ? (
            <>
              Flagged{flag.createdByName ? ` by ${flag.createdByName}` : ""}{" "}
              <LocalTime iso={flag.createdAt} format="listTime" />
            </>
          ) : (
            <>
              {flag.status === "dismissed" ? "Dismissed" : "Resolved"}
              {flag.resolvedByName ? ` by ${flag.resolvedByName}` : ""}
              {flag.resolvedAt ? (
                <>
                  {" "}
                  <LocalTime iso={flag.resolvedAt} format="listTime" />
                </>
              ) : null}
            </>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {open ? (
          <>
            <DropdownMenuItem onSelect={() => void ctx.setStatus(flag.id, "resolved").catch(() => {})}>
              <Check className="size-3.5" />
              Mark resolved
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void ctx.setStatus(flag.id, "dismissed").catch(() => {})}>
              <X className="size-3.5" />
              Dismiss — not a {flag.definition.name.toLowerCase()}
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem onSelect={() => void ctx.setStatus(flag.id, "open").catch(() => {})}>
            <RotateCcw className="size-3.5" />
            Reopen
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={() => void ctx.remove(flag.id).catch(() => {})}
        >
          <Trash2 className="size-3.5" />
          Remove flag
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function buildTooltip(flag: MessageFlag): string {
  const parts: string[] = [flag.definition.name];
  if (flag.definition.description) parts.push(flag.definition.description);
  if (flag.note) parts.push(`Note: ${flag.note}`);
  if (flag.assignedToName) parts.push(`Owner: ${flag.assignedToName}`);
  if (flag.status !== "open" && flag.resolutionNote) {
    parts.push(`Resolution: ${flag.resolutionNote}`);
  }
  return parts.join(" — ");
}
