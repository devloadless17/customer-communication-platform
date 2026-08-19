"use client";

import { useState, useTransition } from "react";
import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import { Check, Loader2, PlugZap, TriangleAlert, Unplug } from "lucide-react";
import { cn } from "@ccp/shared/utils";
import type { InboxSource } from "@ccp/shared/providers/capabilities";

import { Button } from "@/components/ui/button";
import { ChannelAccountsPanel } from "@/features/channels/components/channel-accounts-panel";
import { EntryPointsPanel } from "@/features/channels/components/entry-points-panel";
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
import { apiErrorMessageFrom } from "@ccp/shared/api/error-message";
import { apiFetch } from "@/lib/api/client-fetch";
import { toast } from "@/lib/toast";

export interface InstagramCurrent {
  connected: boolean;
  /** Non-DM sources currently allowed into the inbox. DMs are always on. */
  inboxSources?: InboxSource[];
  /** Every non-DM source this channel can offer. */
  availableInboxSources?: InboxSource[];
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
  /** Webhooks we 403'd in the last 24h — inbound may be silently dropping. */
  webhookRejection?: { at: string; reason: string } | null;
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
    // Per-account Meta app override — see the fields at the bottom of the form.
    appSecret: "",
    appId: current.appId ?? "",
  });
  const setField = (k: keyof typeof form) => (v: string) =>
    setForm((f) => ({ ...f, [k]: v }));
  // Adding an ADDITIONAL account rather than editing the default one — changes
  // the form's heading + submit label so the two intents don't look identical.
  const [addingAccount, setAddingAccount] = useState(false);

  async function save() {
    setError(null);
    // Drop blank optionals rather than posting "". The server reads an ABSENT
    // appSecret as "keep whatever this row already has" (input → row's own →
    // shared), so sending an empty string from an untouched box would reset an
    // account that is deliberately on its own Meta app back onto the shared one.
    const body = Object.fromEntries(
      Object.entries(form).filter(([, v]) => typeof v === "string" && v.trim().length > 0),
    );
    const res = await apiFetch("/api/workspace/instagram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, pageId: form.pageId }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        detail?: string;
      };
      // `detail` → humanized key → fallback. The old join led with the raw
      // snake_case key and put the sentence the server wrote for a person in
      // brackets behind it.
      setError(apiErrorMessageFrom(data, "Failed to save"));
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

      {/* Only once an account exists: the panel reads Meta on mount, and there is
          nothing to read (or to configure) before the handle is connected. */}
      {canManage && current.connected && <EntryPointsPanel channel="instagram" />}

      {canManage && current.connected && (
        <InboxSourcesPanel
          available={current.availableInboxSources ?? []}
          initial={current.inboxSources ?? []}
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
              {/* A non-admin is told CONNECTED (from the member-open account
                  directory) but never the account id — render the identity line
                  only when there is one. */}
              {current.connected && current.igId && (
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
        {current.connected && current.webhookRejection && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="font-medium">
                {current.webhookRejection.reason === "bad_signature"
                  ? "Incoming webhooks are being rejected — signature mismatch"
                  : "Incoming webhooks are arriving without stored credentials"}
              </p>
              <p className="mt-0.5 text-amber-700/80 dark:text-amber-400/80">
                {current.webhookRejection.reason === "bad_signature"
                  ? "Meta is sending webhooks we can't verify because the signature doesn't match the stored App secret — incoming messages may be silently dropped. Re-copy the App secret from the Meta App dashboard."
                  : "Meta is delivering webhooks but this channel has no stored credentials to verify them — finish connecting the channel below."}
              </p>
            </div>
          </div>
        )}

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
          {/* PUT THIS ACCOUNT ON A DIFFERENT META APP. One Meta app can serve many
              accounts, and the model has always let an account carry another app's
              credentials — but this form never submitted them, so the capability
              was unreachable. Blank = use the workspace's shared Meta app. */}
          <LabeledInput
            label="App secret (different Meta app, optional)"
            value={form.appSecret}
            onChange={setField("appSecret")}
            placeholder="Leave blank to use your shared Meta App"
            secret
          />
          <LabeledInput
            label="App ID (different Meta app, optional)"
            value={form.appId}
            onChange={setField("appId")}
            placeholder="Leave blank to use your shared Meta App"
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

/**
 * WHAT COMES INTO THE INBOX.
 *
 * Direct messages are the product's core: they are why the channel was connected,
 * so they are shown as a fixed row rather than a switch — there is no state in
 * which an Instagram inbox does not carry DMs, and offering a toggle would imply
 * otherwise.
 *
 * Everything else is OFF until an admin says so. Turning a source on materially
 * changes what this inbox IS for the team — on a busy handle comments outnumber
 * DMs heavily — and that is not a decision a deploy should make for them. The
 * list is driven by `availableInboxSources` from the server, so a channel with no
 * non-DM surface renders nothing and a future source appears here with no change
 * to this file.
 *
 * It cannot be delegated to the Meta dashboard: these webhooks are subscribed per
 * APP, and one app serves every workspace on the shared connection, so
 * unsubscribing there for one admin would blind all the others.
 */
const SOURCE_COPY: Record<InboxSource, { title: string; detail: string }> = {
  comments: {
    title: "Comments on your posts",
    detail:
      "Comments on your posts, reels and ads arrive as conversations. Replying sends Instagram's private reply — one per comment, within 7 days — and the person must answer before normal DMs resume.",
  },
};

function InboxSourcesPanel({
  available,
  initial,
}: {
  available: InboxSource[];
  initial: InboxSource[];
}) {
  const [sources, setSources] = useState<InboxSource[]>(initial);
  const [busy, setBusy] = useState(false);

  if (available.length === 0) return null;

  async function apply(source: InboxSource, on: boolean) {
    const next = on
      ? [...new Set([...sources, source])]
      : sources.filter((s) => s !== source);
    const previous = sources;
    // Optimistic with rollback: this is a preference, and making an admin watch
    // a spinner to learn a checkbox worked is worse than the rare revert.
    setSources(next);
    setBusy(true);
    try {
      const res = await apiFetch("/api/workspace/instagram/inbox-sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The full desired set, not a delta — two admins editing at once then
        // converge on a stated world instead of racing read-modify-write.
        body: JSON.stringify({ sources: next }),
      });
      if (!res.ok) {
        setSources(previous);
        toast.error("Couldn't change that setting.");
        return;
      }
      toast.success(
        on ? "This will now appear in your inbox." : "This will stay out of your inbox.",
      );
    } catch {
      setSources(previous);
      toast.error("Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border bg-card p-5">
      <h2 className="text-sm font-semibold">What comes into the inbox</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Direct messages always do. Anything else is up to you.
      </p>

      <div className="mt-4 flex flex-col gap-3">
        {/* The core, stated rather than offered. */}
        <div className="flex items-start gap-3 rounded-lg bg-muted/40 p-3">
          <Check className="mt-0.5 size-4 shrink-0 text-success-fg" />
          <span className="min-w-0">
            <span className="block text-sm font-medium">Direct messages</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Always on — this is what the channel is for.
            </span>
          </span>
        </div>

        {available.map((source) => (
          <label key={source} className="flex items-start gap-3 px-1">
            <input
              type="checkbox"
              checked={sources.includes(source)}
              disabled={busy}
              onChange={(e) => void apply(source, e.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-primary"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{SOURCE_COPY[source].title}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {SOURCE_COPY[source].detail}
              </span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
