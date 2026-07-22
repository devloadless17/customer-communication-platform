"use client";

import { useState, useTransition } from "react";
import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import { Check, Copy, Loader2, PlugZap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/layouts/page-header";
import { apiFetch } from "@/lib/api/client-fetch";
import { toast } from "@/lib/toast";

export interface MetaCurrent {
  connected: boolean;
  appId: string | null;
  verifyToken: string | null;
  appSecret: string | null;
  systemUserToken: string | null;
  credentialsUndecryptable?: boolean;
}

export function MetaSettings({
  current,
  webhookBaseUrl,
  workspaceId,
  canManage,
}: {
  current: MetaCurrent;
  webhookBaseUrl: string;
  workspaceId: string;
  canManage: boolean;
}) {
  const softRefresh = useSoftRefresh();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // Controlled inputs — React 19 `<form action>` resets the DOM form after the
  // action, which would wipe fields on a failed submit.
  const [form, setForm] = useState({
    appSecret: current.appSecret ?? "",
    systemUserToken: current.systemUserToken ?? "",
    appId: current.appId ?? "",
  });
  const setField = (k: keyof typeof form) => (v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  const webhookUrl = `${webhookBaseUrl}/webhooks/meta/${workspaceId}`;

  function copy(value: string, key: string) {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((k) => (k === key ? null : k)), 1500);
    });
  }

  async function save(): Promise<{ resynced: string[] } | null> {
    setError(null);
    const res = await apiFetch("/api/team/meta", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      detail?: string;
      resynced?: string[];
    };
    if (!res.ok) {
      setError(
        [data.error, data.detail && `(${data.detail.slice(0, 200)})`]
          .filter(Boolean)
          .join(" ") || "Failed to save",
      );
      return null;
    }
    return { resynced: data.resynced ?? [] };
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <PageHeader
        title="Meta App"
        description="Set your Meta app credentials once — WhatsApp, Messenger, and Instagram all share them. Then each channel just needs its own Page or phone number."
      />

      <div className="rounded-xl border bg-card p-5">
        <div className="flex items-center gap-3">
          <span
            className={`inline-flex size-2.5 rounded-full ${
              current.connected ? "bg-emerald-500" : "bg-muted-foreground/40"
            }`}
          />
          <p className="text-sm font-medium">
            {current.connected ? "Meta App configured" : "Not configured"}
          </p>
        </div>
        <p className="mt-1 pl-[22px] text-xs text-muted-foreground">
          The App secret verifies inbound webhooks; the system-user token sends
          on WhatsApp and derives the Page tokens for Messenger &amp; Instagram.
        </p>
      </div>

      {canManage && (
        <div className="rounded-xl border bg-card p-5">
          <h3 className="text-sm font-medium">Webhook (one for all channels)</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            In your Meta app, paste this <strong>one</strong> callback URL and
            verify token for WhatsApp, Messenger, and Instagram, then subscribe
            each product to <code>messages</code>.
          </p>
          <div className="mt-3 space-y-2">
            <Field
              label="Callback URL"
              value={webhookUrl}
              copied={copied === "url"}
              onCopy={() => copy(webhookUrl, "url")}
            />
            <Field
              label="Verify token"
              value={current.verifyToken ?? "—"}
              copied={copied === "vt"}
              onCopy={() => current.verifyToken && copy(current.verifyToken, "vt")}
            />
          </div>
        </div>
      )}

      {canManage && (
        <form
          className="flex flex-col gap-4 rounded-xl border bg-card p-5"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              const out = await save();
              if (out) {
                const labels = out.resynced
                  .map((c) => c.charAt(0).toUpperCase() + c.slice(1))
                  .join(", ");
                toast.success(
                  labels ? `Meta App saved · refreshed ${labels}` : "Meta App saved",
                );
                softRefresh();
              }
            });
          }}
        >
          <h3 className="text-sm font-medium">App credentials</h3>
          {current.credentialsUndecryptable && (
            <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
              Stored credentials could not be decrypted. Re-paste them from Meta.
            </p>
          )}
          <LabeledInput
            label="App secret"
            value={form.appSecret}
            onChange={setField("appSecret")}
            placeholder="App Settings → Basic → App secret"
            required
            secret
          />
          <LabeledInput
            label="System-user access token"
            value={form.systemUserToken}
            onChange={setField("systemUserToken")}
            placeholder="Business Settings → System users → Generate token (all channel scopes)"
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
              Save
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
