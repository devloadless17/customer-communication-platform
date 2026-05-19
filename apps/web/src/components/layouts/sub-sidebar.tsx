"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight } from "lucide-react";

import { cn } from "@ccp/shared/utils";

/**
 * Shared building blocks for every section's contextual sidebar (the column
 * that lives between the AppRail and the main content). Pages compose these
 * to match their nav shape — settings has groups of links, contacts has
 * collapsible filter groups, inbox has presets + stages.
 *
 * The shell is fixed-width and full-height so columns line up across pages.
 */

export function SubSidebar({
  title,
  subtitle,
  topAction,
  children,
}: {
  title: string;
  subtitle?: string;
  /** Rendered to the right of the title — search button, kebab, etc. */
  topAction?: ReactNode;
  children: ReactNode;
}) {
  return (
    <aside className="flex h-svh w-52 shrink-0 flex-col border-r border-sidebar-border bg-sidebar/40 text-sidebar-foreground md:w-64">
      <header className="flex items-center gap-2 px-4 pb-3 pt-4">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold leading-tight">
            {title}
          </h2>
          {subtitle && (
            <p className="truncate text-[11px] text-muted-foreground">
              {subtitle}
            </p>
          )}
        </div>
        {topAction}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pb-3">
        {children}
      </div>
    </aside>
  );
}

/**
 * Static labelled section. Use for non-collapsible groups (e.g. settings'
 * "User role settings"). For collapsible filter groups use `SubSidebarGroup`.
 */
export function SubSidebarSection({
  label,
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  return (
    <div className="mt-2 first:mt-0">
      {label && (
        <div className="px-4 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
          {label}
        </div>
      )}
      <div className="flex flex-col gap-0.5 px-2">{children}</div>
    </div>
  );
}

/** Collapsible group with a clickable header. Defaults to open. */
export function SubSidebarGroup({
  label,
  defaultOpen = true,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mt-2 first:mt-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-1.5 px-4 pb-1 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80 transition-colors hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="size-3" />
        ) : (
          <ChevronRight className="size-3" />
        )}
        <span className="flex-1 truncate">{label}</span>
      </button>
      {open && <div className="flex flex-col gap-0.5 px-2">{children}</div>}
    </div>
  );
}

/** Sub-label inside a group — e.g. "Lifecycle Stages" / "Lost Stages". */
export function SubSidebarSubLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2.5 pt-2 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
      {children}
    </div>
  );
}

export interface SubSidebarItemProps {
  href?: string;
  onClick?: () => void;
  label: string;
  /** Leading slot — pass an `<Icon className="size-4"/>` or a colored dot span. */
  leading?: ReactNode;
  trailing?: ReactNode;
  active?: boolean;
  disabled?: boolean;
}

/**
 * Single row in the sub-sidebar. Renders as `<Link>` when `href` is set,
 * otherwise a `<button>` (used by filter rows that don't change route).
 */
export function SubSidebarItem({
  href,
  onClick,
  label,
  leading,
  trailing,
  active,
  disabled,
}: SubSidebarItemProps) {
  const className = cn(
    "group flex h-8 items-center gap-2 rounded-md px-2.5 text-[13px] transition-colors",
    disabled
      ? "cursor-not-allowed text-muted-foreground/50"
      : "hover:bg-accent hover:text-accent-foreground cursor-pointer",
    active
      ? "bg-accent text-accent-foreground font-medium"
      : "text-muted-foreground",
  );

  const content = (
    <>
      {leading && (
        <span
          className={cn(
            "flex shrink-0 items-center justify-center",
            active ? "text-primary" : "text-muted-foreground",
          )}
        >
          {leading}
        </span>
      )}
      <span className="flex-1 truncate text-left">{label}</span>
      {trailing}
    </>
  );

  if (href && !disabled) {
    return (
      <Link href={href} className={className} aria-current={active ? "page" : undefined}>
        {content}
      </Link>
    );
  }
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={className}
      aria-current={active ? "page" : undefined}
    >
      {content}
    </button>
  );
}
