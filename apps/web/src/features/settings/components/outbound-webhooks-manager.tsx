"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Loader2,
  Plus,
  RotateCw,
  Send,
  Trash2,
  Webhook,
  XCircle,
} from "lucide-react";

import { LocalTime } from "@/components/local-time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { getClientSocket } from "@/lib/socket-client";
import { toast } from "@/lib/toast";

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
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<RevealedSecret | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const { confirm, confirmDialog } = useConfirm();

  // Listen for circuit-breaker trips. The worker publishes
  // `webhook:subscription_disabled` to the team room whenever auto-disable
  // fires; we toast the admin + refresh the list so they see the new
  // "Auto-disabled" badge without a manual reload.
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
    socket.on("webhook:subscription_disabled", onDisabled);
    return () => {
      socket.off("webhook:subscription_disabled", onDisabled);
    };
  }, [webhooks]);

  return (
    <div className="flex flex-col gap-6">
      {/* Create banner / form */}
      {!showCreate ? (
        <Button
          variant="outline"
          onClick={() => setShowCreate(true)}
          className="self-start"
        >
          <Plus className="size-4" />
          Create a webhook
        </Button>
      ) : (
        <CreateForm
          eventGroups={eventGroups}
          onCancel={() => setShowCreate(false)}
          onCreated={(created, secret) => {
            setWebhooks((prev) => [created, ...prev]);
            setRevealed({ webhookId: created.id, secret, flow: "created" });
            setShowCreate(false);
            setCreating(false);
          }}
          submitting={creating}
          setSubmitting={setCreating}
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

      {/* HMAC verification snippets — always shown so admins can wire up the
          receiver's verifier without leaving the page or searching docs. */}
      <SignatureVerificationGuide />

      {/* List */}
      <div className="flex flex-col gap-2">
        <div className="text-sm font-medium">Your webhooks</div>
        {webhooks.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground">
            No webhooks yet. Create one above to start receiving deliveries.
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-border rounded-md border border-border">
            {webhooks.map((w) => (
              <WebhookRow
                key={w.id}
                webhook={w}
                onDelete={async () => {
                  const ok = await confirm({
                    title: `Delete "${w.name}"?`,
                    description:
                      "Deliveries are dropped immediately. The delivery history for this webhook is removed too.",
                    confirmLabel: "Delete",
                    destructive: true,
                  });
                  if (!ok) return;
                  const res = await fetch(`/api/team/outbound-webhooks/${w.id}`, {
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
                  const res = await fetch(
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
                  const res = await fetch(`/api/team/outbound-webhooks/${w.id}/test`, {
                    method: "POST",
                  });
                  if (!res.ok) {
                    toast.error("Test failed", { description: `HTTP ${res.status}` });
                    return;
                  }
                  toast.success("Test delivery queued", {
                    description:
                      "Check your receiver — the synthetic webhook.test event should land shortly.",
                  });
                }}
                onToggleEnabled={async () => {
                  const res = await fetch(`/api/team/outbound-webhooks/${w.id}`, {
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
            ))}
          </div>
        )}
      </div>

      {confirmDialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create form
// ---------------------------------------------------------------------------

function CreateForm({
  eventGroups,
  onCancel,
  onCreated,
  submitting,
  setSubmitting,
}: {
  eventGroups: EventGroup[];
  onCancel: () => void;
  onCreated: (webhook: Webhook, secret: string) => void;
  submitting: boolean;
  setSubmitting: (v: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

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
      const res = await fetch("/api/team/outbound-webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          url: url.trim(),
          eventTypes: Array.from(selected),
        }),
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
      onCreated(
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
        <label className="text-xs font-medium">Name</label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="n8n CRM sync"
          maxLength={80}
          required
        />
      </div>
      <div className="flex flex-col gap-2">
        <label className="text-xs font-medium">URL</label>
        <Input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://your-n8n.example.com/webhook/abcd"
          required
        />
        <p className="text-[11px] text-muted-foreground">
          We'll POST a JSON envelope here with an{" "}
          <code className="font-mono">X-CCP-Signature</code> header.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <label className="text-xs font-medium">Events</label>
        <div className="flex flex-col gap-3">
          {eventGroups.map((g) => (
            <div key={g.group}>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
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
                      <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
                        {evt.type}
                      </span>
                      <div className="text-[11px] text-muted-foreground">
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
      {error && <div className="text-xs text-destructive">{error}</div>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
          Create webhook
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
  onDelete,
  onRotate,
  onTest,
  onToggleEnabled,
}: {
  webhook: Webhook;
  onDelete: () => void;
  onRotate: () => void;
  onTest: () => void;
  onToggleEnabled: () => void;
}) {
  const host = safeHost(webhook.url);
  // `disabledAt` is set ONLY by the circuit breaker; an admin's manual
  // toggle leaves it null. That's a reliable signal for the badge — the
  // pre-disabledAt fallback (`!enabled && consecutiveFailures > 0`) was a
  // proxy that misfired when an admin disabled an already-erroring webhook.
  const tripped = !webhook.enabled && webhook.disabledAt !== null;

  return (
    <div className="flex flex-col gap-2 px-3 py-3">
      <div className="flex items-start gap-3">
        <div
          className={`flex size-7 shrink-0 items-center justify-center rounded-md ${
            webhook.enabled
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground"
          }`}
        >
          <Webhook className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="truncate font-medium">{webhook.name}</span>
            {tripped && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] uppercase text-destructive"
                title={webhook.disabledReason ?? undefined}
              >
                <AlertTriangle className="size-3" /> auto-disabled
              </span>
            )}
            {!webhook.enabled && !tripped && (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                disabled
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            <code className="font-mono">{host}</code>
            <span className="ml-2">{webhook.eventTypes.length} event{webhook.eventTypes.length === 1 ? "" : "s"}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
            {webhook.lastDeliveredAt ? (
              <span className="inline-flex items-center gap-1">
                <CheckCircle2 className="size-3 text-emerald-600" />
                last delivered{" "}
                <LocalTime iso={webhook.lastDeliveredAt} format="localeString" />
              </span>
            ) : (
              <span>never delivered</span>
            )}
            {webhook.lastErrorAt && (
              <span className="inline-flex items-center gap-1 text-destructive">
                <XCircle className="size-3" />
                last error <LocalTime iso={webhook.lastErrorAt} format="localeString" />
              </span>
            )}
          </div>
          {webhook.lastErrorMessage && (
            <div className="mt-1 truncate text-[11px] text-destructive">
              {webhook.lastErrorMessage}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button type="button" size="sm" variant="ghost" onClick={onTest} title="Send test delivery">
            <Send className="size-3.5" />
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onRotate} title="Rotate secret">
            <RotateCw className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onToggleEnabled}
            title={webhook.enabled ? "Disable" : "Enable"}
          >
            {webhook.enabled ? "Disable" : "Enable"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={onDelete}
            title="Delete"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
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
        <p className="text-[11px] leading-relaxed text-muted-foreground">
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
        <pre className="overflow-x-auto rounded-md border border-border bg-background p-3 text-[11px] leading-relaxed">
          <code>{lang === "js" ? VERIFY_JS : VERIFY_PY}</code>
        </pre>
      </div>
    </details>
  );
}
