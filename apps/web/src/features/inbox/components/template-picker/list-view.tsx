"use client";

import Link from "next/link";
import {
  AlertTriangle,
  ChevronRight,
  FileText,
  Loader2,
  Search,
} from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@ccp/shared/utils";
import type { TemplateDto } from "@ccp/shared/types";

import { labelCategory } from "./utils";

export function TemplateListView({
  loading,
  error,
  query,
  onQueryChange,
  templates,
  onSelect,
}: {
  loading: boolean;
  error: string | null;
  query: string;
  onQueryChange: (q: string) => void;
  templates: TemplateDto[];
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex max-h-[480px] flex-col">
      <div className="border-b border-border px-3 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search by name, language, or body…"
            className="h-9 pl-8"
            autoFocus
          />
        </div>
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
          <EmptyState query={query} />
        ) : (
          <ul className="divide-y divide-border">
            {templates.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => t.status === "approved" && onSelect(t.id)}
                  disabled={t.status !== "approved"}
                  className={cn(
                    "group flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left transition-colors",
                    "hover:bg-accent/60 focus:bg-accent/60 focus:outline-hidden",
                    t.status !== "approved" && "cursor-not-allowed opacity-60 hover:bg-transparent",
                  )}
                >
                  <div className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/8 text-primary">
                    <FileText className="size-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{t.name}</span>
                      <CategoryPill category={t.category} />
                      <span className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
                        {t.language}
                      </span>
                      {t.status !== "approved" && <StatusPill status={t.status} />}
                    </div>
                    <p className="mt-1 line-clamp-2 text-[12px] leading-snug text-muted-foreground">
                      {t.bodyText || "—"}
                    </p>
                  </div>
                  {t.status === "approved" && (
                    <ChevronRight className="mt-2 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function EmptyState({ query }: { query: string }) {
  if (query.trim().length > 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-1 px-4 py-12 text-center">
        <Search className="size-5 text-muted-foreground" />
        <div className="text-sm font-medium">No templates match “{query}”.</div>
        <div className="text-2xs text-muted-foreground">
          Try a different name or language.
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <FileText className="size-5 text-muted-foreground" />
      <div className="text-sm font-medium">No templates yet</div>
      <p className="max-w-md text-[12px] leading-relaxed text-muted-foreground">
        Create a template here and submit it to Meta for review. Once approved,
        click <span className="font-medium">Refresh</span> to load it.
      </p>
      <div className="mt-1 flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
        {/* In-app builder first — keep the agent in the product. /templates/new
            redirects non-managers to /templates, so /templates is the safe
            universal target. */}
        <Link
          href="/templates"
          className="text-[12px] font-medium text-primary hover:underline"
        >
          Create one in Templates →
        </Link>
        <a
          className="text-[12px] font-medium text-muted-foreground hover:underline"
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

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "pending"
      ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
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
