"use client";

import { useState, useTransition } from "react";
import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import { Loader2, PlugZap, Unplug } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/layouts/page-header";
import {
  PageSubscriptionWarning,
  type PageSubscription,
} from "@/components/settings/page-subscription-warning";
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
  webhookSubscription?: PageSubscription | null;
}

export function MessengerSettings({
  current,
  canManage,
}: {
  current: MessengerCurrent;
  canManage: boolean;
}) {
  const softRefresh = useSoftRefresh();
  const { confirm, confirmDialog } = useConfirm();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(
    !current.connected || Boolean(current.credentialsUndecryptable),
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

        {current.connected && (
          <PageSubscriptionWarning
            subscription={current.webhookSubscription}
            channelLabel="Messenger"
          />
        )}
      </div>

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
