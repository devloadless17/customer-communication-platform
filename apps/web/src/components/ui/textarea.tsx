import type { ComponentProps } from "react";

import { cn } from "@ccp/shared/utils";

// React 19: ref flows through ComponentProps<"textarea">.
export type TextareaProps = ComponentProps<"textarea">;

export function Textarea({ className, ...props }: TextareaProps) {
  return (
    <textarea
      className={cn(
        "flex min-h-15 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow,border-color]",
        "placeholder:text-muted-foreground",
        // Shared form-control focus recipe (see input.tsx): border-ring + soft halo.
        "focus-visible:outline-hidden focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "resize-none",
        className,
      )}
      {...props}
    />
  );
}
