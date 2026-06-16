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
        // border shifts to the ring color + a soft same-color halo hugs the
        // field. No offset ring (that's the button/switch category) — this is
        // the modern Linear/Stripe input treatment.
        "focus-visible:outline-hidden focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30",
        "file:border-0 file:bg-transparent file:text-sm file:font-medium",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
