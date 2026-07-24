"use client";

import { useCallback, useEffect, useState } from "react";
import { BadgeCheck, Loader2, Save, Store } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/api/client-fetch";
import { cn } from "@ccp/shared/utils";

/**
 * The public business profile for a WhatsApp number — what a customer sees when
 * they tap the business name in a chat.
 *
 * It has always been editable in WhatsApp Manager and nowhere else, which meant
 * leaving the product to set the description, address and website customers
 * actually read. This is the same API WhatsApp Manager's own form calls.
 *
 * Loaded lazily on expand: it costs a Graph read per number and almost nobody
 * opens Settings → WhatsApp to look at it.
 */

interface AccountStatus {
  obaStatus?: string;
  waba?: {
    name?: string;
    status?: string;
    currency?: string;
    country?: string;
    businessVerificationStatus?: string;
  };
}

interface Profile {
  about?: string;
  address?: string;
  description?: string;
  email?: string;
  websites?: string[];
  vertical?: string;
  profilePictureUrl?: string;
}

/** Meta's documented cap. It is freeform text — Meta does not geocode it. */
const ADDRESS_MAX = 256;
const ABOUT_MAX = 139;
const DESCRIPTION_MAX = 512;

export function BusinessProfilePanel({
  canManage,
  /** Which number's profile. Omitted = the workspace's default number. */
  accountId,
}: {
  canManage: boolean;
  accountId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [account, setAccount] = useState<AccountStatus | null>(null);

  // Edit state, separate from the loaded profile so Cancel is just a re-sync
  // and a failed save doesn't leave the form showing values Meta rejected.
  const [form, setForm] = useState<Profile>({});

  const query = accountId ? `?accountId=${encodeURIComponent(accountId)}` : "";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/workspace/whatsapp/profile${query}`);
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string; detail?: string }
          | null;
        throw new Error(
          [data?.error, data?.detail].filter(Boolean).join(": ") || `HTTP ${res.status}`,
        );
      }
      const data = (await res.json()) as { profile: Profile };
      setProfile(data.profile);
      setForm(data.profile);
      // Best-effort and separate: OBA/WABA standing is context, not the point of
      // the panel, so a token that can't read it must not break the editor.
      const statusRes = await apiFetch(
        `/api/workspace/whatsapp/account-status${query}`,
      );
      if (statusRes.ok) setAccount((await statusRes.json()) as AccountStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load the profile");
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    if (open && profile === null && !loading) void load();
  }, [open, profile, loading, load]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // Send only what CHANGED. Meta treats an empty string as "clear this
      // field", so posting the whole form would rewrite every field on every
      // save — turning a typo in one input into a wipe of another.
      const patch: Record<string, unknown> = {};
      for (const key of ["about", "address", "description", "email"] as const) {
        if ((form[key] ?? "") !== (profile?.[key] ?? "")) patch[key] = form[key] ?? "";
      }
      const before = (profile?.websites ?? []).join(",");
      const after = (form.websites ?? []).filter(Boolean).join(",");
      if (before !== after) patch.websites = (form.websites ?? []).filter(Boolean);

      if (Object.keys(patch).length === 0) {
        toast.info("Nothing changed");
        return;
      }
      const res = await apiFetch(`/api/workspace/whatsapp/profile${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string; detail?: string }
          | null;
        throw new Error(
          [data?.error, data?.detail].filter(Boolean).join(": ") || `HTTP ${res.status}`,
        );
      }
      // The server reads the profile back from Meta rather than echoing what we
      // sent, so this is what Meta actually stored.
      const data = (await res.json()) as { profile: Profile };
      setProfile(data.profile);
      setForm(data.profile);
      toast.success("Business profile updated");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the profile");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <div className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Store className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Business profile</div>
          <div className="text-2xs text-muted-foreground">
            What customers see when they tap your business name
          </div>
        </div>
        {loading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      </button>

      {open && (
        <div className="border-t border-border px-4 py-4">
          {error && (
            <p className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}

          {account && (account.obaStatus || account.waba) && (
            <div className="mb-4 rounded-lg border border-border bg-muted/20 px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-xs font-medium">
                <BadgeCheck className="size-3.5 text-muted-foreground" />
                Official Business Account
                {account.obaStatus && (
                  <span className="font-mono text-2xs text-muted-foreground">
                    {account.obaStatus}
                  </span>
                )}
              </div>
              {/* The consequence nobody knows: without OBA your number doesn't
                  come up in WhatsApp search unless the customer has already
                  saved it. That is the reason to care, so it leads. */}
              <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">
                An OBA gets a blue checkmark and makes your number findable in
                WhatsApp search — without one, customers only see your name if
                they&apos;ve already saved the number.
              </p>
              <ul className="mt-2 flex flex-col gap-0.5 text-2xs text-muted-foreground">
                <li>
                  Business verification:{" "}
                  <span className="font-medium">
                    {account.waba?.businessVerificationStatus ?? "unknown"}
                  </span>
                </li>
                <li>Registered on WhatsApp for at least 30 days</li>
                <li>Two-step verification enabled on the number</li>
                <li>Display name approved</li>
              </ul>
              <p className="mt-2 text-2xs text-muted-foreground">
                {/* Meta publishes a wire shape for READING the status and none
                    for making the request, so we link out rather than pretend
                    to submit one. A denial locks you out for 30 days. */}
                Requests are submitted in WhatsApp Manager (Phone numbers →
                Profile). A denied request can&apos;t be resubmitted for 30 days.
              </p>
              {account.waba && (
                <p className="mt-2 text-2xs text-muted-foreground">
                  WABA{account.waba.name ? ` “${account.waba.name}”` : ""}
                  {account.waba.status ? ` · ${account.waba.status}` : ""}
                  {account.waba.country ? ` · ${account.waba.country}` : ""}
                  {account.waba.currency ? ` · ${account.waba.currency}` : ""}
                </p>
              )}
            </div>
          )}

          {profile && (
            <div className="flex flex-col gap-3">
              <Field
                label="About"
                hint="The short line under your name."
                value={form.about ?? ""}
                max={ABOUT_MAX}
                disabled={!canManage}
                onChange={(v) => setForm((f) => ({ ...f, about: v }))}
              />
              <div className="flex flex-col gap-1">
                <label className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                  Description
                </label>
                <Textarea
                  value={form.description ?? ""}
                  disabled={!canManage}
                  rows={3}
                  maxLength={DESCRIPTION_MAX}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  className="text-sm"
                />
                <Counter n={(form.description ?? "").length} max={DESCRIPTION_MAX} />
              </div>
              <Field
                label="Address"
                hint="Freeform — WhatsApp doesn't check it against a map."
                value={form.address ?? ""}
                max={ADDRESS_MAX}
                disabled={!canManage}
                onChange={(v) => setForm((f) => ({ ...f, address: v }))}
              />
              <Field
                label="Email"
                value={form.email ?? ""}
                disabled={!canManage}
                onChange={(v) => setForm((f) => ({ ...f, email: v }))}
              />
              <Field
                label="Website"
                value={form.websites?.[0] ?? ""}
                disabled={!canManage}
                onChange={(v) =>
                  setForm((f) => ({
                    ...f,
                    websites: v ? [v, ...(f.websites ?? []).slice(1)] : (f.websites ?? []).slice(1),
                  }))
                }
              />
              <Field
                label="Second website (optional)"
                value={form.websites?.[1] ?? ""}
                disabled={!canManage}
                onChange={(v) =>
                  setForm((f) => {
                    const first = f.websites?.[0] ?? "";
                    return { ...f, websites: v ? [first, v] : first ? [first] : [] };
                  })
                }
              />

              {/* Read-only. Meta doesn't publish the WhatsAppVertical members in
                  the profile reference, and writing a guessed value would either
                  be rejected or silently set the wrong industry. */}
              {profile.vertical && (
                <p className="text-2xs text-muted-foreground">
                  Industry: <span className="font-medium">{profile.vertical}</span> —
                  change it in WhatsApp Manager.
                </p>
              )}

              {canManage && (
                <div className="flex items-center gap-2 pt-1">
                  <Button type="button" size="sm" onClick={() => void save()} disabled={saving}>
                    {saving ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Save className="size-3.5" />
                    )}
                    Save profile
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={saving}
                    onClick={() => setForm(profile)}
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Field({
  label,
  hint,
  value,
  max,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  max?: number;
  disabled: boolean;
  onChange: (next: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </label>
      <Input
        value={value}
        disabled={disabled}
        maxLength={max}
        onChange={(e) => onChange(e.target.value)}
        className="text-sm"
      />
      {hint && <p className="text-2xs text-muted-foreground">{hint}</p>}
      {max !== undefined && <Counter n={value.length} max={max} />}
    </div>
  );
}

function Counter({ n, max }: { n: number; max: number }) {
  return (
    <p className={cn("text-2xs text-muted-foreground", n > max && "text-destructive")}>
      {n}/{max}
    </p>
  );
}
