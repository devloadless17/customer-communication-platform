"use client";

import { useState, useTransition } from "react";
import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import { Check, Loader2, PlugZap, TriangleAlert, Unplug } from "lucide-react";
import { cn } from "@ccp/shared/utils";

import { Button } from "@/components/ui/button";
import { ChannelAccountsPanel } from "@/features/channels/components/channel-accounts-panel";
import {
  channelDisconnectCopy,
  fetchChannelRemovalImpact,
} from "@/features/channels/lib/channel-disconnect";
import type { ChannelAccountView } from "@/lib/api/queries";
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
  /** Set when a send failed with Graph 190 — the token expired/was revoked. */
  needsReconnect?: boolean;
  webhookSubscription?: PageSubscription | null;
}

export function InstagramSettings({
  current,
  canManage,
  accounts,
}: {
  current: InstagramCurrent;
  canManage: boolean;
  /** Every Instagram account this workspace has connected. A workspace may hold
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
  // Controlled fields — React 19 `<form action>` resets the DOM form after the
  // action. Only the identity + an optional token override; App secret + verify
  // token come from the shared Meta App connection.
  const [form, setForm] = useState({
    pageId: current.pageId ?? "",
    igAccessToken: "",
  });
  const setField = (k: keyof typeof form) => (v: string) =>
    setForm((f) => ({ ...f, [k]: v }));
  // Adding an ADDITIONAL account rather than editing the default one — changes
  // the form's heading + submit label so the two intents don't look identical.
  const [addingAccount, setAddingAccount] = useState(false);

  async function save() {
    setError(null);
    const res = await apiFetch("/api/workspace/instagram", {
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
    // Read the blast radius FIRST — this button removes every account, and the
    // old copy said only "no new messages will flow", which on a two-account
    // workspace understated it by an entire account.
    const impact = await fetchChannelRemovalImpact("instagram");
    const { description, confirmLabel } = channelDisconnectCopy(
      "account",
      "accounts",
      impact,
    );
    const ok = await confirm({
      title: "Disconnect Instagram?",
      description,
      confirmLabel,
      destructive: true,
    });
    if (!ok) return;
    // The server refuses an unconfirmed multi-account disconnect (409); the
    // dialog above IS that confirmation.
    const res = await apiFetch("/api/workspace/instagram?confirmAll=1", { method: "DELETE" });
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

      {canManage && (
        <ChannelAccountsPanel
          channel="instagram"
          accounts={accounts}
          channelLabel="Instagram"
          accountNoun="account"
          // Reveals the connect form (collapsed once connected) and scrolls to
          // it, so "Add another" visibly does something. The Page id is cleared
          // first: it is prefilled from the DEFAULT account, and submitting that
          // unchanged would re-save the existing one instead of adding another.
          onAddAnother={() => {
            setForm((f) => ({ ...f, pageId: "" }));
            setAddingAccount(true);
            setShowForm(true);
            requestAnimationFrame(() => {
              document
                .getElementById("instagram-connect-form")
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
                  {current.igUsername ? `@${current.igUsername}` : "Account"} · {current.igId}
                  {current.pageName ? ` · via ${current.pageName}` : ""}
                </p>
              )}
            </div>
          </div>
          {canManage && current.connected && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  // Leaving add mode (either direction) restores the default
                  // Page id, so "Edit" always edits the connected account.
                  setAddingAccount(false);
                  setForm((f) => ({ ...f, pageId: current.pageId ?? "" }));
                  setShowForm((s) => !s);
                }}
              >
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
                Meta rejected the last send because the token was revoked or expired.
                Inbound DMs still arrive, but replies will fail until you re-enter a
                valid token below.
              </p>
            </div>
          </div>
        )}

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
          id="instagram-connect-form"
          className="flex flex-col gap-4 rounded-xl border bg-card p-5"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              if (await save()) {
                toast.success("Instagram connected");
                setShowForm(false);
                setAddingAccount(false);
                softRefresh();
              }
            });
          }}
        >
          <h3 className="text-sm font-medium">
            {addingAccount ? "Add another account" : "Account"}
          </h3>
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
              {addingAccount ? "Add account" : current.connected ? "Update" : "Connect"}
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
