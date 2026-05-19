"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password-policy";
import { cn } from "@ccp/shared/utils";

import { registerAction, type RegisterState } from "./actions";

const INITIAL: RegisterState = { error: null };

export function RegisterForm() {
  const router = useRouter();
  const [state, action] = useActionState(registerAction, INITIAL);

  // Prefetch the post-signup destination so the navigation that the
  // server-side redirect triggers paints near-instantly.
  useEffect(() => {
    router.prefetch("/settings/whatsapp");
  }, [router]);

  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="orgName" className="text-xs font-medium text-foreground">
          Organization name
        </label>
        <Input
          id="orgName"
          name="orgName"
          required
          autoFocus
          placeholder="Acme Co."
          defaultValue={state.values?.orgName ?? ""}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="name" className="text-xs font-medium text-foreground">
          Your name
        </label>
        <Input
          id="name"
          name="name"
          required
          placeholder="Ada Lovelace"
          defaultValue={state.values?.name ?? ""}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="email" className="text-xs font-medium text-foreground">
          Work email
        </label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="you@company.com"
          defaultValue={state.values?.email ?? ""}
        />
      </div>

      <PasswordField
        id="password"
        name="password"
        label="Password"
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
          Creating account…
        </>
      ) : (
        "Create account"
      )}
    </Button>
  );
}
