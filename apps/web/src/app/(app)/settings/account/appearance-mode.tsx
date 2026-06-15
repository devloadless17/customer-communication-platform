"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import { cn } from "@ccp/shared/utils";

/**
 * Light / Dark / System mode picker. Wraps next-themes' `setTheme` (the
 * ThemeProvider in app/layout.tsx already applies the `class` strategy to
 * <html>, and globals.css ships the `.dark` token overrides).
 *
 * The active selection is gated on a mount flag: next-themes only knows the
 * resolved theme on the client, so reflecting it during SSR would mismatch
 * hydration. Until mounted, nothing reads as selected (one frame).
 */
const OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const;

export function AppearanceMode() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const current = mounted ? theme ?? "system" : undefined;

  return (
    <div
      role="radiogroup"
      aria-label="Color mode"
      className="inline-flex rounded-lg border border-border bg-muted/40 p-1"
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => {
        const active = current === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setTheme(value)}
            className={cn(
              "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              active
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
