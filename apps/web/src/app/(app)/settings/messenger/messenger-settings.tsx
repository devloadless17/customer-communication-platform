"use client";

import { useState, useTransition } from "react";
import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import { Check, CheckCircle2, Loader2, Phone, PlugZap, TriangleAlert, Unplug } from "lucide-react";
import { cn } from "@ccp/shared/utils";

import { Button } from "@/components/ui/button";
import { ChannelAccountsPanel } from "@/features/channels/components/channel-accounts-panel";
import type { ChannelAccountView } from "@/lib/api/queries";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/layouts/page-header";
import {
  PageSubscriptionWarning,
  type PageSubscription,
} from "@/components/settings/page-subscription-warning";
import { apiFetch } from "@/lib/api/client-fetch";
import { CHANNEL_CAPABILITIES } from "@ccp/shared/providers/capabilities";
import { toast } from "@/lib/toast";

export interface MessengerCurrent {
  connected: boolean;
  pageId: string | null;
  pageName: string | null;
  appId: string | null;
  verifyToken: string | null;
  pageAccessToken: string | null;
  appSecret: string | null;
  credentialsUndecryptable?: boolean;
  /** Set when a send failed with Graph 190 — the token expired/was revoked. */
  needsReconnect?: boolean;
  webhookSubscription?: PageSubscription | null;
}

export function MessengerSettings({
  current,
  canManage,
  accounts,
}: {
  current: MessengerCurrent;
  canManage: boolean;
  /** Every Messenger account this workspace has connected. A workspace may hold
   *  several — the panel below is where they are named and managed. */
  accounts: ChannelAccountView[];
}) {
  const softRefresh = useSoftRefresh();
  const { confirm, confirmDialog } = useConfirm();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(
    !current.connected ||
      Boolean(current.credentialsUndecryptable) ||
      Boolean(current.needsReconnect),
  );
  // Controlled fields — only the Page id + an optional token override; the App
  // secret + verify token come from the shared Meta App connection.
  const [form, setForm] = useState({
    pageId: current.pageId ?? "",
    pageAccessToken: "",
  });
  const setField = (k: keyof typeof form) => (v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setError(null);
    const res = await apiFetch("/api/workspace/messenger", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        detail?: string;
      };
      setError(
        [data.error, data.detail && `(${data.detail.slice(0, 200)})`]
          .filter(Boolean)
          .join(" ") || "Failed to save",
      );
      return false;
    }
    return true;
  }

  async function disconnect() {
    const ok = await confirm({
      title: "Disconnect Messenger?",
      description:
        "Your conversations will stay, but no new Messenger messages will flow until you reconnect.",
      confirmLabel: "Disconnect",
      destructive: true,
    });
    if (!ok) return;
    const res = await apiFetch("/api/workspace/messenger", { method: "DELETE" });
    if (!res.ok) {
      setError("Failed to disconnect");
      return;
    }
    softRefresh();
    setShowForm(true);
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <PageHeader
        title="Facebook Messenger"
        description="Connect a Facebook Page so its Messenger conversations land in your shared inbox."
      />

      {confirmDialog}

      {canManage && (
        <ChannelAccountsPanel
          channel="messenger"
          accounts={accounts}
          channelLabel="Messenger"
          accountNoun="Page"
          // Reveals the connect form (collapsed once connected) and scrolls to
          // it, so "Add another" visibly does something.
          onAddAnother={() => {
            setShowForm(true);
            requestAnimationFrame(() => {
              document
                .getElementById("messenger-connect-form")
                ?.scrollIntoView({ behavior: "smooth", block: "center" });
            });
          }}
        />
      )}

      <div
        className={cn(
          "rounded-xl border p-5",
          current.connected ? "border-success-border bg-success-bg" : "bg-card",
        )}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            {current.connected ? (
              <Check className="size-4 shrink-0 text-success-fg" />
            ) : (
              <span className="inline-flex size-2.5 rounded-full bg-muted-foreground/40" />
            )}
            <div>
              <p
                className={cn(
                  "text-sm font-medium",
                  current.connected && "text-success-fg",
                )}
              >
                {current.connected ? "Connected" : "Not connected"}
              </p>
              {current.connected && (
                <p className="text-xs text-muted-foreground">
                  {current.pageName ?? "Page"} · {current.pageId}
                </p>
              )}
            </div>
          </div>
          {canManage && current.connected && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowForm((s) => !s)}>
                {showForm ? "Cancel" : "Edit"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={disconnect}
                className="text-destructive"
              >
                <Unplug className="mr-1.5 size-3.5" />
                Disconnect
              </Button>
            </div>
          )}
        </div>

        {current.connected && current.needsReconnect && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="font-medium">Access token expired — reconnect to keep sending</p>
              <p className="mt-0.5 text-amber-700/80 dark:text-amber-400/80">
                Meta rejected the last send because the Page token was revoked or
                expired. Inbound messages still arrive, but replies will fail until
                you re-enter a valid token below.
              </p>
            </div>
          </div>
        )}

        {current.connected && (
          <PageSubscriptionWarning
            subscription={current.webhookSubscription}
            channelLabel="Messenger"
          />
        )}
      </div>

      {/* Gated on the Messenger calling capability (currently off — the product
          offers WhatsApp calling only). This mirrors the inbox call button and
          the backend initiateCall gate, so all three respect the one flag: flip
          `CHANNEL_CAPABILITIES.messenger.calling` back on to restore the whole
          calling surface at once. */}
      {canManage && current.connected && CHANNEL_CAPABILITIES.messenger.calling && (
        <CallingCard pageName={current.pageName} />
      )}

      {canManage && showForm && (
        <form
          id="messenger-connect-form"
          className="flex flex-col gap-4 rounded-xl border bg-card p-5"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              if (await save()) {
                toast.success("Messenger connected");
                setShowForm(false);
                softRefresh();
              }
            });
          }}
        >
          <h3 className="text-sm font-medium">Page</h3>
          <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            Enter the Facebook <strong>Page ID</strong> — the App secret + token
            come from your{" "}
            <a href="/settings/meta" className="underline">
              Meta App
            </a>{" "}
            connection (the Page access token is derived from its system-user
            token).
          </p>
          {current.credentialsUndecryptable && (
            <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
              Stored credentials could not be decrypted. Re-paste them from Meta.
            </p>
          )}
          <LabeledInput
            label="Page ID"
            value={form.pageId}
            onChange={setField("pageId")}
            placeholder="1234567890"
            required
          />
          <LabeledInput
            label="Page access token (optional)"
            value={form.pageAccessToken}
            onChange={setField("pageAccessToken")}
            placeholder="Leave blank to derive from your Meta App system-user token"
            secret
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end">
            <Button type="submit" disabled={pending}>
              {pending ? (
                <Loader2 className="mr-1.5 size-4 animate-spin" />
              ) : (
                <PlugZap className="mr-1.5 size-4" />
              )}
              {current.connected ? "Update" : "Connect"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * One-click enablement of Messenger Calling for the connected Page. Calls the
 * admin endpoint, which turns on audio + video calling, routes consumer calls
 * to this app (PARTNERS), shows the in-thread call icon, and reports whether
 * Meta has granted the `messenger_api_calling` feature. Enabling the audio/video
 * settings is the load-bearing step — without it Meta reports "Call Settings Not
 * Enabled" on every calling API even when the feature is granted.
 */
function CallingCard({ pageName }: { pageName: string | null }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    | { ok: true; featureEnabled: boolean }
    | { ok: false; error: string }
    | null
  >(null);

  async function enable() {
    setBusy(true);
    setResult(null);
    try {
      const res = await apiFetch("/api/calls/admin/enable?channel=messenger", {
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        raw?: { featureEnabled?: boolean };
        error?: string;
        detail?: string;
      };
      if (!res.ok || !data.ok) {
        setResult({ ok: false, error: data.detail || data.error || `Failed (HTTP ${res.status})` });
        return;
      }
      const featureEnabled = data.raw?.featureEnabled === true;
      setResult({ ok: true, featureEnabled });
      toast.success("Messenger calling enabled");
    } catch (err) {
      setResult({ ok: false, error: err instanceof Error ? err.message : "Network error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Phone className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">Calling</p>
            <p className="text-xs text-muted-foreground">
              Turn on audio &amp; video calls for {pageName ?? "this Page"} — agents can
              place calls and inbound customer calls ring in your inbox.
            </p>
          </div>
        </div>
        <Button size="sm" onClick={enable} disabled={busy} className="shrink-0">
          {busy ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Phone className="mr-1.5 size-3.5" />}
          Enable calling
        </Button>
      </div>

      {result?.ok && (
        <div className="mt-3 flex items-start gap-2 rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Calling settings enabled (audio + video, routed to this app).{" "}
            {result.featureEnabled ? (
              "Meta has granted the calling feature for this Page — you're all set. On the first call, the customer taps “Allow” to grant permission, then calls connect."
            ) : (
              "Note: Meta hasn't granted the `messenger_api_calling` feature for this Page yet — request it in your Meta App dashboard before calls will connect."
            )}
          </span>
        </div>
      )}
      {result && !result.ok && (
        <div className="mt-3 flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{result.error}</span>
        </div>
      )}
    </div>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
  required,
  secret,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  secret?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        type={secret ? "password" : "text"}
        autoComplete="off"
      />
    </label>
  );
}
