"use client";

import { useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { cn } from "@ccp/shared/utils";
import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import {
  AlertTriangle,
  Check,
  Eye,
  EyeOff,
  ExternalLink,
  Loader2,
  PlugZap,
  Unplug,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/layouts/page-header";
import { apiFetch } from "@/lib/api/client-fetch";
import type { ChannelAccountView } from "@/lib/api/queries";
import { ChannelAccountsPanel } from "@/features/channels/components/channel-accounts-panel";
import {
  channelDisconnectCopy,
  fetchChannelRemovalImpact,
} from "@/features/channels/lib/channel-disconnect";
import { CallingSettings } from "@/features/settings/components/whatsapp/calling-settings";
import { MessagingHealthPanel } from "@/features/settings/components/whatsapp/messaging-health-panel";
import { BusinessProfilePanel } from "@/features/settings/components/whatsapp/business-profile-panel";
import { QrCodesPanel } from "@/features/settings/components/whatsapp/qr-codes-panel";
import { UsernamePanel } from "@/features/settings/components/whatsapp/username-panel";
import { formatPhone } from "@ccp/shared/utils";

export interface WhatsappCurrent {
  connected: boolean;
  phoneNumberId: string | null;
  displayNumber: string | null;
  wabaId: string | null;
  appId: string | null;
  verifyToken: string | null;
  // Pre-fills the update form so admins can see what's stored and edit
  // selectively. Only ever rendered to admins viewing their own team.
  accessToken: string | null;
  appSecret: string | null;
  // True when a stored secret exists but couldn't be decrypted (most often
  // ENCRYPTION_KEY changed between write and read). The form is shown empty
  // and the banner tells the admin to re-paste from Meta.
  credentialsUndecryptable?: boolean;
  /** Set when a send failed with Graph 190 — the token expired/was revoked. */
  needsReconnect?: boolean;
  /** WhatsApp messaging-limit tier + health — how many unique customers/24h this
   *  number may message, its quality band, and throughput level. Null until polled. */
  messagingTier?: string | null;
  messagingDailyCap?: number | null;
  qualityRating?: string | null;
  throughputLevel?: string | null;
}

export function WhatsappSettings({
  current,
  canManage,
  accounts,
}: {
  current: WhatsappCurrent;
  canManage: boolean;
  /** Every WhatsApp number this workspace has connected. Rendered by
   *  ChannelAccountsPanel below `ConnectionStatus`, which reports only the
   *  DEFAULT number. */
  accounts: ChannelAccountView[];
}) {
  const softRefresh = useSoftRefresh();
  const params = useSearchParams();
  const expandAdvanced = params.get("expand") === "advanced";
  const { confirm, confirmDialog } = useConfirm();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Non-fatal connect problems the server found (unverified WABA ownership,
  // unregistered number, declined display name, unsubscribed WABA). The save
  // SUCCEEDED — these are the "will bite later" list, and the admin at this
  // form is the one person who can act on them.
  const [warnings, setWarnings] = useState<string[]>([]);
  // Which number the per-number panels (health / profile / QR) describe.
  // Null = untouched → the default account. Only meaningful with >1 number;
  // a single-number workspace keeps the legacy "no accountId" requests.
  const [settingsAccountId, setSettingsAccountId] = useState<string | null>(null);
  const defaultAccountId =
    accounts.find((a) => a.isDefault)?.id ?? accounts[0]?.id ?? null;
  const activeSettingsAccountId =
    accounts.length > 1
      ? // A stale selection (number since removed) falls back to the default.
        (accounts.some((a) => a.id === settingsAccountId)
          ? settingsAccountId
          : defaultAccountId)
      : null;
  const activeSettingsAccount =
    accounts.find((a) => a.id === activeSettingsAccountId) ?? null;
  // Open the form by default when there are no creds yet, OR when the stored
  // creds couldn't be decrypted (key rotated / different env), OR when
  // ?expand=advanced sent us here from the templates page.
  const [showForm, setShowForm] = useState(
    !current.connected ||
      Boolean(current.credentialsUndecryptable) ||
      Boolean(current.needsReconnect) ||
      expandAdvanced,
  );
  // ADD vs UPDATE. The same form serves both (it upserts on phone-number id),
  // but its fields are prefilled from `current` — which is the DEFAULT number.
  // Prefilling an ADD would hand the admin number 1's WABA id under a heading
  // that says "unchanged fields keep their current value", so "Add another"
  // opens it blank instead.
  const [addingAccount, setAddingAccount] = useState(false);

  async function save(form: FormData) {
    setError(null);
    setWarnings([]);
    const body = {
      phoneNumberId: form.get("phoneNumberId"),
      // Access token is an optional override (advanced field); the App secret,
      // App ID, and verify token now come from the shared Meta App connection,
      // so this form no longer submits them (sending appSecret:null from the
      // deleted field would 400 against the string|undefined schema).
      accessToken: form.get("accessToken") || undefined,
      // Per-account Meta app override. `|| undefined` (never null/"") is
      // load-bearing twice over: the schema is `string | undefined`, so an empty
      // field must be ABSENT rather than empty — and absent is also what the
      // server reads as "keep whatever this row already has", so re-saving a
      // number that is already on its own app doesn't silently reset it to the
      // shared app just because the admin left the secret box blank.
      appSecret: form.get("appSecret") || undefined,
      appId: form.get("appId") || undefined,
      // Required (templates are per-WABA) — the field is `required` in the
      // form, and the server 400s on empty, so this is never blank in practice.
      wabaId: form.get("wabaId") ?? "",
    };
    const res = await apiFetch("/api/workspace/whatsapp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
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
    const ok = (await res.json().catch(() => ({}))) as { warnings?: string[] };
    if (Array.isArray(ok.warnings) && ok.warnings.length > 0) {
      setWarnings(ok.warnings.filter((w): w is string => typeof w === "string"));
    }
    return true;
  }

  async function disconnect() {
    // Read the blast radius FIRST. This page already said "EVERY number", but
    // not how many, nor how many live threads and scheduled campaigns it
    // strands — and both pointers are `onDelete: SetNull`, so the next reply on
    // each of those threads fails `account-unresolved`.
    const impact = await fetchChannelRemovalImpact("whatsapp");
    const { description, confirmLabel } = channelDisconnectCopy(
      "number",
      "numbers",
      impact,
    );
    const ok = await confirm({
      title: "Disconnect WhatsApp?",
      description,
      confirmLabel,
      destructive: true,
    });
    if (!ok) return;
    // The server refuses an unconfirmed multi-account disconnect (409); the
    // dialog above IS that confirmation.
    const res = await apiFetch("/api/workspace/whatsapp?confirmAll=1", { method: "DELETE" });
    if (!res.ok) {
      setError("Failed to disconnect");
      return;
    }
    softRefresh();
    setShowForm(true);
  }

  const header = (
    <>
      <PageHeader
        title="WhatsApp"
        description="Connect your WhatsApp Business number through Meta's Cloud API. Your team can't send or receive messages until this is configured."
      />

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <div className="wrap-break-word">{error}</div>
        </div>
      )}

      {warnings.length > 0 && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <div className="flex flex-col gap-1">
            <div className="font-medium">Connected, with things to fix:</div>
            {warnings.map((w) => (
              <div key={w} className="wrap-break-word">
                {w}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );

  const embeddedSignupCard = (
    <div className="rounded-xl border border-dashed border-border bg-muted/30 p-5">
      <div className="flex items-start gap-3">
        <ExternalLink className="mt-0.5 size-5 text-muted-foreground" />
        <div className="flex-1">
          <div className="text-sm font-medium">Connect with Facebook</div>
          <p className="mt-1 text-2xs text-muted-foreground">
            One-click WhatsApp Embedded Signup. Enabled once Meta approves Loadless as
            a Tech Provider (business verification + app review). Until then, use
            manual setup above.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled
          title="Available once Meta approves the Tech Provider application"
        >
          Coming soon
        </Button>
      </div>
    </div>
  );

  // Disconnected layout: ordered Step 1 → Step 2 sequence so the admin
  // sets up the Meta side BEFORE pasting creds. Step 3 is implied by the
  // post-save connected layout (router.refresh flips us over).
  if (!current.connected) {
    return (
      <div className="flex flex-col gap-8">
        {header}
        <ConnectionStatus current={current} />

        {canManage && (
          <ManualForm
            pending={pending}
            current={current}
            defaultExpandAdvanced={expandAdvanced}
            onSubmit={(form) =>
              startTransition(async () => {
                const ok = await save(form);
                if (ok) {
                  setShowForm(false);
                  softRefresh();
                }
              })
            }
          />
        )}

        {!canManage && (
          <p className="text-xs text-muted-foreground">
            Only admins can change the WhatsApp connection.
          </p>
        )}

        {embeddedSignupCard}
        {confirmDialog}
      </div>
    );
  }

  // Connected layout: today's ordering preserved so returning admins land
  // on the familiar page. ConnectionStatus picks up an extra one-line
  // reminder to confirm the webhook subscription.
  return (
    <div className="flex flex-col gap-8">
      {header}
      <ConnectionStatus current={current} showFinalStepHint />

      {/* Which numbers this workspace actually holds. ConnectionStatus above
          reports the DEFAULT one only, so without this a workspace running two
          numbers had no surface that said so. */}
      {canManage && (
        <ChannelAccountsPanel
          channel="whatsapp"
          accounts={accounts}
          channelLabel="WhatsApp"
          accountNoun="number"
          onAddAnother={() => {
            setAddingAccount(true);
            setShowForm(true);
            requestAnimationFrame(() => {
              document
                .getElementById("whatsapp-connect-form")
                ?.scrollIntoView({ behavior: "smooth", block: "center" });
            });
          }}
        />
      )}

      {/* Per-number panel scope. Health, profile and QR codes all belong to ONE
          number; with several connected, these chips pick which one the three
          panels below describe. Hidden for the single-number workspace (the
          only account is the scope). */}
      {accounts.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            Showing
          </span>
          {accounts.map((a) => {
            const active = a.id === (settingsAccountId ?? defaultAccountId);
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => setSettingsAccountId(a.id)}
                className={
                  "rounded-full border px-3 py-1 text-xs transition " +
                  (active
                    ? "border-primary bg-primary/10 font-medium text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground")
                }
              >
                {a.label ?? a.displayPhoneNumber ?? a.externalAccountId}
                {a.isDefault ? " · default" : ""}
              </button>
            );
          })}
        </div>
      )}

      {/* Only meaningful once connected — an unconnected number has no tier,
          no quality rating and no budget to report. `key` remounts the panels
          on switch so no stale figures linger while the next account loads. */}
      <MessagingHealthPanel
        key={`health-${activeSettingsAccountId ?? "default"}`}
        canManage={canManage}
        accountCount={accounts.length}
        accountId={activeSettingsAccountId}
        accountName={
          activeSettingsAccount
            ? activeSettingsAccount.label ??
              activeSettingsAccount.displayPhoneNumber ??
              activeSettingsAccount.externalAccountId
            : null
        }
      />

      {/* The number's public profile. Only shown once connected — there is no
          profile to read before Meta knows the number. */}
      {current.connected && (
        <BusinessProfilePanel
          key={`profile-${activeSettingsAccountId ?? "default"}`}
          canManage={canManage}
          accountId={activeSettingsAccountId ?? undefined}
        />
      )}

      {/* The number's @username — like the profile, it lives on the phone
          number, so it is connected-only and follows the same account chips. */}
      {current.connected && (
        <UsernamePanel
          key={`username-${activeSettingsAccountId ?? "default"}`}
          canManage={canManage}
          accountId={activeSettingsAccountId ?? undefined}
        />
      )}

      {/* Also connected-only: the codes live on the phone number. */}
      {current.connected && (
        <QrCodesPanel
          key={`qr-${activeSettingsAccountId ?? "default"}`}
          canManage={canManage}
          accountId={activeSettingsAccountId ?? undefined}
        />
      )}

      {canManage && !showForm && (
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setAddingAccount(false);
              setShowForm(true);
            }}
          >
            <PlugZap className="size-4" />
            Update credentials
          </Button>
          <Button type="button" variant="outline" onClick={disconnect}>
            <Unplug className="size-4" />
            Disconnect
          </Button>
        </div>
      )}

      {canManage && showForm && (
        <ManualForm
          // Uncontrolled inputs read `defaultValue` once, so flipping add/update
          // has to remount the form or the stale prefill survives the switch.
          key={addingAccount ? "add" : "update"}
          pending={pending}
          current={current}
          addMode={addingAccount}
          defaultExpandAdvanced={expandAdvanced}
          onCancel={() => {
            setShowForm(false);
            setAddingAccount(false);
          }}
          onSubmit={(form) =>
            startTransition(async () => {
              const ok = await save(form);
              if (ok) {
                setShowForm(false);
                setAddingAccount(false);
                softRefresh();
              }
            })
          }
        />
      )}

      {!canManage && (
        <p className="text-xs text-muted-foreground">
          Only admins can change the WhatsApp connection.
        </p>
      )}

      {/* Calling lives on the same number and is configured against the same
          connection, so it belongs on this page rather than a separate one.
          Renders nothing until WhatsApp is connected. */}
      {current.connected && (
        <CallingSettings
          key={`calling-${activeSettingsAccountId ?? "default"}`}
          displayNumber={current.displayNumber}
          canManage={canManage}
          accountId={activeSettingsAccountId ?? undefined}
        />
      )}

      {embeddedSignupCard}
      {confirmDialog}
    </div>
  );
}

function ConnectionStatus({
  current,
  showFinalStepHint,
}: {
  current: WhatsappCurrent;
  showFinalStepHint?: boolean;
}) {
  if (!current.connected) {
    return (
      <div className="rounded-xl border border-warning-border bg-warning-bg p-4 text-xs">
        <div className="font-medium text-warning-fg">
          Not connected
        </div>
        <div className="mt-0.5 text-muted-foreground">
          Follow the two steps below to connect your WhatsApp Business number.
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-success-border bg-success-bg p-4 text-xs">
      <div className="flex items-center gap-2">
        <Check className="size-3.5 text-success-fg" />
        <span className="font-medium text-success-fg">
          Connected
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-[120px_1fr] gap-x-3 gap-y-1 text-muted-foreground">
        {current.displayNumber && (
          <>
            <dt>Phone number</dt>
            <dd className="font-mono text-foreground">{formatPhone(current.displayNumber)}</dd>
          </>
        )}
        <dt>Phone number id</dt>
        <dd className="min-w-0 break-all font-mono">{current.phoneNumberId}</dd>
        {current.wabaId && (
          <>
            <dt>WABA id</dt>
            <dd className="min-w-0 break-all font-mono">{current.wabaId}</dd>
          </>
        )}
        {current.appId && (
          <>
            <dt>App id</dt>
            <dd className="min-w-0 break-all font-mono">{current.appId}</dd>
          </>
        )}
        {current.messagingTier && (
          <>
            <dt>Messaging limit</dt>
            <dd className="min-w-0 text-foreground">
              {current.messagingDailyCap != null
                ? `${current.messagingDailyCap.toLocaleString()} customers / 24h`
                : current.messagingTier === "TIER_UNLIMITED"
                  ? "Unlimited"
                  : "Not assigned yet"}
              {current.qualityRating && (
                <span
                  className={cn(
                    "ml-2 rounded-full border px-1.5 py-0.5 text-2xs font-medium",
                    current.qualityRating === "GREEN" &&
                      "border-success-border bg-success-bg text-success-fg",
                    current.qualityRating === "YELLOW" &&
                      "border-warning-border bg-warning-bg text-warning-fg",
                    current.qualityRating === "RED" &&
                      "border-destructive/30 bg-destructive/10 text-destructive",
                  )}
                >
                  {current.qualityRating} quality
                </span>
              )}
            </dd>
          </>
        )}
      </dl>
      {current.needsReconnect && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">Access token expired — reconnect to keep sending</p>
            <p className="mt-0.5 text-amber-700/80 dark:text-amber-400/80">
              Meta rejected the last send because the token was revoked or expired.
              Inbound messages still arrive, but replies will fail until you re-enter
              a valid token below.
            </p>
          </div>
        </div>
      )}
      {showFinalStepHint && (
        <>
          <p className="mt-3 border-t border-success-border pt-2 text-2xs text-muted-foreground">
            Final check: in Meta → WhatsApp → Configuration, confirm you&apos;ve subscribed
            to the <span className="font-mono">messages</span> field. Without it, no
            incoming messages will arrive.
          </p>
          <p className="mt-2 text-2xs text-muted-foreground">
            Using this number on your phone too (Coexistence)? Also subscribe to{" "}
            <span className="font-mono">smb_message_echoes</span>,{" "}
            <span className="font-mono">history</span>, and{" "}
            <span className="font-mono">smb_app_state_sync</span> so replies you send
            from the WhatsApp Business App, your past chats, and your saved contact
            names all sync into the inbox.
          </p>
        </>
      )}
    </div>
  );
}

function ManualForm({
  pending,
  current,
  onSubmit,
  onCancel,
  stepLabel,
  defaultExpandAdvanced,
  addMode,
}: {
  pending: boolean;
  current: WhatsappCurrent;
  onSubmit: (form: FormData) => void;
  onCancel?: () => void;
  stepLabel?: string;
  defaultExpandAdvanced?: boolean;
  /** Adding an ADDITIONAL number rather than editing the default one: start
   *  blank, since every prefilled value belongs to a different number. */
  addMode?: boolean;
}) {
  const advancedOpen = Boolean(current.appId) || Boolean(defaultExpandAdvanced);
  return (
    <form
      id="whatsapp-connect-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(new FormData(e.currentTarget));
      }}
      className="rounded-xl border border-border bg-card p-5"
    >
      <div className="mb-4">
        {stepLabel && (
          <div className="mb-1 text-3xs font-semibold uppercase tracking-wide text-primary">
            {stepLabel}
          </div>
        )}
        <div className="text-sm font-medium">
          {addMode
            ? "Add another number"
            : current.connected
              ? "Update credentials"
              : "Paste credentials"}
        </div>
        <p className="mt-1 text-2xs text-muted-foreground">
          {addMode
            ? "Paste the IDs for the NEW number. If it sits under a different WhatsApp Business Account, give it that WABA id — templates are per-WABA."
            : current.connected
              ? "Edit any field and save. Unchanged fields keep their current value."
              : "From Meta’s Business dashboard → WhatsApp → API Setup."}
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <p className="rounded-md bg-muted px-3 py-2 text-2xs text-muted-foreground">
          The App secret, App ID, access token, and webhook verify token come
          from your{" "}
          <a href="/settings/meta" className="underline">
            Meta App
          </a>{" "}
          connection — WhatsApp just needs its own phone number.
        </p>
        <Field
          name="phoneNumberId"
          label="Phone number ID"
          placeholder="e.g. 1083229888211508"
          required
          defaultValue={addMode ? "" : (current.phoneNumberId ?? "")}
          hint="Meta Business Suite → WhatsApp → API Setup → Phone numbers table → Phone number ID column. 15–16 digit number."
        />
        {/* Required, and shown as such: the server refuses a connection without
            it (templates, subscription health, and the cross-account send guard
            are all per-WABA). It used to sit inside the collapsed "advanced"
            section labelled optional, so a first-time admin skipped it and hit
            a 400 on submit. */}
        <Field
          name="wabaId"
          label="WhatsApp Business Account ID"
          placeholder="e.g. 102290016451234"
          required
          mono
          defaultValue={addMode ? "" : (current.wabaId ?? "")}
          hint="Meta Business Suite → WhatsApp → API Setup → WhatsApp Business Account section → ID under the account name. Templates are per-WABA, so we need it to load yours."
        />
        <details
          open={advancedOpen}
          className="mt-3 rounded-md border border-dashed border-border bg-muted/20 p-3 [&_summary::-webkit-details-marker]:hidden"
        >
          <summary className="cursor-pointer text-xs font-medium">
            Advanced (optional)
          </summary>
          <p className="mt-1 mb-3 text-2xs text-muted-foreground">
            Leave the access token blank to use your Meta App system-user token.
          </p>
          <div className="flex flex-col gap-3">
            <Field
              name="accessToken"
              label="Access token (override, optional)"
              placeholder="Leave blank to use your Meta App token"
              mono
              secret
              defaultValue=""
              hint="Only to override the shared Meta App system-user token for WhatsApp."
            />
            {/* PUT THIS NUMBER ON A DIFFERENT META APP.
                Meta's model is one app ↔ many accounts, and the data model has
                always allowed an account to carry another app's credentials — but
                this form stopped submitting them, so the capability existed
                everywhere except where an admin could reach it. That is why "what
                if I want to add another Meta app?" had no answer in-product.
                Both fields together, because a secret from app A with app B's id
                is not a coherent account. */}
            <Field
              name="appSecret"
              label="App secret (different Meta app, optional)"
              placeholder="Leave blank to use your shared Meta App"
              mono
              secret
              defaultValue=""
              hint="Only if this number lives under a DIFFERENT Meta app than the rest of your workspace. Meta signs this number's webhooks with this secret, and rotating the shared app's secret will no longer affect it."
            />
            <Field
              name="appId"
              label="App ID (different Meta app, optional)"
              placeholder="Leave blank to use your shared Meta App"
              mono
              defaultValue={addMode ? "" : (current.appId ?? "")}
              hint="The App ID that goes with the secret above — shown next to this number in Settings → Meta App so you can tell your apps apart."
            />
          </div>
        </details>
      </div>
      <div className="mt-5 flex items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
          Validate &amp; save
        </Button>
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      <p className="mt-3 text-2xs text-muted-foreground">
        We call Meta with these credentials to verify them before saving. Nothing is stored
        if validation fails.
      </p>
    </form>
  );
}

function Field({
  name,
  label,
  placeholder,
  required,
  mono,
  secret,
  defaultValue,
  hint,
}: {
  name: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  mono?: boolean;
  secret?: boolean;
  defaultValue?: string;
  hint?: string;
}) {
  const [reveal, setReveal] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={name} className="text-xs font-medium text-foreground">
        {label}
      </label>
      {secret ? (
        <div className="relative">
          <Input
            id={name}
            name={name}
            type={reveal ? "text" : "password"}
            placeholder={placeholder}
            required={required}
            defaultValue={defaultValue}
            className={`pr-9 ${mono ? "font-mono text-xs" : ""}`}
          />
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
            title={reveal ? "Hide" : "Show"}
            tabIndex={-1}
          >
            {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      ) : (
        <Input
          id={name}
          name={name}
          placeholder={placeholder}
          required={required}
          defaultValue={defaultValue}
          className={mono ? "font-mono text-xs" : ""}
        />
      )}
      {hint && (
        <details className="[&_summary::-webkit-details-marker]:hidden">
          <summary className="cursor-pointer text-2xs text-muted-foreground hover:text-foreground">
            Where do I find this?
          </summary>
          <p className="mt-1 text-2xs text-muted-foreground">{hint}</p>
        </details>
      )}
    </div>
  );
}
