"use client";

import { useId, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client-fetch";
import { apiErrorMessage } from "@ccp/shared/api/error-message";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password-policy";
import { toast } from "@/lib/toast";

export function ChangePasswordForm() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const currentId = useId();
  const newId = useId();
  const errorId = useId();

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
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
            setError(await apiErrorMessage(res, "Failed to change password"));
            return;
          }
          toast.success("Password updated.");
          formEl.reset();
        });
      }}
      className="flex flex-col gap-3"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={currentId} className="text-xs font-medium text-muted-foreground">
            Current password
          </label>
          <Input
            id={currentId}
            name="currentPassword"
            type="password"
            placeholder="Current password"
            autoComplete="current-password"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={newId} className="text-xs font-medium text-muted-foreground">
            New password
          </label>
          <Input
            id={newId}
            name="newPassword"
            type="password"
            placeholder={`New password (${MIN_PASSWORD_LENGTH}+ chars)`}
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            required
          />
        </div>
      </div>

      {error && (
        <p
          id={errorId}
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </p>
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
