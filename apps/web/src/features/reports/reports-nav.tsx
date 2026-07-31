"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@ccp/shared/utils";

/**
 * Section switcher for the /reports pages. Reports deliberately has no
 * sub-sidebar (the overview is one page), so its sibling sections — Overview,
 * Team, Campaigns — navigate through this pill row instead. Detail pages one
 * level deeper (a single campaign) keep their own back link.
 */

const SECTIONS = [
  { href: "/reports", label: "Overview" },
  { href: "/reports/team", label: "Team" },
  { href: "/reports/campaigns", label: "Campaigns" },
] as const;

export function ReportsNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Reports sections"
      className="flex w-fit items-center gap-0.5 rounded-lg border border-border bg-card p-0.5"
    >
      {SECTIONS.map((s) => {
        const active =
          s.href === "/reports" ? pathname === "/reports" : pathname.startsWith(s.href);
        return (
          <Link
            key={s.href}
            href={s.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1 text-xs font-medium transition-colors",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
