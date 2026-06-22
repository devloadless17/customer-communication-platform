"use client";

import * as AvatarPrimitive from "@radix-ui/react-avatar";
import type { ComponentProps } from "react";

import { cn } from "@ccp/shared/utils";
import { avatarGradient } from "@ccp/shared/utils/avatar-color";

// React 19: ref is a regular prop. `ComponentProps<typeof Primitive>`
// already carries the ref type, so no forwardRef wrapper and no separate
// `displayName` assignment is needed — the function name is the display
// name in DevTools.

export function Avatar({
  className,
  ...props
}: ComponentProps<typeof AvatarPrimitive.Root>) {
  return (
    <AvatarPrimitive.Root
      className={cn(
        "relative flex size-9 shrink-0 overflow-hidden rounded-full",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        className,
      )}
      {...props}
    />
  );
}

export function AvatarImage({
  className,
  ...props
}: ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image
      // Inset ring (not outset) so the parent's overflow-hidden doesn't clip
      // it; rounded-full so the hairline traces the circle instead of touching
      // it at 4 points. Gives white-background profile images visible edges.
      className={cn(
        "aspect-square size-full rounded-full ring-1 ring-inset ring-black/10 dark:ring-white/15",
        className,
      )}
      {...props}
    />
  );
}

export function AvatarFallback({
  className,
  seed,
  style,
  ...props
}: ComponentProps<typeof AvatarPrimitive.Fallback> & {
  /** When set, paints a deterministic color gradient + white initials instead
   *  of flat gray, so people without a profile photo read as identity rather
   *  than a row of identical gray circles. Pass a stable per-person seed
   *  (user id, or name when no id is available). Omit it to keep the gray
   *  fallback (e.g. a "?" placeholder). */
  seed?: string;
}) {
  const colored = !!seed;
  return (
    <AvatarPrimitive.Fallback
      className={cn(
        "flex size-full items-center justify-center rounded-full text-xs font-medium",
        colored ? "text-white" : "bg-muted text-muted-foreground",
        className,
      )}
      // Spread consumer `style` last so an explicit override still wins.
      style={colored ? { backgroundImage: avatarGradient(seed), ...style } : style}
      {...props}
    />
  );
}
