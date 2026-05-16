"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  FileText,
  Loader2,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Users,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ContactFieldDefinition, ContactStage, Tag, TemplateDto } from "@/lib/types";
import type { ContactLabel } from "@/components/contacts/contact-select-dialog";
import type { TemplateComponent } from "@/lib/providers/types";
import type { AudienceGroupDto } from "@/lib/queries";
import {
  findUnknownTokens,
  resolveFieldTokens,
  SAMPLE_CONTACT,
} from "@/lib/field-tokens";
import { parseVariableBindings, type VariableBinding } from "@/lib/template-bindings";

import { AudiencePicker, type AudienceState } from "@/components/broadcasts/audience-picker";
import { RecipientsPreviewDialog } from "@/components/broadcasts/recipients-preview-dialog";
import { FieldTokenPicker } from "@/components/templates/field-token-picker";
import { TokenHighlightInput } from "@/components/templates/token-highlight";

/**
 * New broadcast wizard.
 *
 * One-page form rather than a multi-step navigator — agents see audience,
 * template, and preview all at once and can ping-pong without losing state.
 * Sections collapse to summaries once filled so the active step gets focus.
 *
 *   1. Audience: pick contacts or "all"
 *   2. Template: search + select from the team's approved templates
 *   3. Variables: fill {{N}} placeholders (same for all recipients in v1)
 *   4. Review + Send
 */

type Step = "audience" | "template" | "variables" | "review";

const STEP_ORDER: Step[] = ["audience", "template", "variables", "review"];

export function NewBroadcastForm({
  totalContactCount,
  initialContactLabels,
  tags,
  fieldDefinitions,
  stages,
  groups,
  hasWabaId,
  preselectedContactIds,
  preselectedTagIds,
  preselectedGroupId,
}: {
  totalContactCount: number;
  initialContactLabels: ContactLabel[];
  tags: Tag[];
  fieldDefinitions: ContactFieldDefinition[];
  stages: ContactStage[];
  groups: AudienceGroupDto[];
  hasWabaId: boolean;
  preselectedContactIds: string[];
  preselectedTagIds: string[];
  preselectedGroupId: string | null;
}) {
  const router = useRouter();

  // Pre-fill audience from the URL the agent arrived from. If they landed
  // via "Send template" on the contacts page, that's a list of contact ids.
  // If they clicked "Send broadcast" from a group page, it's a groupId.
  const [audience, setAudience] = useState<AudienceState>(() => {
    if (preselectedGroupId) {
      return {
        mode: "group",
        selectedIds: [],
        selectedTagIds: [],
        selectedGroupId: preselectedGroupId,
      };
    }
    if (preselectedTagIds.length > 0) {
      return {
        mode: "by_tag",
        selectedIds: [],
        selectedTagIds: preselectedTagIds,
        selectedGroupId: null,
      };
    }
    if (preselectedContactIds.length > 0) {
      return {
        mode: "selected",
        selectedIds: preselectedContactIds,
        selectedTagIds: [],
        selectedGroupId: null,
      };
    }
    return {
      mode: "selected",
      selectedIds: [],
      selectedTagIds: [],
      selectedGroupId: null,
    };
  });
  const [templates, setTemplates] = useState<TemplateDto[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templatesSyncing, setTemplatesSyncing] = useState(false);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [templateQuery, setTemplateQuery] = useState("");
  const [bodyVars, setBodyVars] = useState<string[]>([]);
  const [headerVar, setHeaderVar] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  // Live "by tag" recipient count, resolved server-side — the team contact
  // list is no longer loaded into the browser. Debounced; only fetched while
  // tag mode is active.
  const [taggedCount, setTaggedCount] = useState(0);
  const [taggedCountLoading, setTaggedCountLoading] = useState(false);
  const tagKey = audience.selectedTagIds.join(",");
  useEffect(() => {
    if (audience.mode !== "by_tag" || audience.selectedTagIds.length === 0) {
      setTaggedCount(0);
      setTaggedCountLoading(false);
      return;
    }
    let cancelled = false;
    setTaggedCountLoading(true);
    const t = window.setTimeout(async () => {
      try {
        const res = await fetch("/api/contacts/count", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tagIds: audience.selectedTagIds }),
        });
        const data = (await res.json()) as { count?: number };
        if (!cancelled) setTaggedCount(data.count ?? 0);
      } catch {
        if (!cancelled) setTaggedCount(0);
      } finally {
        if (!cancelled) setTaggedCountLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audience.mode, tagKey]);

  // -------------------------------------------------------------------------
  // Template fetch + sync
  // -------------------------------------------------------------------------
  const loadTemplates = useCallback(async () => {
    setTemplatesError(null);
    setTemplatesLoading(true);
    try {
      const res = await fetch("/api/team/whatsapp/templates");
      if (!res.ok) throw new Error(await safeReadError(res));
      const data = (await res.json()) as {
        templates?: TemplateDto[];
        hasWabaId?: boolean;
      };
      setTemplates(data.templates ?? []);
      // Auto-sync from Meta if cache is empty and the WABA is set up — same
      // behavior as the inbox picker so first-time users see something.
      if ((data.templates ?? []).length === 0 && data.hasWabaId) {
        void syncTemplates();
      }
    } catch (err) {
      setTemplatesError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setTemplatesLoading(false);
    }
  }, []);

  const syncTemplates = useCallback(async () => {
    setTemplatesSyncing(true);
    setTemplatesError(null);
    try {
      const res = await fetch("/api/team/whatsapp/templates", { method: "POST" });
      const data = (await res.json()) as {
        templates?: TemplateDto[];
        error?: string;
        detail?: string;
      };
      if (!res.ok) {
        throw new Error(
          [data.error, data.detail].filter(Boolean).join(": ") ||
            `HTTP ${res.status}`,
        );
      }
      setTemplates(data.templates ?? []);
    } catch (err) {
      setTemplatesError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setTemplatesSyncing(false);
    }
  }, []);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------
  const selectedTemplate = useMemo(
    () => templates.find((t) => t.id === selectedTemplateId) ?? null,
    [templates, selectedTemplateId],
  );

  const components = useMemo<TemplateComponent[]>(() => {
    if (!selectedTemplate) return [];
    return Array.isArray(selectedTemplate.components)
      ? (selectedTemplate.components as TemplateComponent[])
      : [];
  }, [selectedTemplate]);

  const headerComp = components.find((c) => c.type === "HEADER");
  const footerComp = components.find((c) => c.type === "FOOTER");
  const buttonsComp = components.find((c) => c.type === "BUTTONS");

  const bodyVarCount = selectedTemplate ? countPlaceholders(selectedTemplate.bodyText) : 0;
  const headerVarCount =
    headerComp?.format === "TEXT" && headerComp.text
      ? countPlaceholders(headerComp.text)
      : 0;

  // Reset variable arrays whenever the chosen template changes. When the
  // template carries bindings, prefill each input with the matching token so
  // the agent sees the personalization upfront and can override.
  useEffect(() => {
    if (!selectedTemplate) {
      setBodyVars(Array.from({ length: bodyVarCount }, () => ""));
      setHeaderVar("");
      return;
    }
    const bindings = parseVariableBindings(selectedTemplate.variableBindings as never);
    setBodyVars(
      Array.from({ length: bodyVarCount }, (_, i) => tokenForBinding(bindings.body[i])),
    );
    setHeaderVar(headerVarCount > 0 ? tokenForBinding(bindings.header) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTemplateId, bodyVarCount, headerVarCount]);

  // Live-count for the "By tag" mode — contacts whose tagIds overlap the
  // selected tag ids. Same set the server will compute at create time, so
  // the agent gets a faithful preview.
  const audienceCount = useMemo(() => {
    if (audience.mode === "all") return totalContactCount;
    if (audience.mode === "selected") return audience.selectedIds.length;
    if (audience.mode === "group") {
      const g = groups.find((x) => x.id === audience.selectedGroupId);
      return g?.memberCount ?? 0;
    }
    return taggedCount;
  }, [audience, groups, totalContactCount, taggedCount]);

  const audienceDone = audienceCount > 0;

  // What "Preview recipients" resolves against. Null for "all" (no point) and
  // for an as-yet-empty selection. Group mode reuses the group dto's snapshot
  // of tag + manual membership.
  const selectedGroup =
    audience.mode === "group"
      ? groups.find((g) => g.id === audience.selectedGroupId) ?? null
      : null;
  const previewPayload: { tagIds: string[]; contactIds: string[] } | null = (() => {
    if (audience.mode === "selected" && audience.selectedIds.length > 0) {
      return { tagIds: [], contactIds: audience.selectedIds };
    }
    if (audience.mode === "by_tag" && audience.selectedTagIds.length > 0) {
      return { tagIds: audience.selectedTagIds, contactIds: [] };
    }
    if (audience.mode === "group" && selectedGroup) {
      return { tagIds: selectedGroup.tagIds, contactIds: selectedGroup.contactIds };
    }
    return null;
  })();
  const previewSubtitle =
    audience.mode === "by_tag"
      ? `${audience.selectedTagIds.length} tag${audience.selectedTagIds.length === 1 ? "" : "s"} · contacts carrying any of them`
      : audience.mode === "group"
        ? `Saved group: ${selectedGroup?.name ?? "—"}`
        : `${audience.selectedIds.length} hand-picked contact${audience.selectedIds.length === 1 ? "" : "s"}`;

  const templateDone = selectedTemplate !== null;
  const variablesDone =
    templateDone &&
    bodyVars.every((v) => v.trim().length > 0) &&
    (headerVarCount === 0 || headerVar.trim().length > 0);
  const readyToSend = audienceDone && templateDone && variablesDone;

  const filteredTemplates = useMemo(() => {
    const q = templateQuery.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.bodyText.toLowerCase().includes(q) ||
        t.language.toLowerCase().includes(q),
    );
  }, [templates, templateQuery]);

  // -------------------------------------------------------------------------
  // Submit
  // -------------------------------------------------------------------------
  async function submit() {
    if (!readyToSend || !selectedTemplate) return;
    setSendError(null);
    setSending(true);
    try {
      const res = await fetch("/api/broadcasts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          templateId: selectedTemplate.id,
          variables: {
            body: bodyVars,
            ...(headerVarCount > 0 ? { header: headerVar } : {}),
          },
          audience:
            audience.mode === "all"
              ? { mode: "all" }
              : audience.mode === "by_tag"
                ? { mode: "by_tag", tagIds: audience.selectedTagIds }
                : audience.mode === "group"
                  ? { mode: "group", groupId: audience.selectedGroupId }
                  : { mode: "selected", contactIds: audience.selectedIds },
        }),
      });
      if (!res.ok) {
        throw new Error(await safeReadError(res));
      }
      const data = (await res.json()) as { broadcastId?: string };
      if (!data.broadcastId) throw new Error("No broadcast id in response");
      router.push(`/broadcasts/${data.broadcastId}`);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Failed to send");
      setSending(false);
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-col gap-1">
        <Link
          href="/broadcasts"
          className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to broadcasts
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">New broadcast</h1>
        <p className="text-sm text-muted-foreground">
          Send a pre-approved WhatsApp template to many recipients in one go.
          Same template + same variable values for everyone.
        </p>
      </header>

      <StepCard
        index={1}
        title="Audience"
        summary={
          audienceDone
            ? audience.mode === "all"
              ? `All ${totalContactCount} contact${totalContactCount === 1 ? "" : "s"}`
              : audience.mode === "by_tag"
                ? `${audienceCount} via ${audience.selectedTagIds.length} tag${audience.selectedTagIds.length === 1 ? "" : "s"}`
                : audience.mode === "group"
                  ? `${groups.find((g) => g.id === audience.selectedGroupId)?.name ?? "group"} · ${audienceCount} member${audienceCount === 1 ? "" : "s"}`
                  : `${audienceCount} recipient${audienceCount === 1 ? "" : "s"}`
            : undefined
        }
        done={audienceDone}
      >
        <AudiencePicker
          tags={tags}
          fieldDefinitions={fieldDefinitions}
          stages={stages}
          groups={groups}
          totalContactCount={totalContactCount}
          taggedRecipientCount={taggedCount}
          taggedRecipientLoading={taggedCountLoading}
          initialContactLabels={initialContactLabels}
          value={audience}
          onChange={setAudience}
        />
      </StepCard>

      <StepCard
        index={2}
        title="Template"
        summary={
          selectedTemplate
            ? `${selectedTemplate.name} · ${selectedTemplate.language}`
            : undefined
        }
        done={templateDone}
      >
        <TemplatePickerInline
          templates={filteredTemplates}
          query={templateQuery}
          onQueryChange={setTemplateQuery}
          loading={templatesLoading}
          syncing={templatesSyncing}
          error={templatesError}
          hasWabaId={hasWabaId}
          selectedId={selectedTemplateId}
          onSelect={setSelectedTemplateId}
          onRefresh={syncTemplates}
        />
      </StepCard>

      {selectedTemplate && (
        <StepCard
          index={3}
          title="Variables"
          summary={
            variablesDone
              ? bodyVarCount + headerVarCount === 0
                ? "No variables"
                : `${bodyVarCount + headerVarCount} value${bodyVarCount + headerVarCount === 1 ? "" : "s"} filled`
              : undefined
          }
          done={variablesDone}
        >
          {bodyVarCount + headerVarCount === 0 ? (
            <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-[12px] text-muted-foreground">
              This template has no variables — it&apos;ll send as-is to every
              recipient.
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                Type a value or insert a{" "}
                <code className="rounded bg-muted px-1 text-[10.5px]">$var.contact.field</code>{" "}
                token to fill each variable per recipient.
              </p>
              {headerVarCount > 0 && (
                <VarField
                  label="Header {{1}}"
                  value={headerVar}
                  onChange={setHeaderVar}
                  fieldDefinitions={fieldDefinitions}
                />
              )}
              {bodyVars.map((v, i) => (
                <VarField
                  key={i}
                  label={`Body {{${i + 1}}}`}
                  value={v}
                  onChange={(next) => {
                    setBodyVars((cur) => {
                      const copy = cur.slice();
                      copy[i] = next;
                      return copy;
                    });
                  }}
                  fieldDefinitions={fieldDefinitions}
                />
              ))}
            </div>
          )}

          <div className="mt-5">
            <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              <span>Preview</span>
              <span className="h-px flex-1 bg-border" />
            </div>
            <PreviewBubble
              headerComp={headerComp}
              headerValue={resolveFieldTokens(headerVar, SAMPLE_CONTACT)}
              bodyText={selectedTemplate.bodyText}
              bodyVars={bodyVars.map((v) => resolveFieldTokens(v, SAMPLE_CONTACT))}
              footerComp={footerComp}
              buttonsComp={buttonsComp}
            />
          </div>
        </StepCard>
      )}

      <div className="sticky bottom-0 -mx-6 mt-2 border-t border-border bg-background/95 px-6 py-3 backdrop-blur">
        {sendError && (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span className="wrap-break-word">{sendError}</span>
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 text-[12px] text-muted-foreground">
            {readyToSend ? (
              <span className="inline-flex items-center gap-1.5">
                <Send className="size-3.5" />
                Ready to send to{" "}
                <span className="font-medium text-foreground tabular-nums">
                  {audienceCount}
                </span>{" "}
                recipient{audienceCount === 1 ? "" : "s"}.
              </span>
            ) : (
              <span>Complete every step to enable sending.</span>
            )}
            {previewPayload && audienceCount > 0 && (
              <button
                type="button"
                onClick={() => setPreviewOpen(true)}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-foreground hover:bg-accent"
              >
                <Users className="size-3.5" />
                Preview recipients
              </button>
            )}
          </div>
          <Button
            type="button"
            onClick={submit}
            disabled={!readyToSend || sending}
            className="gap-1.5"
          >
            {sending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
            {sending ? "Sending…" : "Send broadcast"}
          </Button>
        </div>
      </div>

      <RecipientsPreviewDialog
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        payload={previewPayload}
        title="Broadcast recipients"
        subtitle={previewSubtitle}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step card — a numbered section with collapse-to-summary behavior.
// ---------------------------------------------------------------------------

function StepCard({
  index,
  title,
  summary,
  done,
  children,
}: {
  index: number;
  title: string;
  summary?: string;
  done?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <header className="flex items-center gap-3 border-b border-border bg-muted/30 px-4 py-3">
        <div
          className={cn(
            "inline-flex size-7 items-center justify-center rounded-full text-xs font-semibold",
            done
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
              : "bg-primary/10 text-primary",
          )}
        >
          {done ? <Check className="size-3.5" /> : index}
        </div>
        <div className="flex-1">
          <div className="text-sm font-semibold">{title}</div>
          {summary && (
            <div className="text-[11px] text-muted-foreground">{summary}</div>
          )}
        </div>
      </header>
      <div className="px-4 py-4">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Inline template list — same data shape as the inbox picker but rendered
// flat (no popover) because this whole page is the picker.
// ---------------------------------------------------------------------------

function TemplatePickerInline({
  templates,
  query,
  onQueryChange,
  loading,
  syncing,
  error,
  hasWabaId,
  selectedId,
  onSelect,
  onRefresh,
}: {
  templates: TemplateDto[];
  query: string;
  onQueryChange: (q: string) => void;
  loading: boolean;
  syncing: boolean;
  error: string | null;
  hasWabaId: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
}) {
  if (!hasWabaId) {
    return (
      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-4 text-[12px]">
        <div className="font-medium text-amber-700 dark:text-amber-300">
          WhatsApp Business Account ID needed
        </div>
        <p className="mt-1 leading-relaxed text-muted-foreground">
          Templates live on your WABA. Add your ID in{" "}
          <Link href="/settings/whatsapp" className="text-primary hover:underline">
            Settings → WhatsApp
          </Link>{" "}
          to load and broadcast templates.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search templates…"
            className="h-9 pl-8"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={syncing}
          className="h-9 gap-1.5 text-xs"
        >
          {syncing ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          Refresh
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          <span>Loading templates…</span>
        </div>
      ) : templates.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-6 text-center text-[12px] text-muted-foreground">
          {query.length > 0
            ? `No templates match "${query}".`
            : "No templates yet. Approve some in WhatsApp Manager and click Refresh."}
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border bg-background">
          {templates.map((t) => {
            const sendable = t.status === "approved";
            const selected = t.id === selectedId;
            return (
              <li key={t.id}>
                <button
                  type="button"
                  disabled={!sendable}
                  onClick={() => onSelect(t.id)}
                  className={cn(
                    "group flex w-full cursor-pointer items-start gap-3 px-3 py-2.5 text-left transition-colors",
                    "hover:bg-accent/50 focus:bg-accent/50 focus:outline-hidden",
                    selected && "bg-primary/5 hover:bg-primary/5",
                    !sendable && "cursor-not-allowed opacity-60 hover:bg-transparent",
                  )}
                >
                  <div
                    className={cn(
                      "mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md",
                      selected ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary",
                    )}
                  >
                    <FileText className="size-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">{t.name}</span>
                      <CategoryPill category={t.category} />
                      <span className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {t.language}
                      </span>
                      {!sendable && (
                        <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase text-amber-700 dark:text-amber-300">
                          {t.status}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[12px] text-muted-foreground">
                      {t.bodyText || "—"}
                    </p>
                  </div>
                  {selected ? (
                    <Check className="mt-2 size-4 shrink-0 text-primary" />
                  ) : sendable ? (
                    <ChevronRight className="mt-2 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small inline helpers
// ---------------------------------------------------------------------------

function VarField({
  label,
  value,
  onChange,
  fieldDefinitions,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  fieldDefinitions: ContactFieldDefinition[];
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Splice the token at the current cursor position. Falls back to appending
  // when the input isn't focused — same pattern the body editor on the
  // create-template form uses.
  const insertToken = useCallback(
    (token: string) => {
      const el = inputRef.current;
      if (!el || el.selectionStart === null) {
        onChange(value + token);
        return;
      }
      const start = el.selectionStart;
      const end = el.selectionEnd ?? start;
      onChange(value.slice(0, start) + token + value.slice(end));
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + token.length;
        el.setSelectionRange(pos, pos);
      });
    },
    [value, onChange],
  );

  const unknown = useMemo(
    () => findUnknownTokens(value, fieldDefinitions),
    [value, fieldDefinitions],
  );
  const preview = useMemo(
    () => resolveFieldTokens(value, SAMPLE_CONTACT),
    [value],
  );
  const hasToken = /\$var\.contact\./.test(value);

  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[11px] font-medium text-foreground">{label}</span>
      <div className="flex items-center gap-1.5">
        <TokenHighlightInput
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Type a value or insert $var.contact.name"
          fieldDefinitions={fieldDefinitions}
        />
        <FieldTokenPicker
          fieldDefinitions={fieldDefinitions}
          onInsert={insertToken}
          hint="Tokens are replaced with each recipient's contact data at send time."
        />
      </div>
      {hasToken && (
        <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
          <span className="font-medium">Sample:</span>
          <span className="truncate font-mono text-foreground">
            {preview || <span className="text-muted-foreground italic">(empty)</span>}
          </span>
        </div>
      )}
      {unknown.length > 0 && (
        <div className="mt-0.5 text-[10.5px] text-amber-600 dark:text-amber-400">
          Unknown token{unknown.length === 1 ? "" : "s"}:{" "}
          {unknown.join(", ")} — these will resolve to empty for every recipient.
        </div>
      )}
    </label>
  );
}

/**
 * Pick the natural token for a template binding so a newly-selected template
 * with bindings shows a fully wired-up form on first paint.
 *
 *   binding.source = contact_field.name   → "$var.contact.name"
 *   binding.source = contact_field.phoneNumber → "$var.contact.phone"
 *   binding.source = contact_custom_field.X  → "$var.contact.X"
 *   binding.source = manual / no binding → ""
 *
 * The phone-number alias is the one quirk: our schema field is camelCase
 * `phoneNumber` but the token reads better as `$var.contact.phone`.
 */
function tokenForBinding(binding: VariableBinding | undefined): string {
  if (!binding) return "";
  if (binding.source.kind === "manual") {
    return binding.defaultValue ?? "";
  }
  if (binding.source.kind === "contact_field") {
    const f = binding.source.field;
    const token = f === "phoneNumber" ? "phone" : f;
    return `$var.contact.${token}`;
  }
  if (binding.source.kind === "contact_custom_field") {
    return `$var.contact.${binding.source.key}`;
  }
  return "";
}

function PreviewBubble({
  headerComp,
  headerValue,
  bodyText,
  bodyVars,
  footerComp,
  buttonsComp,
}: {
  headerComp: TemplateComponent | undefined;
  headerValue: string;
  bodyText: string;
  bodyVars: string[];
  footerComp: TemplateComponent | undefined;
  buttonsComp: TemplateComponent | undefined;
}) {
  const renderedBody = renderPlaceholders(bodyText, bodyVars);
  const renderedHeader =
    headerComp?.format === "TEXT" && headerComp.text
      ? renderPlaceholders(headerComp.text, [headerValue])
      : null;
  return (
    <div className="rounded-lg border border-border bg-card p-3 shadow-xs">
      <div className="rounded-md bg-emerald-500/5 p-3 ring-1 ring-emerald-500/10">
        {headerComp?.format === "TEXT" && renderedHeader && (
          <div className="mb-1 text-sm font-semibold text-foreground">{renderedHeader}</div>
        )}
        {headerComp && headerComp.format !== "TEXT" && (
          <div className="mb-2 flex h-20 items-center justify-center rounded-md border border-dashed border-emerald-500/30 bg-emerald-500/5 text-[11px] text-muted-foreground">
            {headerComp.format ?? "MEDIA"} header
          </div>
        )}
        <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
          {renderedBody || <span className="text-muted-foreground">No body</span>}
        </div>
        {footerComp?.text && (
          <div className="mt-2 text-[11px] text-muted-foreground">{footerComp.text}</div>
        )}
      </div>
      {buttonsComp?.buttons && buttonsComp.buttons.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {buttonsComp.buttons.map((b, i) => (
            <div
              key={i}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-center text-[12px] font-medium text-primary"
            >
              {b.text}
            </div>
          ))}
        </div>
      )}
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
        "rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        tone,
      )}
    >
      {category}
    </span>
  );
}

function countPlaceholders(text: string): number {
  let max = 0;
  const re = /\{\{(\d+)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

function renderPlaceholders(text: string, vars: string[]): string {
  return text.replace(/\{\{(\d+)\}\}/g, (_match, idxStr) => {
    const idx = Number(idxStr) - 1;
    const v = vars[idx];
    return v && v.length > 0 ? v : `{{${idxStr}}}`;
  });
}

async function safeReadError(res: Response): Promise<string> {
  try {
    const json = (await res.json()) as { error?: string; detail?: string };
    if (json.detail) return `${json.error ?? "error"}: ${json.detail}`;
    return json.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}
