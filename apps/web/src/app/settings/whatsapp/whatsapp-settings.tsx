"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
  const router = useRouter();
  const { confirm, confirmDialog } = useConfirm();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Open the form by default when there are no creds yet, OR when the stored
  // creds couldn't be decrypted (key rotated / different env) — the admin
  // needs to re-paste in both cases.
  const [showForm, setShowForm] = useState(
    !current.connected || Boolean(current.credentialsUndecryptable),
  );

  const webhookUrl = `${webhookBaseUrl}/api/webhooks/meta/${teamId}`;

  async function save(form: FormData) {
    setError(null);
    const body = {
      phoneNumberId: form.get("phoneNumberId"),
      accessToken: form.get("accessToken"),
      appSecret: form.get("appSecret"),
      verifyToken: form.get("verifyToken") || undefined,
      // Pass through even when empty so the server can clear a stale id.
      wabaId: form.get("wabaId") ?? "",
      appId: form.get("appId") ?? "",
    };
    const res = await fetch("/api/team/whatsapp", {
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
    const res = await fetch("/api/team/whatsapp", { method: "DELETE" });
    if (!res.ok) {
      setError("Failed to disconnect");
      return;
    }
    router.refresh();
    setShowForm(true);
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">WhatsApp connection</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect your WhatsApp Business number through Meta&apos;s Cloud API. Your team
          can&apos;t send or receive messages until this is configured.
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <div className="wrap-break-word">{error}</div>
        </div>
      )}

      <ConnectionStatus current={current} />

      {/* Embedded Signup placeholder — Tech Provider review pending. */}
      <div className="rounded-xl border border-dashed border-border bg-muted/30 p-5">
        <div className="flex items-start gap-3">
          <ExternalLink className="mt-0.5 size-5 text-muted-foreground" />
          <div className="flex-1">
            <div className="text-sm font-medium">Connect with Facebook</div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              One-click WhatsApp Embedded Signup. Enabled once Meta approves Loadless as
              a Tech Provider (business verification + app review). Until then, use
              manual setup below.
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

      {canManage && current.connected && !showForm && (
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
          onCancel={current.connected ? () => setShowForm(false) : undefined}
          onSubmit={(form) =>
            startTransition(async () => {
              const ok = await save(form);
              if (ok) {
                setShowForm(false);
                router.refresh();
              }
            })
          }
        />
      )}

      {canManage && (
        <WebhookConfigCard
          webhookUrl={webhookUrl}
          verifyToken={current.verifyToken}
          connected={current.connected}
        />
      )}

      {!canManage && (
        <p className="text-xs text-muted-foreground">
          Only admins can change the WhatsApp connection.
        </p>
      )}
      {confirmDialog}
    </div>
  );
}

function ConnectionStatus({ current }: { current: WhatsappCurrent }) {
  if (!current.connected) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-xs">
        <div className="font-medium text-amber-700 dark:text-amber-400">
          Not connected
        </div>
        <div className="mt-0.5 text-muted-foreground">
          Paste your Meta credentials below to start sending and receiving messages.
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
        <dd className="font-mono">{current.phoneNumberId}</dd>
        {current.wabaId && (
          <>
            <dt>WABA id</dt>
            <dd className="font-mono">{current.wabaId}</dd>
          </>
        )}
        {current.appId && (
          <>
            <dt>App id</dt>
            <dd className="font-mono">{current.appId}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

function ManualForm({
  pending,
  current,
  onSubmit,
  onCancel,
}: {
  pending: boolean;
  current: WhatsappCurrent;
  onSubmit: (form: FormData) => void;
  onCancel?: () => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(new FormData(e.currentTarget));
      }}
      className="rounded-xl border border-border bg-card p-5"
    >
      <div className="mb-4">
        <div className="text-sm font-medium">
          {current.connected ? "Update credentials" : "Manual setup"}
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {current.connected
            ? "Edit any field and save. Unchanged fields keep their current value."
            : "From Meta’s Business dashboard → WhatsApp → API Setup."}{" "}
          <a
            className="text-primary hover:underline"
            href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
            target="_blank"
            rel="noreferrer"
          >
            Meta&apos;s guide
          </a>
          .
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <Field
          name="phoneNumberId"
          label="Phone number ID"
          placeholder="e.g. 1083229888211508"
          required
          defaultValue={current.phoneNumberId ?? ""}
        />
        <Field
          name="accessToken"
          label="Access token"
          placeholder="EAAOK… (long string)"
          required
          mono
          defaultValue={current.accessToken ?? ""}
        />
        <Field
          name="appSecret"
          label="App secret"
          placeholder="32-character hex string"
          required
          mono
          defaultValue={current.appSecret ?? ""}
        />
        <Field
          name="wabaId"
          label="WhatsApp Business Account ID (optional — needed for templates)"
          placeholder="e.g. 102290016451234"
          mono
          defaultValue={current.wabaId ?? ""}
        />
        <Field
          name="appId"
          label="Meta App ID (optional — needed to upload media template headers)"
          placeholder="e.g. 1234567890123456"
          mono
          defaultValue={current.appId ?? ""}
        />
        <Field
          name="verifyToken"
          label={
            current.connected
              ? "Verify token"
              : "Verify token (optional — auto-generated if blank)"
          }
          placeholder={current.connected ? "" : "Leave blank to auto-generate"}
          defaultValue={current.verifyToken ?? ""}
        />
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
      <p className="mt-3 text-[11px] text-muted-foreground">
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
}: {
  name: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  mono?: boolean;
  defaultValue?: string;
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
    </div>
  );
}

function WebhookConfigCard({
  webhookUrl,
  verifyToken,
  connected,
}: {
  webhookUrl: string;
  verifyToken: string | null;
  connected: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-3">
        <div className="text-sm font-medium">Configure Meta&apos;s webhook</div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {connected
            ? "Paste these values into Meta → WhatsApp → Configuration → Webhook. Then subscribe to the messages field."
            : "After saving credentials, paste these values into Meta&apos;s webhook configuration."}
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <ReadonlyField label="Callback URL" value={webhookUrl} />
        <ReadonlyField
          label="Verify token"
          value={verifyToken ?? "— save credentials first —"}
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
