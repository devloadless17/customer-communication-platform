"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { AnimatePresence, motion, MotionConfig } from "framer-motion";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  History,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  RotateCw,
  Save,
  Send,
  Trash2,
  Webhook,
  XCircle,
} from "lucide-react";

import { LocalTime } from "@/components/local-time";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { getClientSocket } from "@/lib/socket-client";
import { toast } from "@/lib/toast";
import { apiFetch } from "@/lib/api/client-fetch";

interface Webhook {
  id: string;
  name: string;
  url: string;
  eventTypes: string[];
  enabled: boolean;
  consecutiveFailures: number;
  createdAt: string;
  lastDeliveredAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  /** Audit columns set when the circuit breaker tripped — null on manual disable. */
  disabledAt: string | null;
  disabledReason: string | null;
}

interface EventGroup {
  group: string;
  events: { type: string; label: string; description: string }[];
}

interface Props {
  initialWebhooks: Webhook[];
  eventGroups: EventGroup[];
}

interface RevealedSecret {
  webhookId: string;
  secret: string;
  // Tag the banner so the create vs. rotate flows can label themselves correctly.
  flow: "created" | "rotated";
}

export function OutboundWebhooksManager({ initialWebhooks, eventGroups }: Props) {
  const [webhooks, setWebhooks] = useState<Webhook[]>(initialWebhooks);
  // Sync from SSR (router.refresh from useCatalogSync) so teammate edits
  // show up without manual refresh.
  useEffect(() => {
    setWebhooks(initialWebhooks);
  }, [initialWebhooks]);
  // Single submit flag — only one form (create OR edit) is ever open at a time
  // because opening one closes the other.
  const [submitting, setSubmitting] = useState(false);
  const [revealed, setRevealed] = useState<RevealedSecret | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  // Webhook currently being edited inline (its row is swapped for the form).
  const [editingId, setEditingId] = useState<string | null>(null);
  // Deliveries drill-down. `deliveriesFor` stays set during the sheet's exit
  // animation; `deliveriesOpen` drives the slide.
  const [deliveriesFor, setDeliveriesFor] = useState<Webhook | null>(null);
  const [deliveriesOpen, setDeliveriesOpen] = useState(false);
  const { confirm, confirmDialog } = useConfirm();

  // type → human label, so rows can show what a webhook is subscribed to in
  // plain language ("Message received") with the raw code as a hover title.
  const eventLabel = useMemo(
    () =>
      new Map(eventGroups.flatMap((g) => g.events.map((e) => [e.type, e.label] as const))),
    [eventGroups],
  );

  // Listen for circuit-breaker trips AND recoveries. The worker publishes
  // `webhook:subscription_disabled` on auto-disable and the symmetric
  // `webhook:subscription_recovered` once a previously-failing endpoint comes
  // back and the breaker re-enables it. We reflect BOTH live so the admin sees
  // the badge flip (disabled ↔ active) without a manual reload — previously the
  // recovered frame had no consumer, so a self-healed webhook kept showing
  // "Auto-disabled" until the next refresh.
  useEffect(() => {
    const socket = getClientSocket();
    function onDisabled(payload: { webhookId: string; reason: string }) {
      setWebhooks((prev) =>
        prev.map((w) =>
          w.id === payload.webhookId
            ? {
                ...w,
                enabled: false,
                disabledAt: new Date().toISOString(),
                disabledReason: payload.reason,
              }
            : w,
        ),
      );
      const target = webhooks.find((w) => w.id === payload.webhookId);
      toast.error(
        target ? `Webhook "${target.name}" was auto-disabled` : "A webhook was auto-disabled",
        { description: payload.reason },
      );
    }
    function onRecovered(payload: { webhookId: string }) {
      setWebhooks((prev) =>
        prev.map((w) =>
          w.id === payload.webhookId
            ? { ...w, enabled: true, disabledAt: null, disabledReason: null }
            : w,
        ),
      );
      const target = webhooks.find((w) => w.id === payload.webhookId);
      toast.success(
        target ? `Webhook "${target.name}" recovered` : "A webhook recovered",
        { description: "The endpoint is responding again — deliveries resumed." },
      );
    }
    socket.on("webhook:subscription_disabled", onDisabled);
    socket.on("webhook:subscription_recovered", onRecovered);
    return () => {
      socket.off("webhook:subscription_disabled", onDisabled);
      socket.off("webhook:subscription_recovered", onRecovered);
    };
  }, [webhooks]);

  return (
    <div className="flex flex-col gap-6">
      {/* Section header */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">Your webhooks</h3>
          <p className="text-xs text-muted-foreground">
            {webhooks.length === 0
              ? "Send HMAC-signed events to your own endpoints."
              : `${webhooks.length} endpoint${webhooks.length === 1 ? "" : "s"} receiving events.`}
          </p>
        </div>
        {webhooks.length > 0 && !showCreate && !editingId && (
          <Button
            onClick={() => {
              setEditingId(null);
              setShowCreate(true);
            }}
            className="shrink-0"
          >
            <Plus className="size-4" />
            New webhook
          </Button>
        )}
      </div>

      {/* Create form */}
      {showCreate && (
        <WebhookForm
          eventGroups={eventGroups}
          onCancel={() => setShowCreate(false)}
          onCreated={(created, secret) => {
            setWebhooks((prev) => [created, ...prev]);
            setRevealed({ webhookId: created.id, secret, flow: "created" });
            setShowCreate(false);
          }}
          submitting={submitting}
          setSubmitting={setSubmitting}
        />
      )}

      {/* Secret reveal banner */}
      {revealed && (
        <SecretBanner
          secret={revealed.secret}
          flow={revealed.flow}
          onDismiss={() => setRevealed(null)}
        />
      )}

      {/* Empty state OR the list */}
      {webhooks.length === 0 && !showCreate ? (
        <EmptyState
          onCreate={() => {
            setEditingId(null);
            setShowCreate(true);
          }}
        />
      ) : webhooks.length > 0 ? (
        <MotionConfig reducedMotion="user">
          <div className="overflow-hidden rounded-lg border border-border">
            <AnimatePresence initial={false}>
              {webhooks.map((w) =>
                editingId === w.id ? (
                  <motion.div
                    key={w.id}
                    layout
                    className="border-b border-border p-3 last:border-b-0"
                  >
                    <WebhookForm
                      eventGroups={eventGroups}
                      initial={w}
                      onCancel={() => setEditingId(null)}
                      onUpdated={(updated) => {
                        setWebhooks((prev) =>
                          prev.map((p) => (p.id === updated.id ? updated : p)),
                        );
                        setEditingId(null);
                        toast.success(`Updated "${updated.name}"`);
                      }}
                      submitting={submitting}
                      setSubmitting={setSubmitting}
                    />
                  </motion.div>
                ) : (
                  <motion.div
                    key={w.id}
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="border-b border-border last:border-b-0"
                  >
                    <WebhookRow
                      webhook={w}
                      eventLabel={eventLabel}
                      onViewDeliveries={() => {
                        setDeliveriesFor(w);
                        setDeliveriesOpen(true);
                      }}
                      onEdit={() => {
                        setShowCreate(false);
                        setEditingId(w.id);
                      }}
                      onDelete={async () => {
                        const ok = await confirm({
                          title: `Delete "${w.name}"?`,
                          description:
                            "Deliveries are dropped immediately. The delivery history for this webhook is removed too.",
                          confirmLabel: "Delete",
                          destructive: true,
                        });
                        if (!ok) return;
                        const res = await apiFetch(`/api/team/outbound-webhooks/${w.id}`, {
                          method: "DELETE",
                        });
                        if (!res.ok) {
                          toast.error("Delete failed", { description: `HTTP ${res.status}` });
                          return;
                        }
                        setWebhooks((prev) => prev.filter((p) => p.id !== w.id));
                        toast.success(`Deleted "${w.name}"`);
                      }}
                      onRotate={async () => {
                        const ok = await confirm({
                          title: `Rotate secret for "${w.name}"?`,
                          description:
                            "Update your receiver's signature verifier to the new secret. In-flight deliveries pick up the new secret on their next attempt.",
                          confirmLabel: "Rotate",
                        });
                        if (!ok) return;
                        const res = await apiFetch(
                          `/api/team/outbound-webhooks/${w.id}/rotate-secret`,
                          { method: "POST" },
                        );
                        if (!res.ok) {
                          toast.error("Rotate failed", { description: `HTTP ${res.status}` });
                          return;
                        }
                        const json = (await res.json()) as { secret: string };
                        setRevealed({ webhookId: w.id, secret: json.secret, flow: "rotated" });
                        toast.success("Secret rotated");
                      }}
                      onTest={async () => {
                        const res = await apiFetch(`/api/team/outbound-webhooks/${w.id}/test`, {
                          method: "POST",
                        });
                        if (!res.ok) {
                          toast.error("Test failed", { description: `HTTP ${res.status}` });
                          return;
                        }
                        toast.success("Test delivery queued", {
                          description:
                            "Check your receiver — the synthetic test event should land shortly.",
                        });
                      }}
                      onToggleEnabled={async () => {
                        const res = await apiFetch(`/api/team/outbound-webhooks/${w.id}`, {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ enabled: !w.enabled }),
                        });
                        if (!res.ok) {
                          toast.error("Toggle failed", { description: `HTTP ${res.status}` });
                          return;
                        }
                        const json = (await res.json()) as { webhook: Webhook };
                        setWebhooks((prev) =>
                          prev.map((p) => (p.id === w.id ? json.webhook : p)),
                        );
                      }}
                    />
                  </motion.div>
                ),
              )}
            </AnimatePresence>
          </div>
        </MotionConfig>
      ) : null}

      {/* HMAC verification reference — kept at the bottom; it's docs, not a
          primary action, so it no longer sits between create and the list. */}
      <SignatureVerificationGuide />

      {deliveriesFor && (
        <DeliveriesSheet
          webhook={deliveriesFor}
          eventLabel={eventLabel}
          open={deliveriesOpen}
          onOpenChange={setDeliveriesOpen}
        />
      )}

      {confirmDialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / edit form — `initial` present = edit mode (PATCH, no secret reveal);
// absent = create mode (POST, reveals the signing secret once via onCreated).
// ---------------------------------------------------------------------------

function WebhookForm({
  eventGroups,
  initial,
  onCancel,
  onCreated,
  onUpdated,
  submitting,
  setSubmitting,
}: {
  eventGroups: EventGroup[];
  initial?: Webhook;
  onCancel: () => void;
  onCreated?: (webhook: Webhook, secret: string) => void;
  onUpdated?: (webhook: Webhook) => void;
  submitting: boolean;
  setSubmitting: (v: boolean) => void;
}) {
  const editing = initial != null;
  const [name, setName] = useState(initial?.name ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initial?.eventTypes ?? []),
  );
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const urlId = useId();
  const urlHintId = useId();
  const errorId = useId();

  function toggleEvent(type: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("name required");
    if (!url.trim()) return setError("url required");
    if (selected.size === 0) return setError("pick at least one event");

    setSubmitting(true);
    try {
      const body = JSON.stringify({
        name: name.trim(),
        url: url.trim(),
        eventTypes: Array.from(selected),
      });

      if (editing) {
        // Edit reuses the existing PATCH endpoint. The secret is never
        // touched here (rotate is a separate action), so nothing is revealed.
        const res = await apiFetch(`/api/team/outbound-webhooks/${initial.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body,
        });
        const json = (await res.json()) as { webhook?: Webhook; error?: string };
        if (!res.ok || !json.webhook) {
          setError(json.error ?? `error ${res.status}`);
          return;
        }
        onUpdated?.(json.webhook);
        return;
      }

      const res = await apiFetch("/api/team/outbound-webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const json = (await res.json()) as {
        id?: string;
        secret?: string;
        error?: string;
        issues?: unknown;
      } & Partial<Webhook>;
      if (!res.ok || !json.id || !json.secret) {
        setError(json.error ?? `error ${res.status}`);
        return;
      }
      onCreated?.(
        {
          id: json.id,
          name: json.name ?? name.trim(),
          url: json.url ?? url.trim(),
          eventTypes: json.eventTypes ?? Array.from(selected),
          enabled: json.enabled ?? true,
          consecutiveFailures: json.consecutiveFailures ?? 0,
          createdAt: json.createdAt ?? new Date().toISOString(),
          lastDeliveredAt: null,
          lastErrorAt: null,
          lastErrorMessage: null,
          disabledAt: null,
          disabledReason: null,
        },
        json.secret,
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-md border border-border bg-card p-4"
    >
      <div className="flex flex-col gap-2">
        <label htmlFor={nameId} className="text-xs font-medium">
          Name
        </label>
        <Input
          id={nameId}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="n8n CRM sync"
          maxLength={80}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          required
        />
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor={urlId} className="text-xs font-medium">
          URL
        </label>
        <Input
          id={urlId}
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://your-n8n.example.com/webhook/abcd"
          aria-describedby={error ? `${urlHintId} ${errorId}` : urlHintId}
          aria-invalid={error ? true : undefined}
          required
        />
        <p id={urlHintId} className="text-2xs text-muted-foreground">
          We'll POST a JSON envelope here with an{" "}
          <code className="font-mono">X-CCP-Signature</code> header.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <label className="text-xs font-medium">Events</label>
        <div className="flex flex-col gap-3">
          {eventGroups.map((g) => (
            <div key={g.group}>
              <div className="mb-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                {g.group}
              </div>
              <div className="flex flex-col gap-1">
                {g.events.map((evt) => (
                  <label
                    key={evt.type}
                    className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent/40"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(evt.type)}
                      onChange={() => toggleEvent(evt.type)}
                      className="mt-0.5"
                    />
                    <span className="flex-1">
                      <span className="font-medium">{evt.label}</span>
                      <span className="ml-1.5 font-mono text-3xs text-muted-foreground">
                        {evt.type}
                      </span>
                      <div className="text-2xs text-muted-foreground">
                        {evt.description}
                      </div>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : editing ? (
            <Save className="size-4" />
          ) : (
            <Plus className="size-4" />
          )}
          {editing ? "Save changes" : "Create webhook"}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Secret banner — shown once on create / rotate
// ---------------------------------------------------------------------------

function SecretBanner({
  secret,
  flow,
  onDismiss,
}: {
  secret: string;
  flow: "created" | "rotated";
  onDismiss: () => void;
}) {
  function copy() {
    void navigator.clipboard.writeText(secret).then(
      () => toast.success("Copied to clipboard"),
      () => toast.error("Couldn't access clipboard"),
    );
  }
  return (
    <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-4">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            {flow === "created" ? "Copy your signing secret now" : "New signing secret"}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            This is the only time the secret will be displayed. Store it in your
            receiver's signature verifier; we keep only an encrypted copy.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="block min-w-0 flex-1 truncate rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs">
              {secret}
            </code>
            <Button type="button" size="sm" variant="outline" onClick={copy}>
              <Copy className="size-3.5" />
              Copy
            </Button>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="mt-2 text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-webhook row
// ---------------------------------------------------------------------------

function WebhookRow({
  webhook,
  eventLabel,
  onViewDeliveries,
  onEdit,
  onDelete,
  onRotate,
  onTest,
  onToggleEnabled,
}: {
  webhook: Webhook;
  eventLabel: Map<string, string>;
  onViewDeliveries: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onRotate: () => void;
  onTest: () => void;
  onToggleEnabled: () => void;
}) {
  const host = safeHost(webhook.url);
  // `disabledAt` is set ONLY by the circuit breaker; an admin's manual toggle
  // leaves it null — so it cleanly distinguishes auto-disable from a manual one.
  const tripped = !webhook.enabled && webhook.disabledAt !== null;
  const hasError = webhook.enabled && webhook.lastErrorAt != null;
  const dotClass = tripped
    ? "bg-destructive"
    : !webhook.enabled
      ? "bg-muted-foreground/40"
      : hasError
        ? "bg-amber-500"
        : "bg-emerald-500";
  const statusTitle = tripped
    ? `Auto-disabled${webhook.disabledReason ? ` — ${webhook.disabledReason}` : ""}`
    : !webhook.enabled
      ? "Disabled"
      : hasError
        ? "Active · recent delivery error"
        : "Active";

  const MAX_CHIPS = 3;
  const shownEvents = webhook.eventTypes.slice(0, MAX_CHIPS);
  const extra = webhook.eventTypes.length - shownEvents.length;

  // The whole row opens the deliveries drill-down (the common "what happened?"
  // action). Edit / test / rotate / enable / delete live in the overflow menu
  // so the row reads cleanly instead of carrying six buttons.
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onViewDeliveries}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onViewDeliveries();
        }
      }}
      title="View deliveries"
      className="group flex cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-hidden"
    >
      {/* Status indicator */}
      <span className="relative flex size-2.5 shrink-0" aria-label={statusTitle} title={statusTitle}>
        <span className={`size-2.5 rounded-full ${dotClass}`} />
        {webhook.enabled && !hasError && (
          <span
            className={`absolute inset-0 animate-ping rounded-full ${dotClass} opacity-60 motion-reduce:hidden`}
          />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{webhook.name}</span>
          {tripped ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-3xs font-medium uppercase tracking-wide text-destructive">
              <AlertTriangle className="size-3" /> auto-disabled
            </span>
          ) : !webhook.enabled ? (
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-3xs font-medium uppercase tracking-wide text-muted-foreground">
              disabled
            </span>
          ) : null}
        </div>

        <code className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
          {host}
        </code>

        {/* Subscribed events (first few + overflow count) — at-a-glance "what
            is this for" without opening edit. */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {webhook.eventTypes.length === 0 ? (
            <span className="text-2xs text-muted-foreground">no events</span>
          ) : (
            <>
              {shownEvents.map((t) => (
                <span
                  key={t}
                  title={t}
                  className="rounded-full bg-muted px-2 py-0.5 text-3xs text-muted-foreground"
                >
                  {eventLabel.get(t) ?? t}
                </span>
              ))}
              {extra > 0 && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-3xs text-muted-foreground">
                  +{extra}
                </span>
              )}
            </>
          )}
        </div>

        <div className="mt-1 text-2xs text-muted-foreground">
          {hasError ? (
            <span
              className="inline-flex items-center gap-1 text-destructive"
              title={webhook.lastErrorMessage ?? undefined}
            >
              <XCircle className="size-3" /> Last error{" "}
              <LocalTime iso={webhook.lastErrorAt!} format="localeString" />
            </span>
          ) : webhook.lastDeliveredAt ? (
            <span className="inline-flex items-center gap-1">
              <CheckCircle2 className="size-3 text-emerald-600" /> Last delivered{" "}
              <LocalTime iso={webhook.lastDeliveredAt} format="localeString" />
            </span>
          ) : (
            <span>No deliveries yet</span>
          )}
        </div>
      </div>

      {/* Click-affordance hint + actions overflow */}
      <ChevronRight className="size-4 shrink-0 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground" />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="shrink-0"
            aria-label="Webhook actions"
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-44"
          onClick={(e) => e.stopPropagation()}
        >
          <DropdownMenuItem onSelect={onViewDeliveries}>
            <History className="size-3.5" /> View deliveries
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil className="size-3.5" /> Edit
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onTest}>
            <Send className="size-3.5" /> Send test
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onRotate}>
            <RotateCw className="size-3.5" /> Rotate secret
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onToggleEnabled}>
            <Power className="size-3.5" /> {webhook.enabled ? "Disable" : "Enable"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={onDelete}
            className="text-destructive focus:bg-destructive/10 focus:text-destructive"
          >
            <Trash2 className="size-3.5" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Polished empty state — first-run guidance + the primary CTA. */
function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-muted/20 px-6 py-12 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Webhook className="size-5" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">No webhooks yet</p>
        <p className="mx-auto max-w-sm text-xs leading-relaxed text-muted-foreground">
          Create a webhook to receive HMAC-signed POST deliveries whenever events
          happen in this workspace — new messages, status changes, contact updates and more.
        </p>
      </div>
      <Button onClick={onCreate} className="mt-1">
        <Plus className="size-4" /> Create your first webhook
      </Button>
    </div>
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).host + new URL(url).pathname;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Deliveries drill-down — "what has this webhook actually sent?". Pulls the
// recent delivery log (newest first, cursor-paginated), shows status + timing
// per attempt, and expands to the exact JSON payload we POSTed plus the
// receiver's response / error. Backed by GET /:id/deliveries.
// ---------------------------------------------------------------------------

interface Delivery {
  id: string;
  eventType: string;
  attemptCount: number;
  responseStatus: number | null;
  responseBody: string | null;
  payload: unknown;
  deliveredAt: string | null;
  failedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
}

function deliveryState(d: Delivery): {
  label: string;
  tone: "ok" | "fail" | "pending";
} {
  if (d.deliveredAt) {
    return {
      label: d.responseStatus ? `delivered · ${d.responseStatus}` : "delivered",
      tone: "ok",
    };
  }
  if (d.failedAt || d.errorMessage || (d.responseStatus != null && d.responseStatus >= 400)) {
    return {
      label: d.responseStatus ? `failed · ${d.responseStatus}` : "failed",
      tone: "fail",
    };
  }
  // Enqueued but neither delivered nor failed yet (in-flight / retrying).
  return { label: "pending", tone: "pending" };
}

function DeliveriesSheet({
  webhook,
  eventLabel,
  open,
  onOpenChange,
}: {
  webhook: Webhook;
  eventLabel: Map<string, string>;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [items, setItems] = useState<Delivery[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({ limit: "25" });
        if (cursor) qs.set("cursor", cursor);
        const res = await apiFetch(
          `/api/team/outbound-webhooks/${webhook.id}/deliveries?${qs.toString()}`,
        );
        if (!res.ok) {
          setError(`HTTP ${res.status}`);
          return;
        }
        const json = (await res.json()) as {
          items: Delivery[];
          nextCursor: string | null;
        };
        // cursor present = "load older" → append; absent = fresh load → replace.
        setItems((prev) => (cursor ? [...prev, ...json.items] : json.items));
        setNextCursor(json.nextCursor);
      } catch {
        setError("Couldn't load deliveries");
      } finally {
        setLoading(false);
      }
    },
    [webhook.id],
  );

  // (Re)load from scratch each time the sheet opens.
  useEffect(() => {
    if (!open) return;
    setItems([]);
    setNextCursor(null);
    setExpanded(null);
    void load();
  }, [open, load]);

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      side="right"
      contentClassName="w-full max-w-2xl"
    >
      <div className="flex h-full flex-col">
        <div className="shrink-0 border-b border-border px-4 py-3 pr-12">
          <div className="text-sm font-medium">Deliveries</div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {webhook.name} · <code className="font-mono">{safeHost(webhook.url)}</code>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void load()}
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              Refresh
            </Button>
            <span className="text-2xs text-muted-foreground">
              newest first · 25 per page
            </span>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
          {!error && items.length === 0 && !loading && (
            <div className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground">
              No deliveries yet. Fire a test or wait for a subscribed event.
            </div>
          )}
          {items.length > 0 && (
            <div className="flex flex-col divide-y divide-border rounded-md border border-border">
              {items.map((d) => (
                <DeliveryRow
                  key={d.id}
                  delivery={d}
                  eventLabel={eventLabel}
                  open={expanded === d.id}
                  onToggle={() => setExpanded((cur) => (cur === d.id ? null : d.id))}
                />
              ))}
            </div>
          )}
          {nextCursor && (
            <div className="mt-3 flex justify-center">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => void load(nextCursor)}
                disabled={loading}
              >
                {loading && <Loader2 className="size-3.5 animate-spin" />}
                Load older
              </Button>
            </div>
          )}
        </div>
      </div>
    </Sheet>
  );
}

function DeliveryRow({
  delivery: d,
  eventLabel,
  open,
  onToggle,
}: {
  delivery: Delivery;
  eventLabel: Map<string, string>;
  open: boolean;
  onToggle: () => void;
}) {
  const state = deliveryState(d);
  const toneClass =
    state.tone === "ok"
      ? "bg-emerald-500/10 text-emerald-600"
      : state.tone === "fail"
        ? "bg-destructive/10 text-destructive"
        : "bg-muted text-muted-foreground";
  const payloadJson = JSON.stringify(d.payload, null, 2);

  function copyPayload() {
    void navigator.clipboard.writeText(payloadJson).then(
      () => toast.success("Payload copied"),
      () => toast.error("Couldn't access clipboard"),
    );
  }

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-2 px-3 py-2 text-left hover:bg-accent/40"
      >
        <ChevronDown
          className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${
            open ? "" : "-rotate-90"
          }`}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-xs font-medium" title={d.eventType}>
              {eventLabel.get(d.eventType) ?? d.eventType}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-3xs ${toneClass}`}>
              {state.label}
            </span>
            {d.attemptCount > 1 && (
              <span className="text-3xs text-muted-foreground">
                {d.attemptCount} attempts
              </span>
            )}
          </span>
          <span className="mt-0.5 block text-2xs text-muted-foreground">
            <LocalTime iso={d.createdAt} format="localeString" />
          </span>
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-border bg-muted/10 px-3 py-2">
          {d.errorMessage && (
            <div className="text-2xs text-destructive">{d.errorMessage}</div>
          )}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-3xs font-medium uppercase tracking-wide text-muted-foreground">
                Payload sent
              </span>
              <Button type="button" size="sm" variant="ghost" onClick={copyPayload}>
                <Copy className="size-3" />
                Copy
              </Button>
            </div>
            <pre className="max-h-64 overflow-auto rounded-md border border-border bg-background p-2 text-3xs leading-relaxed">
              <code>{payloadJson}</code>
            </pre>
          </div>
          {d.responseBody && (
            <div>
              <div className="mb-1 text-3xs font-medium uppercase tracking-wide text-muted-foreground">
                Response{d.responseStatus != null ? ` · ${d.responseStatus}` : ""}
              </div>
              <pre className="max-h-40 overflow-auto rounded-md border border-border bg-background p-2 text-3xs leading-relaxed">
                <code>{d.responseBody}</code>
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Signature verification guide — pasted into the page so admins can copy-
// paste the exact verifier shape into their receiver. The signature header
// format is `t=<unix-seconds>,v1=<hex>` (Stripe-style); receivers split on
// `,`, recompute HMAC-SHA256 over `${t}.${rawBody}`, and timing-safe-compare
// against `v1`. Including a >5min skew reject is recommended to defend against
// replay.
// ---------------------------------------------------------------------------

const VERIFY_JS = `// Node.js / TypeScript — verify an X-CCP-Signature header
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyCcpWebhook(opts: {
  rawBody: string;          // exactly the bytes you received (do NOT JSON.parse first)
  header: string | null;    // value of the X-CCP-Signature header
  secret: string;           // the secret shown once at create/rotate time
  tolerance?: number;       // seconds; default 5min to reject replays
}): boolean {
  if (!opts.header) return false;
  const parts = Object.fromEntries(
    opts.header.split(",").map((p) => p.trim().split("=")),
  ) as { t?: string; v1?: string };
  if (!parts.t || !parts.v1) return false;
  const ts = Number.parseInt(parts.t, 10);
  if (!Number.isFinite(ts)) return false;
  const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (skew > (opts.tolerance ?? 300)) return false;
  const expected = createHmac("sha256", opts.secret)
    .update(\`\${ts}.\${opts.rawBody}\`)
    .digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(parts.v1, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}`;

const VERIFY_PY = `# Python 3 — verify an X-CCP-Signature header
import hmac, hashlib, time

def verify_ccp_webhook(raw_body: bytes, header: str | None, secret: str,
                       tolerance: int = 300) -> bool:
    if not header:
        return False
    parts = dict(p.strip().split("=", 1) for p in header.split(","))
    t, v1 = parts.get("t"), parts.get("v1")
    if not t or not v1:
        return False
    try:
        ts = int(t)
    except ValueError:
        return False
    if abs(int(time.time()) - ts) > tolerance:
        return False
    signed = f"{ts}.".encode() + raw_body
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, v1)`;

function SignatureVerificationGuide() {
  const [lang, setLang] = useState<"js" | "python">("js");
  function copy() {
    void navigator.clipboard.writeText(lang === "js" ? VERIFY_JS : VERIFY_PY).then(
      () => toast.success("Copied to clipboard"),
      () => toast.error("Couldn't access clipboard"),
    );
  }
  return (
    <details className="rounded-md border border-border bg-muted/10 px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
        Verifying the <code className="font-mono">X-CCP-Signature</code> header
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        <p className="text-2xs leading-relaxed text-muted-foreground">
          Every delivery includes <code className="font-mono">X-CCP-Signature: t=&lt;ts&gt;,v1=&lt;hex&gt;</code>.
          Compute <code className="font-mono">HMAC-SHA256(secret, t + &quot;.&quot; + rawBody)</code>{" "}
          and compare to <code className="font-mono">v1</code> in constant time. Reject deliveries
          with a timestamp skew &gt; 5 min to defend against replay attacks.
        </p>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant={lang === "js" ? "outline" : "ghost"}
            onClick={() => setLang("js")}
          >
            Node.js
          </Button>
          <Button
            type="button"
            size="sm"
            variant={lang === "python" ? "outline" : "ghost"}
            onClick={() => setLang("python")}
          >
            Python
          </Button>
          <div className="ml-auto">
            <Button type="button" size="sm" variant="outline" onClick={copy}>
              <Copy className="size-3.5" />
              Copy
            </Button>
          </div>
        </div>
        <pre className="overflow-x-auto rounded-md border border-border bg-background p-3 text-2xs leading-relaxed">
          <code>{lang === "js" ? VERIFY_JS : VERIFY_PY}</code>
        </pre>
      </div>
    </details>
  );
}
