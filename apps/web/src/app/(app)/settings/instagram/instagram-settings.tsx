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

export interface InstagramCurrent {
  connected: boolean;
  igId: string | null;
  igUsername: string | null;
  pageId: string | null;
  pageName: string | null;
  appId: string | null;
  verifyToken: string | null;
  igAccessToken: string | null;
  appSecret: string | null;
  credentialsUndecryptable?: boolean;
  webhookSubscription?: PageSubscription | null;
}

export function InstagramSettings({
  current,
  canManage,
}: {
  current: InstagramCurrent;
  canManage: boolean;
}) {
  const softRefresh = useSoftRefresh();
  const { confirm, confirmDialog } = useConfirm();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(
    !current.connected || Boolean(current.credentialsUndecryptable),
  );
  // Controlled fields — React 19 `<form action>` resets the DOM form after the
  // action. Only the identity + an optional token override; App secret + verify
  // token come from the shared Meta App connection.
  const [form, setForm] = useState({
    pageId: current.pageId ?? "",
    igAccessToken: "",
  });
  const setField = (k: keyof typeof form) => (v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setError(null);
    const res = await apiFetch("/api/team/instagram", {
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
      title: "Disconnect Instagram?",
      description:
        "Your conversations will stay, but no new Instagram messages will flow until you reconnect.",
      confirmLabel: "Disconnect",
      destructive: true,
    });
    if (!ok) return;
    const res = await apiFetch("/api/team/instagram", { method: "DELETE" });
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
        title="Instagram DM"
        description="Connect an Instagram professional account so its DMs land in your shared inbox."
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
                  {current.igUsername ? `@${current.igUsername}` : "Account"} · {current.igId}
                  {current.pageName ? ` · via ${current.pageName}` : ""}
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

        {/* Instagram DMs ride the linked Page, so an unsubscribed Page silences
            IG inbound exactly like Messenger's. Same banner, same remedy. */}
        {current.connected && (
          <PageSubscriptionWarning
            subscription={current.webhookSubscription}
            channelLabel="Instagram"
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
                toast.success("Instagram connected");
                setShowForm(false);
                softRefresh();
              }
            });
          }}
        >
          <h3 className="text-sm font-medium">Account</h3>
          <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            Instagram DMs run through the Facebook Page your professional account
            is linked to. Enter that <strong>Page ID</strong> — we read the
            Instagram account from it, and the App secret + token come from your{" "}
            <a href="/settings/meta" className="underline">
              Meta App
            </a>{" "}
            connection.
          </p>
          {current.credentialsUndecryptable && (
            <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
              Stored credentials could not be decrypted. Re-paste them from Meta.
            </p>
          )}
          <LabeledInput
            label="Facebook Page ID"
            value={form.pageId}
            onChange={setField("pageId")}
            placeholder="1029384756..."
            required
          />
          <LabeledInput
            label="Page access token (optional)"
            value={form.igAccessToken}
            onChange={setField("igAccessToken")}
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
