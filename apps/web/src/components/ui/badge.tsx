import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@ccp/shared/utils";

const badgeVariants = cva(
  "inline-flex items-center whitespace-nowrap rounded-md border font-medium transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary/15 text-primary",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border text-foreground",
        muted: "border-transparent bg-muted text-muted-foreground",
        // Semantic variants route through the canonical token trios (same source
        // as StatusPill) so success/warning/info render ONE hue app-wide and
        // track the OKLCH dark-mode shifts — no raw emerald/amber literals.
        success: "border-success-border bg-success-bg text-success-fg",
        warning: "border-warning-border bg-warning-bg text-warning-fg",
        info: "border-info-border bg-info-bg text-info-fg",
        destructive: "border-transparent bg-destructive/15 text-destructive",
      },
      // `default` reproduces the prior fixed sizing exactly (px-2 py-0.5 text-xs)
      // so every existing callsite is unchanged; `sm` retires hand-rolled micro
      // pills (StatusPill text-[9.5px]) and `lg` is for prominent status chips.
      size: {
        default: "px-2 py-0.5 text-xs",
        sm: "px-1.5 py-0.5 text-2xs",
        lg: "px-3 py-1 text-sm",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, size, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, size }), className)} {...props} />;
}

export { badgeVariants };
