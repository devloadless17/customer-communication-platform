"use client";

import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { acceptInviteAction, type AcceptState } from "./actions";

const INITIAL: AcceptState = { error: null };

export function AcceptForm({
  token,
  email,
}: {
  token: string;
  email: string;
}) {
  const [state, action] = useActionState(acceptInviteAction, INITIAL);
  const router = useRouter();

  // Navigate after the action lands. Same pattern as /login and /register —
  // avoids the Better Auth nextCookies + redirect() race in useActionState.
  useEffect(() => {
    if (state.redirectTo) {
      router.replace(state.redirectTo);
    }
  }, [state.redirectTo, router]);

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />

      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-foreground">Email</label>
        <Input value={email} readOnly disabled className="opacity-80" />
        <p className="text-[11px] text-muted-foreground">
          The admin invited this email. To use a different one, ask for a new link.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="name" className="text-xs font-medium text-foreground">
          Your name
        </label>
        <Input id="name" name="name" required autoFocus placeholder="Ada Lovelace" />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="password" className="text-xs font-medium text-foreground">
          Choose a password
        </label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          placeholder="8+ characters"
        />
      </div>

      {state.error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {state.error}
        </div>
      )}

      <SubmitButton />
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" className="mt-2 w-full" disabled={pending}>
      {pending ? (
        <>
          <Loader2 className="size-4 animate-spin" />
          Joining…
        </>
      ) : (
        "Join team"
      )}
    </Button>
  );
}
