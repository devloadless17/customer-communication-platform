import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@ccp/shared/utils";

const statusVariants = cva(
  "inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-2xs font-medium",
  {
    variants: {
      variant: {
        warning: "border-warning-border bg-warning-bg text-warning-fg",
        success: "border-success-border bg-success-bg text-success-fg",
        info: "border-info-border bg-info-bg text-info-fg",
        neutral: "border-border bg-muted text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "neutral",
    },
  },
);

export interface StatusPillProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof statusVariants> {}

export function StatusPill({ className, variant, ...props }: StatusPillProps) {
  return <span className={cn(statusVariants({ variant }), className)} {...props} />;
}

export { statusVariants };
