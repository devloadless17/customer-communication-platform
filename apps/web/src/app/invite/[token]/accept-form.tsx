"use client";

import { useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password-policy";
import {
  AuthRedirectFallback,
  useAuthRedirect,
} from "@/hooks/use-auth-redirect";
import { cn } from "@ccp/shared/utils";

import { acceptInviteAction, type AcceptState } from "./actions";

const INITIAL: AcceptState = { error: null };

export function AcceptForm({
  token,
  email,
}: {
  token: string;
  email: string;
}) {
  const router = useRouter();
  const { state, action, isRedirecting } = useAuthRedirect(
    acceptInviteAction,
    INITIAL,
  );

  // Prefetch the post-accept destination (always /inbox for invite flow)
  // so the navigation after the action resolves is near-instant. Same
  // rationale as login-form.tsx: without prefetch, the user sees the
  // AuthRedirectFallback spinner for ~150-300ms while /inbox does its
  // server fetches.
  useEffect(() => {
    router.prefetch("/inbox");
  }, [router]);

  // Fallback handles two flashes during navigation: (a) React resetting
  // uncontrolled inputs the instant the action resolves, (b) the auto-
  // revalidation of this route swapping in the "Already accepted" Shell
  // before `router.replace("/inbox")` lands. Spinner masks both.
  if (isRedirecting) {
    return <AuthRedirectFallback minHeightClass="min-h-65" />;
  }

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
        <Input
          id="name"
          name="name"
          required
          autoFocus
          placeholder="Ada Lovelace"
          defaultValue={state.values?.name ?? ""}
        />
      </div>

      <PasswordField
        id="password"
        name="password"
        label="Choose a password"
        autoComplete="new-password"
        placeholder={`${MIN_PASSWORD_LENGTH}+ characters`}
        minLength={MIN_PASSWORD_LENGTH}
      />

      <PasswordField
        id="confirmPassword"
        name="confirmPassword"
        label="Confirm password"
        autoComplete="new-password"
        placeholder="Re-enter your password"
        minLength={MIN_PASSWORD_LENGTH}
      />

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

function PasswordField({
  id,
  name,
  label,
  autoComplete,
  placeholder,
  minLength,
}: {
  id: string;
  name: string;
  label: string;
  autoComplete: string;
  placeholder: string;
  minLength: number;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-foreground">
        {label}
      </label>
      <div className="relative">
        <Input
          id={id}
          name={name}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          required
          minLength={minLength}
          placeholder={placeholder}
          className={cn("pr-10")}
        />
        <button
          type="button"
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          onClick={() => setVisible((v) => !v)}
          className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-r-md"
          tabIndex={-1}
        >
          {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
    </div>
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
