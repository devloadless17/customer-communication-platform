"use client";

import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import type { ComponentProps, Ref } from "react";

import { cn } from "@ccp/shared/utils";

/**
 * Radix ScrollArea wraps the scrolling viewport in an outer Root. Callers
 * that need a direct ref to the *viewport* (e.g. tanstack/react-virtual's
 * `getScrollElement`) used to grab it via `useLayoutEffect + querySelector`
 * on the Root — a layout-effect round-trip that produces a first paint with
 * a not-yet-resolved scroll element. Forwarding a `viewportRef` prop
 * removes that indirection: the viewport ref is populated during the same
 * commit as the rest of the tree, so consumers can read it on the next
 * render without an extra round-trip.
 */
export function ScrollArea({
  className,
  children,
  viewportRef,
  ...props
}: ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  viewportRef?: Ref<HTMLDivElement>;
}) {
  return (
    <ScrollAreaPrimitive.Root
      className={cn("relative overflow-hidden", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        className="size-full rounded-[inherit] [&>div]:block!"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

export function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      orientation={orientation}
      className={cn(
        "flex touch-none select-none transition-colors",
        orientation === "vertical" && "h-full w-2 border-l border-l-transparent p-px",
        orientation === "horizontal" && "h-2 flex-col border-t border-t-transparent p-px",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-border" />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
}
