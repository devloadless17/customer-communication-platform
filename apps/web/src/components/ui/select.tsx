import type { ComponentProps } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@ccp/shared/utils";

// Styled NATIVE <select> wrapper — keeps OS-native a11y + zero JS, applies the
// project's input tokens (mirrors components/ui/input.tsx) + a trailing chevron.
// React 19: ref flows through ComponentProps<"select">; no forwardRef wrapper.
export type SelectProps = ComponentProps<"select"> & {
  // Layout classes for the positioning wrapper (the flex/grid child). Use this
  // for `flex-1`, `max-w-*`, etc.; `className` styles the inner <select>.
  wrapperClassName?: string;
};

export function Select({ className, wrapperClassName, children, ...props }: SelectProps) {
  return (
    // Block wrapper: fills stretch contexts (grid/flex cells) and hugs content in
    // intrinsic ones — the select's `w-full` makes it fill the wrapper either way.
    <div className={cn("relative", wrapperClassName)}>
      <select
        className={cn(
          "flex h-9 w-full appearance-none rounded-md border border-input bg-transparent px-3 py-1 pr-8 text-sm shadow-xs transition-[color,box-shadow,border-color]",
          // Shared form-control focus recipe (see input.tsx): neutral border tint + soft halo.
          "focus-visible:outline-hidden focus-visible:border-foreground/30 focus-visible:ring-2 focus-visible:ring-foreground/10",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}
