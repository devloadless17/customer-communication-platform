"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { Check, Copy, Eye, EyeOff, KeyRound, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client-fetch";
import { apiErrorMessage } from "@ccp/shared/api/error-message";
import { toast } from "@/lib/toast";
import { MIN_PASSWORD_LENGTH } from "@ccp/shared/auth/password-policy";

/**
 * Admin-initiated password reset dialog. The only recovery path in the app —
 * there's no self-serve email reset (no mail provider by design). An admin
 * sets a new password for a locked-out teammate, then shares it out-of-band.
 *
 * The caller passes the endpoint (today only the members-settings list, via
 * `/api/users/:id/reset-password`). The cross-tenant superAdmin reset route
 * this dialog once also served was deliberately REMOVED — an operator choosing
 * a customer's credential was indefensible; auth-recovery.spec.ts asserts it
 * stays gone. The server hashes with the same bcrypt path Better Auth
 * verifies against and signs the target out of every device.
 *
 * Two phases:
 *   1. Compose — type or generate a password (≥ MIN_PASSWORD_LENGTH).
 *   2. Done — the saved password is shown once, copyable, with a clear note
 *      that the user was signed out everywhere and must be handed the new
 *      password manually. We don't email it; we don't store the plaintext.
 */
export interface ResetPasswordTarget {
  /** Display name for the dialog title + copy. */
  name: string;
  /** API path the new password is POSTed to as `{ newPassword }`. */
  endpoint: string;
}

/** Generate a readable, sufficiently-random one-time password. */
function generatePassword(): string {
  // No ambiguous chars (0/O, 1/l/I) — admins read these aloud or paste into
  // chat, so legibility beats raw entropy. 16 chars from this alphabet is
  // ~82 bits, well past any brute-force concern for a password the user will
  // immediately change anyway.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const len = 16;
  const out: string[] = [];
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  for (let i = 0; i < len; i += 1) {
    out.push(alphabet[buf[i]! % alphabet.length]!);
  }
  return out.join("");
}

export function ResetPasswordDialog({
  target,
  onClose,
}: {
  /** Non-null while the dialog is open; null when closed. */
  target: ResetPasswordTarget | null;
  onClose: () => void;
}) {
  const open = target !== null;
  const titleId = useId();

  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // After a successful reset we hold the plaintext (in memory only) to show
  // the admin once. Set === password at that moment, cleared on close.
  const [savedPassword, setSavedPassword] = useState<string | null>(null);

  const close = useCallback(() => {
    if (saving) return;
    onClose();
  }, [saving, onClose]);

  // Reset all transient state whenever the dialog opens for a (new) target so
  // a previous attempt's password / error / success never leaks across rows.
  useEffect(() => {
    if (!open) return;
    setPassword("");
    setReveal(false);
    setSaving(false);
    setError(null);
    setSavedPassword(null);
  }, [open]);

  if (!open || !target) return null;

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const canSubmit = password.length >= MIN_PASSWORD_LENGTH && !saving;

  async function submit() {
    if (!target) return;
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(target.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newPassword: password }),
      });
      if (!res.ok) {
        setError(await apiErrorMessage(res, "Failed to reset password"));
        return;
      }
      setSavedPassword(password);
    } catch {
      // A network-level rejection (api restart, WiFi blip) must NOT leave
      // saving=true forever — that disables Cancel and blocks close(), hard-
      // locking the dialog until a page reload. finally always clears it.
      setError("Network error — try again.");
    } finally {
      setSaving(false);
    }
  }

  async function copy() {
    if (!savedPassword) return;
    try {
      await navigator.clipboard.writeText(savedPassword);
      toast.success("Password copied");
    } catch {
      toast.error("Couldn't copy", {
        description: "Select the field and copy it manually.",
      });
    }
  }

  // z-60 keeps this above any modal it can open from (e.g. the platform org
  // detail roster). The shared <Dialog> portals to <body> + owns the chrome.
  return (
    <Dialog open={open} onClose={close} overlayClassName="z-60">
      <DialogContent className="max-w-md" labelledBy={titleId}>
        <div className="flex items-start gap-3 p-5">
          <div className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <KeyRound className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-semibold">
              Reset password for {target.name}
            </h2>
            {savedPassword === null ? (
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                Set a new password and share it with them directly (no email is
                sent). They'll be signed out on every device and can change it
                from Settings once they're back in.
              </p>
            ) : (
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                Done. Copy this password and hand it to{" "}
                <span className="font-medium text-foreground">{target.name}</span>{" "}
                securely — it won't be shown again. They've been signed out
                everywhere.
              </p>
            )}
          </div>
        </div>

        <div className="px-5 pb-2">
          {savedPassword === null ? (
            <>
              <label
                htmlFor={`${titleId}-pw`}
                className="text-xs font-medium text-foreground"
              >
                New password
              </label>
              <div className="mt-1.5 flex gap-2">
                <div className="relative flex-1">
                  <Input
                    id={`${titleId}-pw`}
                    type={reveal ? "text" : "password"}
                    autoComplete="new-password"
                    value={password}
                    autoFocus
                    onChange={(e) => {
                      setPassword(e.target.value);
                      if (error) setError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && canSubmit) {
                        e.preventDefault();
                        void submit();
                      }
                    }}
                    placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? `${titleId}-err` : undefined}
                    className="pr-9 font-mono"
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
                <Button
                  type="button"
                  variant="outline"
                  disabled={saving}
                  onClick={() => {
                    setPassword(generatePassword());
                    setReveal(true);
                    if (error) setError(null);
                  }}
                  title="Generate a strong password"
                >
                  <RefreshCw className="size-3.5" />
                  Generate
                </Button>
              </div>
              {tooShort && (
                <p className="mt-1.5 text-2xs text-muted-foreground">
                  At least {MIN_PASSWORD_LENGTH} characters.
                </p>
              )}
            </>
          ) : (
            <div className="flex gap-2">
              <Input
                readOnly
                value={savedPassword}
                aria-label="New password"
                className="font-mono text-sm"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button type="button" variant="outline" onClick={copy}>
                <Copy className="size-3.5" />
                Copy
              </Button>
            </div>
          )}

          {error && (
            <div
              id={`${titleId}-err`}
              role="alert"
              className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {error}
            </div>
          )}
        </div>

        <div className="mt-2 flex justify-end gap-2 border-t border-border px-5 py-3">
          {savedPassword === null ? (
            <>
              <Button variant="ghost" size="sm" disabled={saving} onClick={close}>
                Cancel
              </Button>
              <Button size="sm" disabled={!canSubmit} onClick={() => void submit()}>
                {saving ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <KeyRound className="size-3.5" />
                )}
                Set password
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={close}>
              <Check className="size-3.5" />
              Done
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
