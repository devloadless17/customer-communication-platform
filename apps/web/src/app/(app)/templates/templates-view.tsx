"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Check,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { LocalTime } from "@/components/local-time";
import { TemplatePreview } from "@/features/templates/components/template-preview";
import { VariableBindingsEditor } from "@/features/templates/components/variable-bindings-editor";
import type { ContactFieldDefinition, TemplateDto } from "@ccp/shared/types";
import type { TemplateComponent } from "@ccp/shared/providers/types";
import { parseVariableBindings, type VariableBindings } from "@ccp/shared/template-bindings";
import { cn } from "@ccp/shared/utils";

/**
 * Templates index UI. Three pieces:
 *
 *   1. Header with filters (status + category + language) and a "New" button.
 *   2. Grid of template cards — name, status pill, body preview, metadata.
 *   3. Slide-in detail drawer with the rendered WhatsApp bubble, raw
 *      components, and the variable-bindings editor.
 *
 * Most operations stay client-side and post to /api/team/whatsapp/templates*.
 * After mutations we refetch the GET list so server-rendered state matches.
 */

type StatusFilter = "all" | "approved" | "pending" | "rejected" | "paused" | "disabled";

const VALID_STATUS_FILTERS: ReadonlySet<StatusFilter> = new Set([
  "all",
  "approved",
  "pending",
  "rejected",
  "paused",
  "disabled",
]);

export const TEMPLATES_STATUS_COOKIE = "templates-status";
export const TEMPLATES_SEARCH_COOKIE = "templates-search";

/** Parse the persisted status filter; defaults to "all" on missing/invalid. */
export function parseTemplatesStatus(raw: string | undefined): StatusFilter {
  return raw && VALID_STATUS_FILTERS.has(raw as StatusFilter)
    ? (raw as StatusFilter)
    : "all";
}

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
function writeTemplatesCookie(name: string, value: string) {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax`;
}

export function TemplatesView({
  initialTemplates,
  fieldDefinitions,
  connected,
  hasWabaId,
  canManage,
  initialQuery = "",
  initialStatusFilter = "all",
}: {
  initialTemplates: TemplateDto[];
  fieldDefinitions: ContactFieldDefinition[];
  connected: boolean;
  hasWabaId: boolean;
  /** `templates:manage` — gates create / refresh-from-Meta / edit bindings /
   *  delete. Reads stay open. */
  canManage: boolean;
  hasAppId: boolean;
  /** SSR-seeded from `templates-search` cookie. */
  initialQuery?: string;
  /** SSR-seeded from `templates-status` cookie. */
  initialStatusFilter?: StatusFilter;
}) {
  const { confirm, confirmDialog } = useConfirm();
  const [templates, setTemplates] = useState<TemplateDto[]>(initialTemplates);
  // Sync from SSR (router.refresh from useCatalogSync's
  // team:catalog:changed handler) so template sync / teammate edits
  // show up without a manual refresh.
  useEffect(() => {
    setTemplates(initialTemplates);
  }, [initialTemplates]);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [query, setQueryState] = useState(initialQuery);
  const [statusFilter, setStatusFilterState] =
    useState<StatusFilter>(initialStatusFilter);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Wrappers that mirror state → cookie. SSR reads on next refresh so
  // hard reload keeps the user on the same status filter + search.
  const setQuery = (next: string) => {
    setQueryState(next);
    writeTemplatesCookie(TEMPLATES_SEARCH_COOKIE, next);
  };
  const setStatusFilter = (next: StatusFilter) => {
    setStatusFilterState(next);
    writeTemplatesCookie(TEMPLATES_STATUS_COOKIE, next);
  };

  const selected = useMemo(
    () => templates.find((t) => t.id === selectedId) ?? null,
    [templates, selectedId],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return templates.filter((t) => {
      if (statusFilter !== "all" && t.status !== statusFilter) return false;
      if (!q) return true;
      return (
        t.name.toLowerCase().includes(q) ||
        t.bodyText.toLowerCase().includes(q) ||
        t.language.toLowerCase().includes(q)
      );
    });
  }, [templates, query, statusFilter]);

  const reload = useCallback(async () => {
    const res = await fetch("/api/team/whatsapp/templates");
    if (!res.ok) return;
    const data = (await res.json()) as { templates?: TemplateDto[] };
    if (data.templates) setTemplates(data.templates);
  }, []);

  const syncFromMeta = useCallback(async () => {
    setSyncError(null);
    setSyncing(true);
    try {
      const res = await fetch("/api/team/whatsapp/templates", { method: "POST" });
      const data = (await res.json()) as {
        templates?: TemplateDto[];
        error?: string;
        detail?: string;
      };
      if (!res.ok) {
        throw new Error([data.error, data.detail].filter(Boolean).join(": ") || `HTTP ${res.status}`);
      }
      if (data.templates) setTemplates(data.templates);
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }, []);

  const askDelete = useCallback(
    async (target: TemplateDto) => {
      const ok = await confirm({
        title: `Delete “${target.name}”?`,
        description: `The “${target.language}” variant will be removed from your WhatsApp Business Account and from this app. This can’t be undone.`,
        confirmLabel: "Delete template",
        destructive: true,
      });
      if (!ok) return;
      setDeleteError(null);
      setDeleting(true);
      try {
        const res = await fetch(`/api/team/whatsapp/templates/${target.id}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as
            | { error?: string; detail?: string }
            | null;
          throw new Error(
            [data?.error, data?.detail].filter(Boolean).join(": ") || `HTTP ${res.status}`,
          );
        }
        setTemplates((cur) => cur.filter((t) => t.id !== target.id));
        if (selectedId === target.id) setSelectedId(null);
      } catch (err) {
        setDeleteError(err instanceof Error ? err.message : "Delete failed");
      } finally {
        setDeleting(false);
      }
    },
    [confirm, selectedId],
  );

  const onBindingsSaved = useCallback((id: string, bindings: VariableBindings) => {
    setTemplates((cur) =>
      cur.map((t) => (t.id === id ? { ...t, variableBindings: bindings } : t)),
    );
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 md:py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Templates</h1>
        <p className="text-sm text-muted-foreground">
          Pre-approved WhatsApp templates. Required to message contacts outside
          the 24-hour customer-service window. Submit a new one for review or
          bind variables to contact fields for personalized broadcasts.
        </p>
      </header>

      {!connected && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
          <div className="font-medium text-amber-700 dark:text-amber-300">
            WhatsApp not connected
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            Connect your number in{" "}
            <Link href="/settings/whatsapp?expand=advanced" className="text-primary hover:underline">
              Settings → WhatsApp
            </Link>{" "}
            to load and create templates.
          </p>
        </div>
      )}

      {connected && !hasWabaId && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
          <div className="font-medium text-amber-700 dark:text-amber-300">
            WhatsApp Business Account ID needed
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            Templates live at the WABA level. Add your ID in{" "}
            <Link href="/settings/whatsapp?expand=advanced" className="text-primary hover:underline">
              Settings → WhatsApp
            </Link>
            .
          </p>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-55 max-w-md">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, body or language…"
            className="h-9 pl-8"
          />
        </div>
        <StatusFilterTabs value={statusFilter} onChange={setStatusFilter} templates={templates} />
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={syncFromMeta}
            disabled={syncing || !connected || !hasWabaId}
            className="h-9 gap-1.5 text-xs"
          >
            {syncing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            Refresh from Meta
          </Button>
          {canManage && (
            <Button asChild disabled={!connected || !hasWabaId}>
              <Link href="/templates/new" className="gap-1.5">
                <Plus className="size-4" />
                New template
              </Link>
            </Button>
          )}
        </div>
      </div>

      {syncError && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="wrap-break-word">{syncError}</span>
        </div>
      )}

      {templates.length === 0 ? (
        <EmptyState canCreate={connected && hasWabaId && canManage} />
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
          No templates match the current filters.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((t) => (
            <TemplateCard
              key={t.id}
              template={t}
              selected={t.id === selectedId}
              onClick={() => setSelectedId(t.id)}
            />
          ))}
        </div>
      )}

      <DetailDrawer
        template={selected}
        fieldDefinitions={fieldDefinitions}
        deleting={deleting}
        deleteError={deleteError}
        canManage={canManage}
        onClose={() => setSelectedId(null)}
        onDelete={() => selected && askDelete(selected)}
        onBindingsSaved={onBindingsSaved}
        onReload={reload}
      />

      {confirmDialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card grid + filters
// ---------------------------------------------------------------------------

function TemplateCard({
  template,
  selected,
  onClick,
}: {
  template: TemplateDto;
  selected: boolean;
  onClick: () => void;
}) {
  const components = (
    Array.isArray(template.components) ? (template.components as TemplateComponent[]) : []
  );
  const buttons = components.find((c) => c.type === "BUTTONS");
  const headerComp = components.find((c) => c.type === "HEADER");
  const bindings = parseVariableBindings(template.variableBindings as never);
  const hasBindings =
    bindings.body.some((b) => b.source.kind !== "manual") ||
    (bindings.header && bindings.header.source.kind !== "manual");

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex h-full flex-col gap-3 rounded-xl border bg-card p-4 text-left transition-all",
        "hover:border-primary/30 hover:shadow-xs",
        selected ? "border-primary ring-2 ring-primary/20" : "border-border",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <FileText className="size-3.5" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium leading-tight">{template.name}</div>
            <div className="mt-0.5 flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              <span className="font-mono">{template.language}</span>
              <span aria-hidden="true">·</span>
              <CategoryPill category={template.category} />
            </div>
          </div>
        </div>
        <StatusPill status={template.status} />
      </div>

      <p className="line-clamp-3 text-[12.5px] leading-relaxed text-muted-foreground">
        {template.bodyText || "—"}
      </p>

      <div className="mt-auto flex items-center gap-2 text-[10px] text-muted-foreground">
        {headerComp && (
          <span className="rounded-full bg-muted/60 px-1.5 py-0.5 font-medium">
            {headerComp.format ?? "TEXT"} header
          </span>
        )}
        {buttons?.buttons && buttons.buttons.length > 0 && (
          <span className="rounded-full bg-muted/60 px-1.5 py-0.5 font-medium">
            {buttons.buttons.length} button{buttons.buttons.length === 1 ? "" : "s"}
          </span>
        )}
        {hasBindings && (
          <span className="rounded-full bg-primary/10 px-1.5 py-0.5 font-medium text-primary">
            personalized
          </span>
        )}
      </div>
    </button>
  );
}

function StatusFilterTabs({
  value,
  onChange,
  templates,
}: {
  value: StatusFilter;
  onChange: (v: StatusFilter) => void;
  templates: TemplateDto[];
}) {
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of templates) m.set(t.status, (m.get(t.status) ?? 0) + 1);
    return m;
  }, [templates]);

  const tabs: Array<{ key: StatusFilter; label: string }> = [
    { key: "all", label: "All" },
    { key: "approved", label: "Approved" },
    { key: "pending", label: "Pending" },
    { key: "rejected", label: "Rejected" },
    { key: "paused", label: "Paused" },
    { key: "disabled", label: "Disabled" },
  ];

  return (
    <div className="flex items-center gap-1 rounded-md border border-border bg-card p-0.5">
      {tabs.map((t) => {
        const count = t.key === "all" ? templates.length : counts.get(t.key) ?? 0;
        if (t.key !== "all" && t.key !== value && count === 0) return null;
        const active = value === t.key;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            className={cn(
              "rounded px-2.5 py-1 text-[12px] font-medium transition-colors",
              active
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {t.label}
            <span className="ml-1.5 tabular-nums text-[10.5px] text-muted-foreground">
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "approved"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : status === "pending"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : status === "rejected"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-border bg-muted/40 text-muted-foreground";
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wide",
        tone,
      )}
    >
      {status}
    </span>
  );
}

function CategoryPill({ category }: { category: string }) {
  const tone =
    category === "marketing"
      ? "text-pink-700 dark:text-pink-300"
      : category === "utility"
        ? "text-sky-700 dark:text-sky-300"
        : "text-violet-700 dark:text-violet-300";
  return <span className={cn("font-medium", tone)}>{category}</span>;
}

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------

function DetailDrawer({
  template,
  fieldDefinitions,
  deleting,
  deleteError,
  canManage,
  onClose,
  onDelete,
  onBindingsSaved,
  onReload,
}: {
  template: TemplateDto | null;
  fieldDefinitions: ContactFieldDefinition[];
  deleting: boolean;
  deleteError: string | null;
  canManage: boolean;
  onClose: () => void;
  onDelete: () => void;
  onBindingsSaved: (id: string, bindings: VariableBindings) => void;
  onReload: () => void;
}) {
  return (
    <AnimatePresence>
      {template && (
        <>
          <motion.div
            className="fixed inset-0 z-40 bg-background/60 backdrop-blur-xs"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.aside
            className="fixed right-0 top-0 z-50 flex h-svh w-full max-w-2xl flex-col border-l border-border bg-card shadow-2xl"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 280 }}
          >
            <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-lg font-semibold tracking-tight">
                    {template.name}
                  </h2>
                  <StatusPill status={template.status} />
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="font-mono">{template.language}</span>
                  <span aria-hidden="true">·</span>
                  <CategoryPill category={template.category} />
                  {template.externalId && (
                    <>
                      <span aria-hidden="true">·</span>
                      <code className="rounded bg-muted/60 px-1 py-0.5 text-[10px]">
                        {template.externalId}
                      </code>
                    </>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Close"
              >
                <X className="size-4" />
              </button>
            </header>

            <div className="flex-1 overflow-y-auto">
              <div className="flex flex-col gap-6 px-5 py-5">
                <section>
                  <SectionLabel>Preview</SectionLabel>
                  <div className="mt-2 rounded-xl border border-border bg-muted/30 p-4">
                    <TemplatePreview
                      components={
                        Array.isArray(template.components)
                          ? (template.components as TemplateComponent[])
                          : []
                      }
                    />
                  </div>
                </section>

                <section>
                  <SectionLabel>Variable bindings</SectionLabel>
                  <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                    Pull each <code className="rounded bg-muted px-1 text-[11px]">{"{{n}}"}</code> from a contact
                    field, or leave it as a manual value the agent fills at
                    broadcast time. Default values cover contacts whose field
                    is empty.
                  </p>
                  <div className="mt-3">
                    {canManage ? (
                      <VariableBindingsEditor
                        templateId={template.id}
                        components={
                          Array.isArray(template.components)
                            ? (template.components as TemplateComponent[])
                            : []
                        }
                        initialBindings={parseVariableBindings(
                          template.variableBindings as never,
                        )}
                        fieldDefinitions={fieldDefinitions}
                        onSaved={(bindings) => onBindingsSaved(template.id, bindings)}
                      />
                    ) : (
                      <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-[12px] text-muted-foreground">
                        You don&apos;t have permission to edit template bindings.
                      </p>
                    )}
                  </div>
                </section>

                {template.status === "rejected" && (
                  <section>
                    <SectionLabel>Rejection details</SectionLabel>
                    <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-[12px] text-destructive">
                      Meta rejected this template. WhatsApp Manager has the
                      specific reason — once fixed, delete this and submit a
                      new one with the corrected content.
                    </div>
                  </section>
                )}

                <section>
                  <SectionLabel>Components (Meta wire format)</SectionLabel>
                  <pre className="mt-2 max-h-72 overflow-auto rounded-md border border-border bg-muted/30 p-3 text-[11px] leading-relaxed">
                    {JSON.stringify(template.components, null, 2)}
                  </pre>
                </section>
              </div>
            </div>

            <footer className="flex flex-col gap-2 border-t border-border bg-card/95 px-5 py-3">
              {deleteError && (
                <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <span className="wrap-break-word">{deleteError}</span>
                </div>
              )}
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] text-muted-foreground">
                  Last synced <LocalTime iso={template.syncedAt} format="localeString" />
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onReload}
                    className="gap-1.5"
                  >
                    <RefreshCw className="size-3.5" />
                    Reload
                  </Button>
                  {canManage && (
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={onDelete}
                      disabled={deleting}
                      className="gap-1.5"
                    >
                      {deleting ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="size-3.5" />
                      )}
                      Delete
                    </Button>
                  )}
                </div>
              </div>
            </footer>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      <span>{children}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function EmptyState({ canCreate }: { canCreate: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card px-6 py-16 text-center">
      <div className="inline-flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Check className="size-5" />
      </div>
      <div className="text-sm font-medium">No templates yet</div>
      <p className="max-w-md text-[12px] leading-relaxed text-muted-foreground">
        Create a template here or refresh from Meta to pull in templates you
        approved in WhatsApp Manager. Templates are required to message
        contacts outside the 24-hour window.
      </p>
      {canCreate && (
        <Button asChild className="mt-2">
          <Link href="/templates/new">Create your first template</Link>
        </Button>
      )}
    </div>
  );
}
