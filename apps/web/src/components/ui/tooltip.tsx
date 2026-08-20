"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ComponentProps } from "react";

import { cn } from "@ccp/shared/utils";

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

/**
 * PORTALLED, deliberately. Without `Portal` the content renders inline next to
 * its trigger, so any ancestor with `overflow-hidden` or its own stacking
 * context CLIPS it — which is exactly what happened to the conversation list's
 * "who else is viewing this" eye: the tooltip opened upward out of a row inside
 * the virtualized (overflow-hidden) scroller and was cut off behind the search
 * field above it. Several call sites already documented themselves as relying on
 * a portal that was never actually here.
 *
 * `z-80` rather than the z-50/z-60 the other overlays use: a tooltip is the
 * topmost TRANSIENT layer and must stay readable above a dialog it was opened
 * from (confirm dialogs sit at z-60, the members overlay at z-70).
 */
export function TooltipContent({
  className,
  sideOffset = 4,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          "z-80 overflow-hidden rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-sm",
          "data-[state=delayed-open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:fade-in-0",
          "data-[state=delayed-open]:duration-150 data-[state=closed]:duration-100",
          "data-[state=closed]:zoom-out-95 data-[state=delayed-open]:zoom-in-95",
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}
