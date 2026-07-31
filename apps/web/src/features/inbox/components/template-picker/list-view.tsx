"use client";

import Link from "next/link";
import {
  AlertTriangle,
  ChevronRight,
  Clock,
  FileText,
  Loader2,
  Search,
  Tag as TagIcon,
} from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@ccp/shared/utils";
import { unsupportedTemplateFeature } from "@ccp/shared/template-render";
import type { TemplateDto } from "@ccp/shared/types";

import { labelCategory } from "./utils";

export function TemplateListView({
  loading,
  error,
  query,
  onQueryChange,
  templates,
  labelOptions,
  activeLabel,
  onLabelChange,
  recent,
  onSelect,
}: {
  loading: boolean;
  error: string | null;
  query: string;
  onQueryChange: (q: string) => void;
  templates: TemplateDto[];
  /** The workspace's label vocabulary (derived from the loaded list) — the
   *  filter-chip row. Empty = row hidden entirely. */
  labelOptions: string[];
  activeLabel: string | null;
  onLabelChange: (label: string | null) => void;
  /** "Recently used" quick row — already capped and ordered by the parent;
   *  empty while a search/filter is active. */
  recent: TemplateDto[];
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex max-h-120 flex-col">
      <div className="border-b border-border px-3 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search by name, label, language, or body…"
            aria-label="Search templates"
            className="h-9 pl-8"
            autoFocus
          />
        </div>
        {/* Label filter chips — only when the workspace has labeled anything. */}
        {labelOptions.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1">
            {labelOptions.map((label) => {
              const active =
                activeLabel?.toLowerCase() === label.toLowerCase();
              return (
                <button
                  key={label.toLowerCase()}
                  type="button"
                  onClick={() => onLabelChange(active ? null : label)}
                  aria-pressed={active}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium transition-colors",
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-muted/40 text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  <TagIcon className="size-2.5" aria-hidden="true" />
                  {label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center gap-2 px-4 py-12 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span>Loading templates…</span>
          </div>
        ) : templates.length === 0 ? (
          <EmptyState query={query} filtered={activeLabel !== null} />
        ) : (
          <>
            {recent.length > 0 && (
              <>
                <SectionHeading icon={<Clock className="size-3" aria-hidden="true" />}>
                  Recently used
                </SectionHeading>
                <ul className="divide-y divide-border">
                  {recent.map((t) => (
                    <TemplateRow key={`recent-${t.id}`} template={t} onSelect={onSelect} />
                  ))}
                </ul>
                <SectionHeading>All templates</SectionHeading>
              </>
            )}
            <ul className="divide-y divide-border">
              {templates.map((t) => (
                <TemplateRow key={t.id} template={t} onSelect={onSelect} />
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function SectionHeading({
  icon,
  children,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 border-b border-border bg-muted/30 px-4 py-1.5 text-3xs font-semibold uppercase tracking-wide text-muted-foreground">
      {icon}
      <span>{children}</span>
    </div>
  );
}

function TemplateRow({
  template: t,
  onSelect,
}: {
  template: TemplateDto;
  onSelect: (id: string) => void;
}) {
  // Commerce templates need product parameters the platform can't
  // supply — the server refuses them, so offering one is a dead click.
  const unsupported = unsupportedTemplateFeature(t.components);
  const sendable = t.status === "approved" && !unsupported;
  return (
    <li>
      <button
        type="button"
        onClick={() => sendable && onSelect(t.id)}
        disabled={!sendable}
        className={cn(
          "group flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left transition-colors",
          "hover:bg-accent/50 focus:bg-accent/50 focus:outline-hidden",
          !sendable && "cursor-not-allowed opacity-60 hover:bg-transparent",
        )}
      >
        <div className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/8 text-primary">
          <FileText className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{t.name}</span>
            <CategoryPill category={t.category} />
            <span className="rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
              {t.language}
            </span>
            {t.status !== "approved" && <StatusPill status={t.status} />}
            {unsupported && (
              <span className="rounded-full border border-warning-border bg-warning-bg px-1.5 py-0.5 text-3xs font-medium uppercase text-warning-fg">
                Needs {unsupported}
              </span>
            )}
            <QualityPill score={t.qualityScore} />
            {/* Organizational labels — quieter than the state pills, capped so
                a heavily-tagged template doesn't wrap the whole row. */}
            {t.labels.slice(0, 2).map((label) => (
              <span
                key={label.toLowerCase()}
                className="inline-flex max-w-24 items-center gap-1 rounded-full border border-border bg-muted/40 px-1.5 py-0.5 text-3xs font-medium text-muted-foreground"
              >
                <TagIcon className="size-2.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{label}</span>
              </span>
            ))}
            {t.labels.length > 2 && (
              <span
                className="text-3xs text-muted-foreground"
                title={t.labels.slice(2).join(", ")}
              >
                +{t.labels.length - 2}
              </span>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-snug text-muted-foreground">
            {t.bodyText || "—"}
          </p>
        </div>
        {sendable && (
          <ChevronRight className="mt-2 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
        )}
      </button>
    </li>
  );
}

function EmptyState({ query, filtered }: { query: string; filtered: boolean }) {
  if (query.trim().length > 0 || filtered) {
    return (
      <div className="flex flex-col items-center justify-center gap-1 px-4 py-12 text-center">
        <Search className="size-5 text-muted-foreground" />
        <div className="text-sm font-medium">
          {query.trim().length > 0
            ? `No templates match “${query}”.`
            : "No templates carry this label."}
        </div>
        <div className="text-2xs text-muted-foreground">
          {query.trim().length > 0
            ? "Try a different name, label, or language."
            : "Clear the label filter to see the full list."}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <FileText className="size-5 text-muted-foreground" />
      <div className="text-sm font-medium">No templates yet</div>
      <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
        Create a template here and submit it to Meta for review. Once approved,
        click <span className="font-medium">Refresh</span> to load it.
      </p>
      <div className="mt-1 flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
        {/* In-app builder first — keep the agent in the product. /templates/new
            redirects non-managers to /templates, so /templates is the safe
            universal target. */}
        <Link
          href="/templates"
          className="text-xs font-medium text-primary hover:underline"
        >
          Create one in Templates →
        </Link>
        <a
          className="text-xs font-medium text-muted-foreground hover:underline"
          href="https://business.facebook.com/wa/manage/message-templates"
          target="_blank"
          rel="noreferrer"
        >
          Open WhatsApp Manager →
        </a>
      </div>
    </div>
  );
}

function CategoryPill({ category }: { category: string }) {
  const tone =
    category === "marketing"
      ? "border-pink-500/30 bg-pink-500/10 text-pink-700 dark:text-pink-300"
      : category === "utility"
        ? "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
        : "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300";
  return (
    <span
      className={cn(
        "rounded-full border px-1.5 py-0.5 text-3xs font-medium uppercase tracking-wide",
        tone,
      )}
    >
      {labelCategory(category)}
    </span>
  );
}

/**
 * Meta's per-TEMPLATE quality band, shown only when it is a warning: RED/YELLOW
 * mean the template drew negative feedback or low read-rates and risks a pause
 * or disable. GREEN and UNKNOWN are the healthy default and render nothing.
 * Carried verbatim from Meta, so an unrecognized band also stays silent.
 */
function QualityPill({ score }: { score: string | null }) {
  const band = score?.toUpperCase();
  if (band !== "RED" && band !== "YELLOW") return null;
  return (
    <span
      className={cn(
        "rounded-full border px-1.5 py-0.5 text-3xs font-medium uppercase",
        band === "RED"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-warning-border bg-warning-bg text-warning-fg",
      )}
    >
      {band === "RED" ? "Low quality" : "Medium quality"}
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "pending"
      ? "border-warning-border bg-warning-bg text-warning-fg"
      : status === "rejected"
        ? "border-destructive/30 bg-destructive/10 text-destructive"
        : "border-border bg-muted/40 text-muted-foreground";
  return (
    <span
      className={cn(
        "rounded-full border px-1.5 py-0.5 text-3xs font-medium uppercase",
        tone,
      )}
    >
      {status}
    </span>
  );
}
