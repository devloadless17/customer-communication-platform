"use client";

import { useState, useTransition } from "react";
import { Loader2, Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client-fetch";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password-policy";

export function ChangePasswordForm() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        setDone(false);
        const form = new FormData(e.currentTarget);
        const formEl = e.currentTarget;
        startTransition(async () => {
          // The change-password controller lives on the NestJS side. In prod,
          // Caddy routes `/api/auth/change-password*` to api:4000 (the rule
          // sits BEFORE the `/api/auth/*` → Next.js catch-all). In dev there
          // is no Caddy — Next.js owns `:3000`, NestJS owns `:4000`, and the
          // browser must target the api process directly. apiFetch resolves
          // the base via BROWSER_API_BASE (NEXT_PUBLIC_API_URL) and forwards
          // the session cookie via credentials: "include".
          const res = await apiFetch(`/api/auth/change-password`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              currentPassword: form.get("currentPassword"),
              newPassword: form.get("newPassword"),
            }),
          });
          if (!res.ok) {
            const data = (await res.json().catch(() => ({}))) as { error?: string };
            setError(data.error ?? "Failed to change password");
            return;
          }
          setDone(true);
          formEl.reset();
        });
      }}
      className="flex flex-col gap-3"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input
          name="currentPassword"
          type="password"
          placeholder="Current password"
          autoComplete="current-password"
          required
        />
        <Input
          name="newPassword"
          type="password"
          placeholder={`New password (${MIN_PASSWORD_LENGTH}+ chars)`}
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          required
        />
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </div>
      )}
      {done && (
        <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-primary">
          <Check className="size-3.5" />
          Password updated.
        </div>
      )}

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          Update password
        </Button>
      </div>
    </form>
  );
}
