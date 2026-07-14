"use client";

import { useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
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
}

export function WhatsappSettings({
  current,
  canManage,
}: {
  current: WhatsappCurrent;
  canManage: boolean;
}) {
  const softRefresh = useSoftRefresh();
  const params = useSearchParams();
  const expandAdvanced = params.get("expand") === "advanced";
  const { confirm, confirmDialog } = useConfirm();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Open the form by default when there are no creds yet, OR when the stored
  // creds couldn't be decrypted (key rotated / different env), OR when
  // ?expand=advanced sent us here from the templates page.
  const [showForm, setShowForm] = useState(
    !current.connected ||
      Boolean(current.credentialsUndecryptable) ||
      Boolean(current.needsReconnect) ||
      expandAdvanced,
  );

  async function save(form: FormData) {
    setError(null);
    const body = {
      phoneNumberId: form.get("phoneNumberId"),
      // Access token is an optional override (advanced field); the App secret,
      // App ID, and verify token now come from the shared Meta App connection,
      // so this form no longer submits them (sending appSecret:null from the
      // deleted field would 400 against the string|undefined schema).
      accessToken: form.get("accessToken") || undefined,
      // Pass through wabaId even when empty so the server can clear a stale id.
      wabaId: form.get("wabaId") ?? "",
    };
    const res = await apiFetch("/api/team/whatsapp", {
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
    return true;
  }

  async function disconnect() {
    const ok = await confirm({
      title: "Disconnect WhatsApp?",
      description:
        "Your conversations will stay, but no new messages will flow until you reconnect.",
      confirmLabel: "Disconnect",
      destructive: true,
    });
    if (!ok) return;
    const res = await apiFetch("/api/team/whatsapp", { method: "DELETE" });
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

      {canManage && !showForm && (
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => setShowForm(true)}>
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
          pending={pending}
          current={current}
          defaultExpandAdvanced={expandAdvanced}
          onCancel={() => setShowForm(false)}
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
}: {
  pending: boolean;
  current: WhatsappCurrent;
  onSubmit: (form: FormData) => void;
  onCancel?: () => void;
  stepLabel?: string;
  defaultExpandAdvanced?: boolean;
}) {
  const advancedOpen =
    Boolean(current.wabaId || current.appId) || Boolean(defaultExpandAdvanced);
  return (
    <form
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
          {current.connected ? "Update credentials" : "Paste credentials"}
        </div>
        <p className="mt-1 text-2xs text-muted-foreground">
          {current.connected
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
          defaultValue={current.phoneNumberId ?? ""}
          hint="Meta Business Suite → WhatsApp → API Setup → Phone numbers table → Phone number ID column. 15–16 digit number."
        />
        <details
          open={advancedOpen}
          className="mt-3 rounded-md border border-dashed border-border bg-muted/20 p-3 [&_summary::-webkit-details-marker]:hidden"
        >
          <summary className="cursor-pointer text-xs font-medium">
            Templates &amp; advanced (optional)
          </summary>
          <p className="mt-1 mb-3 text-2xs text-muted-foreground">
            The WhatsApp Business Account ID loads your message templates. Leave
            the access token blank to use your Meta App system-user token.
          </p>
          <div className="flex flex-col gap-3">
            <Field
              name="wabaId"
              label="WhatsApp Business Account ID"
              placeholder="e.g. 102290016451234"
              mono
              defaultValue={current.wabaId ?? ""}
              hint="Meta Business Suite → WhatsApp → API Setup → WhatsApp Business Account section → ID under the account name."
            />
            <Field
              name="accessToken"
              label="Access token (override, optional)"
              placeholder="Leave blank to use your Meta App token"
              mono
              secret
              defaultValue=""
              hint="Only to override the shared Meta App system-user token for WhatsApp."
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
