"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Check,
  FileText,
  Loader2,
  Plus,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Search,
  Play,
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
import { apiFetch } from "@/lib/api/client-fetch";
import type { ContactFieldDefinition, TemplateDto } from "@ccp/shared/types";
import type { TemplateComponent } from "@ccp/shared/providers/types";
import { parseVariableBindings, type VariableBindings } from "@ccp/shared/template-bindings";
import { TemplateInsights } from "@/features/broadcasts/charts/template-insights";
import { TemplateComparison } from "@/features/templates/components/template-comparison";
import {
  TEMPLATE_AUTO_ARCHIVE_MONTHS,
  templateArchivalRisk,
  templateDeletionDaysLeft,
} from "@ccp/shared/template-render";
import { cn } from "@ccp/shared/utils";

/**
 * Templates index UI. Three pieces:
 *
 *   1. Header with filters (status + category + language) and a "New" button.
 *   2. Grid of template cards — name, status pill, body preview, metadata.
 *   3. Slide-in detail drawer with the rendered WhatsApp bubble, raw
 *      components, and the variable-bindings editor.
 *
 * Most operations stay client-side and post to /api/workspace/whatsapp/templates*.
 * After mutations we refetch the GET list so server-rendered state matches.
 */

// Re-export pure primitives so existing client-side imports keep
// working through this file. Definitions live in `./templates-cookies.ts`
// (no "use client") so the SSR page can read the cookies without
// crashing on "Attempted to call X() from the server but X is on the
// client." Same split as inbox-filter / broadcasts-cookies.
export {
  TEMPLATES_SEARCH_COOKIE,
  TEMPLATES_STATUS_COOKIE,
  parseTemplatesStatus,
  type TemplatesStatusFilter,
} from "./templates-cookies";

import {
  TEMPLATES_SEARCH_COOKIE,
  TEMPLATES_STATUS_COOKIE,
  type TemplatesStatusFilter,
} from "./templates-cookies";

type StatusFilter = TemplatesStatusFilter;

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
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);

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
    setReloadError(null);
    setReloading(true);
    try {
      const res = await apiFetch("/api/workspace/whatsapp/templates");
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string; detail?: string }
          | null;
        throw new Error(
          [data?.error, data?.detail].filter(Boolean).join(": ") ||
            `HTTP ${res.status}`,
        );
      }
      const data = (await res.json()) as { templates?: TemplateDto[] };
      if (data.templates) setTemplates(data.templates);
    } catch (err) {
      setReloadError(err instanceof Error ? err.message : "Reload failed");
    } finally {
      setReloading(false);
    }
  }, []);

  const syncFromMeta = useCallback(async () => {
    setSyncError(null);
    setSyncing(true);
    try {
      const res = await apiFetch("/api/workspace/whatsapp/templates", { method: "POST" });
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
      // Meta blocks reusing an APPROVED template's NAME for 30 days after
      // deletion, so "delete and recreate" — which this app used to recommend —
      // strands the operator for a month. Say so before they commit, and point
      // at editing, which has no such penalty.
      const nameLocked = target.status === "approved";
      const ok = await confirm({
        title: `Delete “${target.name}”?`,
        description:
          `The “${target.language}” variant will be removed from your WhatsApp ` +
          `Business Account and from this app. This can’t be undone.` +
          (nameLocked
            ? `\n\nBecause it’s approved, Meta won’t let you create another template ` +
              `called “${target.name}” for 30 days. If you only need to change its ` +
              `content or category, edit it instead — an edit re-enters review ` +
              `without losing the name.`
            : ""),
        confirmLabel: "Delete template",
        destructive: true,
      });
      if (!ok) return;
      setDeleteError(null);
      setDeleting(true);
      try {
        const res = await apiFetch(`/api/workspace/whatsapp/templates/${target.id}`, {
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

  const [unpausing, setUnpausing] = useState<string | null>(null);
  const [unpauseError, setUnpauseError] = useState<string | null>(null);

  /**
   * Lift a quality pause.
   *
   * Meta lifts a quality pause itself (3h, then 6h, then it DISABLES the
   * template), so this is not the normal recovery path — it is for a template
   * paused by Template Pacing, which never unpauses on its own.
   */
  const onUnpause = useCallback(async (target: TemplateDto) => {
    setUnpauseError(null);
    setUnpausing(target.id);
    try {
      const res = await apiFetch(
        `/api/workspace/whatsapp/templates/${target.id}/unpause`,
        { method: "POST" },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string; detail?: string }
          | null;
        throw new Error(
          [data?.error, data?.detail].filter(Boolean).join(": ") || `HTTP ${res.status}`,
        );
      }
      // Meta re-derives the band from recent feedback on unpause, so the RED
      // that caused the pause is cleared server-side — mirror that here rather
      // than leaving a stale band next to an active status.
      setTemplates((cur) =>
        cur.map((t) =>
          t.id === target.id
            ? { ...t, status: "approved", qualityScore: null, qualityScoreAt: null }
            : t,
        ),
      );
    } catch (err) {
      setUnpauseError(err instanceof Error ? err.message : "Unpause failed");
    } finally {
      setUnpausing(null);
    }
  }, []);

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
        <div className="rounded-lg border border-warning-border bg-warning-bg p-4 text-sm">
          <div className="font-medium text-warning-fg">
            WhatsApp not connected
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Connect your number in{" "}
            <Link href="/settings/whatsapp?expand=advanced" className="text-primary hover:underline">
              Settings → WhatsApp
            </Link>{" "}
            to load and create templates.
          </p>
        </div>
      )}

      {connected && !hasWabaId && (
        <div className="rounded-lg border border-warning-border bg-warning-bg p-4 text-sm">
          <div className="font-medium text-warning-fg">
            WhatsApp Business Account ID needed
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
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
          {/* The library is the FASTER path — an unchanged blueprint is approved
              immediately, where an authored template waits for review — so it
              sits beside "New template" rather than buried inside it. */}
          {canManage && connected && hasWabaId && (
            <Button asChild variant="outline">
              <Link href="/templates/library" className="gap-1.5">
                <Sparkles className="size-4" />
                Browse library
              </Link>
            </Button>
          )}
          {/* Its own entry point because an authentication template has nothing
              to author — the wording is Meta's. Sending people through the
              composer would offer an editor for copy that can't be edited. */}
          {canManage && connected && hasWabaId && (
            <Button asChild variant="outline">
              <Link href="/templates/authentication" className="gap-1.5">
                <ShieldCheck className="size-4" />
                Authentication
              </Link>
            </Button>
          )}
          {canManage &&
            (!connected || !hasWabaId ? (
              // Render a REAL disabled button (not asChild→<a>, which ignores
              // `disabled` and looks/behaves enabled). /templates/new redirects
              // when not connected anyway, so this is just the right affordance.
              <Button disabled title="Connect WhatsApp first">
                <Plus className="size-4" />
                New template
              </Button>
            ) : (
              <Button asChild>
                <Link href="/templates/new" className="gap-1.5">
                  <Plus className="size-4" />
                  New template
                </Link>
              </Button>
            ))}
        </div>
      </div>

      {syncError && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="wrap-break-word">{syncError}</span>
        </div>
      )}

      {templates.length === 0 && syncing ? (
        // Pulling from Meta with nothing seeded yet — reserve the grid's shape
        // with placeholder cards so the layout doesn't jump when results land.
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <TemplateCardSkeleton key={i} />
          ))}
        </div>
      ) : templates.length === 0 ? (
        <EmptyState canCreate={connected && hasWabaId && canManage} />
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
          No templates match the current filters.
        </div>
      ) : (
        <div
          className={cn(
            "grid grid-cols-1 gap-3 transition-opacity md:grid-cols-2 lg:grid-cols-3",
            syncing && "opacity-60",
          )}
        >
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
        allTemplates={templates}
        fieldDefinitions={fieldDefinitions}
        deleting={deleting}
        deleteError={deleteError}
        reloading={reloading}
        reloadError={reloadError}
        canManage={canManage}
        onClose={() => setSelectedId(null)}
        onDelete={() => selected && askDelete(selected)}
        unpausing={unpausing === selected?.id}
        unpauseError={unpauseError}
        onUnpause={() => selected && void onUnpause(selected)}
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
        "group flex h-full flex-col gap-3 rounded-xl border p-4 text-left transition-all",
        selected
          ? "border-primary bg-primary/5 shadow-xs"
          : "border-border bg-card hover:border-primary/30 hover:shadow-xs",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <FileText className="size-3.5" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium leading-tight">{template.name}</div>
            <div className="mt-0.5 flex items-center gap-1 text-3xs uppercase tracking-wide text-muted-foreground">
              <span className="font-mono">{template.language}</span>
              <span aria-hidden="true">·</span>
              <CategoryPill category={template.category} />
              {/* Pricing is about to change for this template — worth seeing
                  without opening the drawer. */}
              {template.correctCategory && (
                <span
                  className="text-warning-fg"
                  title={`Meta will move this template to ${template.correctCategory}`}
                >
                  → {template.correctCategory}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <QualityDot
            score={template.qualityScore}
            at={template.qualityScoreAt}
            status={template.status}
          />
          <StatusPill status={template.status} />
        </div>
      </div>

      <p className="line-clamp-3 text-[12.5px] leading-relaxed text-muted-foreground">
        {template.bodyText || "—"}
      </p>

      <div className="mt-auto flex items-center gap-2 text-3xs text-muted-foreground">
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

function TemplateCardSkeleton() {
  return (
    <div className="flex h-full animate-pulse flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="size-7 shrink-0 rounded-md bg-muted" />
          <div className="flex flex-col gap-1.5">
            <span className="h-3 w-28 rounded bg-muted" />
            <span className="h-2 w-16 rounded bg-muted/70" />
          </div>
        </div>
        <span className="h-4 w-14 rounded-full bg-muted/70" />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="h-2.5 w-full rounded bg-muted/70" />
        <span className="h-2.5 w-5/6 rounded bg-muted/70" />
        <span className="h-2.5 w-2/3 rounded bg-muted/70" />
      </div>
      <span className="mt-auto h-4 w-20 rounded-full bg-muted/60" />
    </div>
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
    // Last, and only rendered when non-empty (the tab strip hides zero-count
    // tabs) — but the tab has to EXIST or an archived template is invisible
    // except under "All", which is where the 28-day window gets missed.
    { key: "archived", label: "Archived" },
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
              "rounded px-2.5 py-1 text-xs font-medium transition-colors",
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

/** Compact TTL, e.g. `30d` / `12h` / `600s`. */
function formatTtl(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** WhatsApp Manager's own wording for a band, so the surfaces agree. */
function qualityLabel(score: string): string {
  const band = score.toUpperCase();
  return band === "GREEN"
    ? "High quality"
    : band === "YELLOW"
      ? "Medium quality"
      : band === "RED"
        ? "Low quality"
        : band === "UNKNOWN"
          ? "Quality pending"
          : band;
}

/** What the band means for the operator — i.e. what to DO about it. */
function qualityExplanation(score: string): string {
  const band = score.toUpperCase();
  if (band === "GREEN") {
    return "Little to no negative feedback from recipients.";
  }
  if (band === "YELLOW") {
    return "Several recipients gave negative feedback, or read rates are low. Still sending, but it may be paused if this continues.";
  }
  if (band === "RED") {
    return "Repeated negative feedback or low read rates. It still sends, but it is in danger of being paused — rewrite the copy or tighten who receives it.";
  }
  if (band === "UNKNOWN") {
    return "Not enough recipient feedback yet. Every new template starts here.";
  }
  return "Reported by Meta.";
}

/**
 * Meta's template quality band, as a dot beside the status.
 *
 * Deliberately small: quality is a WARNING SIGNAL, not a state — it never
 * changes whether a template can be sent (all four bands send). What it
 * predicts is a PAUSE: quality drives Meta's template pacing and pausing, so a
 * red dot is a template about to stop working, which is worth catching before
 * the status flips.
 *
 * Only shown on approved templates, matching WhatsApp Manager — a rejected
 * template's band is noise. GREEN is shown too (a quiet confirmation), but
 * UNKNOWN is not: "we have no data yet" is the default state of every new
 * template and a dot for it would just be clutter.
 */
function QualityDot({
  score,
  at,
  status,
}: {
  score: string | null;
  at: string | null;
  status: string;
}) {
  if (status !== "approved" || !score) return null;
  const band = score.toUpperCase();
  if (band === "UNKNOWN") return null;
  const tone =
    band === "GREEN"
      ? "bg-success-fg"
      : band === "YELLOW"
        ? "bg-warning-fg"
        : band === "RED"
          ? "bg-destructive"
          : "bg-muted-foreground";
  // Manager's own wording, so the two surfaces agree at a glance.
  const label =
    band === "GREEN"
      ? "High quality"
      : band === "YELLOW"
        ? "Medium quality"
        : band === "RED"
          ? "Low quality — at risk of being paused"
          : band;
  return (
    <span
      className={cn("size-2 shrink-0 rounded-full", tone)}
      // A title attribute can't render a component, so this one date is
      // formatted inline. It's a tooltip, not page content — nothing for
      // hydration to compare.
      title={at ? `${label} (as of ${new Date(at).toLocaleDateString()})` : label}
      aria-label={label}
    />
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "approved"
      ? "border-success-border bg-success-bg text-success-fg"
      : status === "pending"
        ? "border-warning-border bg-warning-bg text-warning-fg"
        : status === "rejected"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : // Archived is a DEADLINE, not a dead end — it reads as a warning
            // because there are 28 days to act, unlike disabled/paused.
            status === "archived"
            ? "border-warning-border bg-warning-bg text-warning-fg"
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
  allTemplates,
  fieldDefinitions,
  deleting,
  deleteError,
  reloading,
  reloadError,
  canManage,
  onClose,
  onDelete,
  unpausing,
  unpauseError,
  onUnpause,
  onBindingsSaved,
  onReload,
}: {
  template: TemplateDto | null;
  /** The workspace's whole catalog — the comparison picker's candidate pool. */
  allTemplates: TemplateDto[];
  fieldDefinitions: ContactFieldDefinition[];
  deleting: boolean;
  deleteError: string | null;
  reloading: boolean;
  reloadError: string | null;
  canManage: boolean;
  onClose: () => void;
  onDelete: () => void;
  unpausing: boolean;
  unpauseError: string | null;
  onUnpause: () => void;
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
                <div className="mt-0.5 flex items-center gap-2 text-2xs text-muted-foreground">
                  <span className="font-mono">{template.language}</span>
                  <span aria-hidden="true">·</span>
                  <CategoryPill category={template.category} />
                  {template.messageSendTtlSeconds != null && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span title="Meta retries delivery for this long before giving up">
                        TTL {formatTtl(template.messageSendTtlSeconds)}
                      </span>
                    </>
                  )}
                  {template.externalId && (
                    <>
                      <span aria-hidden="true">·</span>
                      <code className="rounded bg-muted/60 px-1 py-0.5 text-3xs">
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
                {/* The 28-day rescue window. Meta gives no way back through the
                    API, so the only honest action is a pointer to WhatsApp
                    Manager — with the clock, because it runs out silently. */}
                {template.status === "archived" && (
                  <div className="rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-xs">
                    <span className="font-medium text-warning-fg">
                      Archived after {TEMPLATE_AUTO_ARCHIVE_MONTHS} months without use.
                    </span>{" "}
                    <span className="text-muted-foreground">
                      {(() => {
                        const days = templateDeletionDaysLeft(template.archivedAt);
                        return days === null
                          ? "Meta deletes archived templates permanently after 28 days."
                          : days === 0
                            ? "Meta may delete it permanently at any moment."
                            : `Meta deletes it permanently in about ${days} day${days === 1 ? "" : "s"}.`;
                      })()}{" "}
                      Unarchive it in{" "}
                      <a
                        href="https://business.facebook.com/latest/whatsapp_manager/message_templates"
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline"
                      >
                        WhatsApp Manager
                      </a>{" "}
                      to restore it to its previous status and cancel the deletion.
                      Meta also exposes bulk archive/unarchive endpoints; wiring
                      them here is pending their published request shape.
                    </span>
                  </div>
                )}

                {/* Better than reporting archival after the fact: sending the
                    template even once resets Meta's clock entirely. */}
                {template.status !== "archived" &&
                  (() => {
                    const risk = templateArchivalRisk(template.lastUsedAt);
                    if (!risk?.atRisk) return null;
                    return (
                      <div className="rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-xs">
                        <span className="font-medium text-warning-fg">
                          Nearly inactive for {TEMPLATE_AUTO_ARCHIVE_MONTHS} months.
                        </span>{" "}
                        <span className="text-muted-foreground">
                          Meta auto-archives it in about{" "}
                          {Math.max(0, risk.daysLeft)} day
                          {risk.daysLeft === 1 ? "" : "s"}. Sending it once resets
                          the clock.
                        </span>
                      </div>
                    );
                  })()}

                {/* Advance notice, NOT a state change: Meta bills this template
                    at its current category until the move actually lands. */}
                {template.correctCategory && (
                  <div className="rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-xs">
                    <span className="font-medium text-warning-fg">
                      Category change scheduled.
                    </span>{" "}
                    <span className="text-muted-foreground">
                      Meta will move this template from{" "}
                      <span className="font-medium">{template.category}</span> to{" "}
                      <span className="font-medium">{template.correctCategory}</span>,
                      typically on the first of next month — which changes what it
                      costs to send. You can request a review in WhatsApp Manager
                      before then.
                    </span>
                  </div>
                )}
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

                {/* What a pause actually means, and what happens next. The
                    escalation ladder is the part nobody knows: the third
                    instance doesn't pause, it DISABLES the template. */}
                {template.status === "paused" && (
                  <section>
                    <SectionLabel>Paused</SectionLabel>
                    <div className="mt-2 rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-xs leading-relaxed text-warning-fg">
                      <p>
                        WhatsApp pauses a template when its quality hits{" "}
                        <strong>low</strong>, to protect the numbers that send
                        it. It can&apos;t be sent while paused — the API rejects
                        the attempts, though they aren&apos;t charged and
                        don&apos;t count against your messaging limit. Any
                        campaigns using it have been paused too.
                      </p>
                      <p className="mt-1.5">
                        A quality pause lifts itself after <strong>3 hours</strong>
                        , then <strong>6 hours</strong> on the second instance —
                        and on the <strong>third, Meta disables the template</strong>{" "}
                        instead. A template paused by Template Pacing never lifts
                        on its own; use Unpause for that one.
                      </p>
                      <p className="mt-1.5">
                        Editing the copy re-enters review, so it can&apos;t be
                        sent until it&apos;s approved again — worth it if the
                        content is what&apos;s drawing the negative feedback.
                        Tightening who receives it often matters more.
                      </p>
                    </div>
                  </section>
                )}

                {/* Quality band. Above Performance because it is the ACTIONABLE
                    signal — the daily figures tell you how a template did, this
                    tells you whether it is about to stop working. */}
                {template.status === "approved" &&
                  template.qualityScore &&
                  template.qualityScore.toUpperCase() !== "UNKNOWN" && (
                    <section>
                      <SectionLabel>Quality</SectionLabel>
                      <div className="mt-2 flex items-start gap-2">
                        <QualityDot
                          score={template.qualityScore}
                          at={template.qualityScoreAt}
                          status={template.status}
                        />
                        <div className="min-w-0 text-xs leading-relaxed">
                          <div className="font-medium text-foreground">
                            {qualityLabel(template.qualityScore)}
                          </div>
                          <p className="mt-0.5 text-muted-foreground">
                            {qualityExplanation(template.qualityScore)}
                            {template.qualityScoreAt && (
                              <>
                                {" "}
                                Last updated{" "}
                                <LocalTime iso={template.qualityScoreAt} format="localeDate" />.
                              </>
                            )}
                          </p>
                        </div>
                      </div>
                    </section>
                  )}

                {/* Meta's own figures for this template. Placed under the
                    preview because "is this template working" is the question
                    someone has while looking at it — a separate page would mean
                    navigating away from the thing being asked about. */}
                {template.externalId && (
                  <section>
                    <SectionLabel>Performance</SectionLabel>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      Meta&apos;s own daily figures. Read counts are only reported
                      for about a week, so older days show what was captured at
                      the time.
                    </p>
                    <div className="mt-3">
                      <TemplateInsights templateId={template.id} />
                    </div>
                  </section>
                )}

                {/* Head-to-head. Sits under Performance because "is this one
                    working" naturally leads to "is the other one better" —
                    which is the question a second template exists to answer. */}
                {template.externalId && (
                  <section>
                    <SectionLabel>Compare</SectionLabel>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      Which of two templates customers block less. Meta requires
                      both to be on the same WhatsApp Business Account and each to
                      have been sent at least 1,000 times in the window.
                    </p>
                    <div className="mt-3">
                      <TemplateComparison template={template} candidates={allTemplates} />
                    </div>
                  </section>
                )}

                <section>
                  <SectionLabel>Variable bindings</SectionLabel>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Pull each <code className="rounded bg-muted px-1 text-2xs">{"{{n}}"}</code> from a contact
                    field, or leave it as a manual value the agent fills at
                    broadcast time. Default values cover contacts whose field
                    is empty.
                  </p>
                  <div className="mt-3">
                    {canManage ? (
                      <VariableBindingsEditor
                        templateId={template.id}
                        parameterFormat={template.parameterFormat}
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
                      <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                        You don&apos;t have permission to edit template bindings.
                      </p>
                    )}
                  </div>
                </section>

                {template.status === "rejected" && (
                  <section>
                    <SectionLabel>Rejection details</SectionLabel>
                    <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                      {template.statusReason === "INCORRECT_CATEGORY" ? (
                        <>
                          Meta rejected this template because it disagrees with the
                          category you chose — the content doesn&apos;t match{" "}
                          <span className="font-medium">{template.category}</span>.
                          Resubmit under a different category, or request a review
                          in WhatsApp Manager. Rewriting the copy isn&apos;t
                          necessarily what&apos;s needed here.
                        </>
                      ) : (
                        <>
                          Meta rejected this template
                          {template.statusReason ? (
                            <>
                              {" "}
                              (<code className="font-mono">{template.statusReason}</code>)
                            </>
                          ) : null}
                          . Once fixed, delete this and submit a new one with the
                          corrected content.
                        </>
                      )}
                    </div>
                  </section>
                )}

                <section>
                  <SectionLabel>Components (Meta wire format)</SectionLabel>
                  <pre className="mt-2 max-h-72 overflow-auto rounded-md border border-border bg-muted/30 p-3 text-2xs leading-relaxed">
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
              {unpauseError && (
                <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <span className="wrap-break-word">{unpauseError}</span>
                </div>
              )}
              {reloadError && (
                <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <span className="wrap-break-word">{reloadError}</span>
                </div>
              )}
              <div className="flex items-center justify-between gap-3">
                <span className="text-2xs text-muted-foreground">
                  Last synced <LocalTime iso={template.syncedAt} format="localeString" />
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onReload}
                    disabled={reloading}
                    className="gap-1.5"
                  >
                    {reloading ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="size-3.5" />
                    )}
                    Reload
                  </Button>
                  {/* Unpause. A QUALITY pause lifts itself (3h, then 6h, then
                      Meta disables the template), so this is really for one
                      paused by Template Pacing — those never unpause on their
                      own. Harmless on either, and it also releases the campaigns
                      we parked when the pause arrived. */}
                  {canManage && template.status === "paused" && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={onUnpause}
                      disabled={unpausing}
                      className="gap-1.5"
                    >
                      {unpausing ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Play className="size-3.5" />
                      )}
                      Unpause
                    </Button>
                  )}
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
                  {/* Editing keeps the name and the history, and — unlike
                      delete+recreate — costs no 30-day name lock. Offered only
                      from the states Meta actually accepts an edit from, so the
                      button is never a guaranteed 409. */}
                  {canManage &&
                    ["approved", "rejected", "paused"].includes(template.status) && (
                      <Button asChild variant="outline" size="sm">
                        <Link href={`/templates/${template.id}/edit`} className="gap-1.5">
                          <Pencil className="size-3.5" />
                          Edit
                        </Link>
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
    <div className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
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
      <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
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
