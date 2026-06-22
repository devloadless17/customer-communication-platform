"use client";

import { motion } from "framer-motion";
import { MessageSquare } from "lucide-react";

import { cn } from "@ccp/shared/utils";

export function ToggleButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof MessageSquare;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors",
        active
          ? "font-semibold text-foreground"
          : "font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground",
      )}
    >
      {active && (
        <motion.span
          layoutId="reply-toggle-pill"
          className="absolute inset-0 rounded-md bg-card shadow-sm ring-1 ring-border/80"
          transition={{ type: "spring", duration: 0.25, bounce: 0.18 }}
        />
      )}
      <Icon className="relative size-3.5" />
      <span className="relative">{label}</span>
    </button>
  );
}
