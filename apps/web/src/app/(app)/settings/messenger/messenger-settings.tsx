"use client";

import { useState, useTransition } from "react";
import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import { Check, Copy, Loader2, PlugZap, Unplug } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/layouts/page-header";
import { apiFetch } from "@/lib/api/client-fetch";
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
}

export function MessengerSettings({
  current,
  webhookBaseUrl,
  teamId,
  canManage,
}: {
  current: MessengerCurrent;
  webhookBaseUrl: string;
  teamId: string;
  canManage: boolean;
}) {
  const softRefresh = useSoftRefresh();
  const { confirm, confirmDialog } = useConfirm();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(
    !current.connected || Boolean(current.credentialsUndecryptable),
  );
  const [copied, setCopied] = useState<string | null>(null);
  // CONTROLLED fields — React 19 `<form action>` auto-resets the DOM form after
  // the action runs (even on failure), which would wipe the inputs. Holding the
  // values in state keeps them across a rejected submit so the admin can fix one
  // wrong key without re-typing all of them.
  const [form, setForm] = useState({
    pageId: current.pageId ?? "",
    pageAccessToken: current.pageAccessToken ?? "",
    appSecret: current.appSecret ?? "",
    appId: current.appId ?? "",
  });
  const setField = (k: keyof typeof form) => (v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  // Meta delivers every product (WhatsApp / Messenger / Instagram) to the same
  // per-team callback; the server fans out by the webhook `object`.
  const webhookUrl = `${webhookBaseUrl}/webhooks/meta/${teamId}`;

  function copy(value: string, key: string) {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((k) => (k === key ? null : k)), 1500);
    });
  }

  async function save() {
    setError(null);
    const res = await apiFetch("/api/team/messenger", {
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
    const res = await apiFetch("/api/team/messenger", { method: "DELETE" });
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

      {/* Connection status */}
      <div className="rounded-xl border bg-card p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex size-2.5 rounded-full ${
                current.connected ? "bg-emerald-500" : "bg-muted-foreground/40"
              }`}
            />
            <div>
              <p className="text-sm font-medium">
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
      </div>

      {/* Webhook setup — always visible so admins can wire Meta first */}
      {canManage && (
        <div className="rounded-xl border bg-card p-5">
          <h3 className="text-sm font-medium">Webhook</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            In your Meta app → Messenger → Webhooks, paste this callback URL and
            verify token, then subscribe the Page to <code>messages</code> and{" "}
            <code>message_deliveries</code>.
          </p>
          <div className="mt-3 space-y-2">
            <Field label="Callback URL" value={webhookUrl} copied={copied === "url"} onCopy={() => copy(webhookUrl, "url")} />
            <Field
              label="Verify token"
              value={current.verifyToken ?? "—"}
              copied={copied === "vt"}
              onCopy={() => current.verifyToken && copy(current.verifyToken, "vt")}
            />
          </div>
        </div>
      )}

      {/* Credentials form */}
      {canManage && showForm && (
        <form
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
          <h3 className="text-sm font-medium">Page credentials</h3>
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
            label="Page access token"
            value={form.pageAccessToken}
            onChange={setField("pageAccessToken")}
            placeholder="EAAG..."
            required
            secret
          />
          <LabeledInput
            label="App secret"
            value={form.appSecret}
            onChange={setField("appSecret")}
            placeholder="Verifies inbound webhooks"
            required
            secret
          />
          <LabeledInput
            label="App ID (optional)"
            value={form.appId}
            onChange={setField("appId")}
            placeholder="Informational"
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

function Field({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-28 shrink-0 text-xs text-muted-foreground">{label}</span>
      <code className="flex-1 truncate rounded-md bg-muted px-2 py-1.5 text-xs">{value}</code>
      <Button variant="ghost" size="icon" className="size-8" onClick={onCopy} type="button">
        {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
      </Button>
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
