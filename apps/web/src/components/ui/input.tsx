import type { ComponentProps } from "react";

import { cn } from "@ccp/shared/utils";

// React 19: ref flows through ComponentProps<"input">; no forwardRef wrapper.
export type InputProps = ComponentProps<"input">;

export function Input({ className, type, ...props }: InputProps) {
  return (
    <input
      type={type}
      className={cn(
        "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-[color,box-shadow,border-color]",
        "placeholder:text-muted-foreground",
        // Form-control focus recipe (shared verbatim by Input/Textarea/Select):
        // a NEUTRAL focus — the border darkens to a foreground tint + a soft
        // neutral halo hugs the field. Deliberately not the brand-green ring
        // (that read as loud/dated on a large field); this is the quiet
        // Linear/Vercel input treatment. Keyboard-nav a11y is still covered by
        // the global :focus-visible outline for non-input controls.
        "focus-visible:outline-hidden focus-visible:border-foreground/30 focus-visible:ring-2 focus-visible:ring-foreground/10",
        "file:border-0 file:bg-transparent file:text-sm file:font-medium",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
