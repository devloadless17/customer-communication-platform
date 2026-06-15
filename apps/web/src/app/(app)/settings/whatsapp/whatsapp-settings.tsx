"use client";

import { useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import {
  AlertTriangle,
  Check,
  Copy,
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
import { toast } from "@/lib/toast";
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
}

export function WhatsappSettings({
  current,
  webhookBaseUrl,
  teamId,
  canManage,
}: {
  current: WhatsappCurrent;
  webhookBaseUrl: string;
  teamId: string;
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
      expandAdvanced,
  );

  // Canonical post-migration path. NestJS owns `/webhooks/*` directly; the
  // legacy `/api/webhooks/meta/{teamId}` proxy stays in place as insurance
  // for subscriptions Meta still has pointed at the old URL — but new
  // installs should always paste this one into the Meta dashboard.
  const webhookUrl = `${webhookBaseUrl}/webhooks/meta/${teamId}`;

  async function save(form: FormData) {
    setError(null);
    const body = {
      phoneNumberId: form.get("phoneNumberId"),
      accessToken: form.get("accessToken"),
      appSecret: form.get("appSecret"),
      // verifyToken is owned by the server — pre-minted on first GET and
      // surfaced in WebhookConfigCard. The form no longer claims ownership.
      // Pass through wabaId/appId even when empty so the server can clear a stale id.
      wabaId: form.get("wabaId") ?? "",
      appId: form.get("appId") ?? "",
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
          <WebhookConfigCard
            webhookUrl={webhookUrl}
            verifyToken={current.verifyToken}
            connected={false}
            stepLabel="Step 1 of 3 · Configure Meta's webhook"
            stepDescription="In Meta Business Suite → WhatsApp → Configuration → Webhook, paste the Callback URL and Verify token below. Subscribe to the messages field. Then come back here."
          />
        )}

        {canManage && (
          <ManualForm
            pending={pending}
            current={current}
            stepLabel="Step 2 of 3 · Paste credentials"
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

      {canManage && (
        <WebhookConfigCard
          webhookUrl={webhookUrl}
          verifyToken={current.verifyToken}
          connected
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
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-xs">
        <div className="font-medium text-amber-700 dark:text-amber-400">
          Not connected
        </div>
        <div className="mt-0.5 text-muted-foreground">
          Follow the two steps below to connect your WhatsApp Business number.
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-xs">
      <div className="flex items-center gap-2">
        <Check className="size-3.5 text-emerald-600" />
        <span className="font-medium text-emerald-700 dark:text-emerald-400">
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
      {showFinalStepHint && (
        <p className="mt-3 border-t border-emerald-500/20 pt-2 text-2xs text-muted-foreground">
          Final check: in Meta → WhatsApp → Configuration, confirm you&apos;ve subscribed
          to the <span className="font-mono">messages</span> field. Without it, no
          incoming messages will arrive.
        </p>
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
        <Field
          name="phoneNumberId"
          label="Phone number ID"
          placeholder="e.g. 1083229888211508"
          required
          defaultValue={current.phoneNumberId ?? ""}
          hint="Meta Business Suite → WhatsApp → API Setup → Phone numbers table → Phone number ID column. 15–16 digit number."
        />
        <Field
          name="accessToken"
          label="Access token"
          placeholder="EAAOK… (long string)"
          required
          mono
          defaultValue={current.accessToken ?? ""}
          hint="Meta Business Suite → WhatsApp → API Setup → Temporary access token (for testing) OR Business Settings → Users → System users to generate a permanent System User token."
        />
        <Field
          name="appSecret"
          label="App secret"
          placeholder="32-character hex string"
          required
          mono
          defaultValue={current.appSecret ?? ""}
          hint="Meta Developers → My Apps → [your app] → App Settings → Basic → App secret, click Show."
        />
        <details
          open={advancedOpen}
          className="mt-3 rounded-md border border-dashed border-border bg-muted/20 p-3 [&_summary::-webkit-details-marker]:hidden"
        >
          <summary className="cursor-pointer text-xs font-medium">
            Templates &amp; advanced (optional)
          </summary>
          <p className="mt-1 mb-3 text-2xs text-muted-foreground">
            WhatsApp Business Account ID is required to load templates. Meta App ID is
            required to upload template header media. Skip both unless you plan to
            use templates.
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
              name="appId"
              label="Meta App ID"
              placeholder="e.g. 1234567890123456"
              mono
              defaultValue={current.appId ?? ""}
              hint="Meta Developers → My Apps → [your app] → top of the dashboard, under the app name."
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
  defaultValue,
  hint,
}: {
  name: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  mono?: boolean;
  defaultValue?: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={name} className="text-xs font-medium text-foreground">
        {label}
      </label>
      <Input
        id={name}
        name={name}
        placeholder={placeholder}
        required={required}
        defaultValue={defaultValue}
        className={mono ? "font-mono text-xs" : ""}
      />
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

function WebhookConfigCard({
  webhookUrl,
  verifyToken,
  connected,
  stepLabel,
  stepDescription,
}: {
  webhookUrl: string;
  verifyToken: string | null;
  connected: boolean;
  stepLabel?: string;
  stepDescription?: string;
}) {
  const description =
    stepDescription ??
    (connected
      ? "Paste these values into Meta → WhatsApp → Configuration → Webhook. Then subscribe to the messages field."
      : "After saving credentials, paste these values into Meta’s webhook configuration.");
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-3">
        {stepLabel && (
          <div className="mb-1 text-3xs font-semibold uppercase tracking-wide text-primary">
            {stepLabel}
          </div>
        )}
        <div className="text-sm font-medium">Configure Meta&apos;s webhook</div>
        <p className="mt-1 text-2xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex flex-col gap-3">
        <ReadonlyField label="Callback URL" value={webhookUrl} />
        <ReadonlyField
          label="Verify token"
          value={verifyToken ?? "— reload to generate —"}
          disabled={!verifyToken}
        />
      </div>
    </div>
  );
}

function ReadonlyField({
  label,
  value,
  disabled,
}: {
  label: string;
  value: string;
  disabled?: boolean;
}) {
  async function copy() {
    if (disabled) return;
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`Copied ${label.toLowerCase()}`);
    } catch {
      toast.error("Couldn't copy", { description: "Select the value above and copy it manually." });
    }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-foreground">{label}</label>
      <div className="flex gap-2">
        <Input
          readOnly
          value={value}
          className={`font-mono text-xs ${disabled ? "opacity-60" : ""}`}
        />
        <Button type="button" variant="outline" onClick={copy} disabled={disabled}>
          <Copy className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
