"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  requestResetAction,
  resetPasswordAction,
  type ForgotState,
} from "./actions";

const INITIAL: ForgotState = { error: null };

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending && <Loader2 className="size-4 animate-spin" />}
      {label}
    </Button>
  );
}

/**
 * Two steps in one component so the email typed in step 1 carries into step 2
 * without a round-trip or a query param. It travels as a hidden field rather
 * than in the URL: a reset URL containing an address gets copied into chat logs
 * and browser history, and lands in the Referer of anything the page loads.
 */
export function ForgotPasswordForm() {
  const [requestState, requestAction] = useActionState(requestResetAction, INITIAL);
  const [resetState, resetAction] = useActionState(resetPasswordAction, INITIAL);
  const [email, setEmail] = useState("");

  const sent = requestState.sent === true;
  const error = sent ? resetState.error : requestState.error;

  if (!sent) {
    return (
      <form action={requestAction} className="mt-5 space-y-3">
        <div className="space-y-1.5">
          <label htmlFor="email" className="text-sm font-medium">
            Email
          </label>
          <Input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </div>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <SubmitButton label="Send reset code" />
        <p className="text-center text-xs text-muted-foreground">
          <Link href="/login" className="hover:text-foreground">
            Back to sign in
          </Link>
        </p>
      </form>
    );
  }

  return (
    <form action={resetAction} className="mt-5 space-y-3">
      {/* The address is fixed from here on. Re-editing it mid-flow would let
          someone pair a code sent to one address with a reset of another. */}
      <input type="hidden" name="email" value={email} />
      <div className="space-y-1.5">
        <label htmlFor="code" className="text-sm font-medium">
          6-digit code
        </label>
        <Input
          id="code"
          name="code"
          inputMode="numeric"
          // Lets iOS/Android offer the code straight from the SMS/email
          // notification instead of making the user switch apps to read it.
          autoComplete="one-time-code"
          maxLength={6}
          required
          autoFocus
          placeholder="000000"
          className="text-center text-lg tracking-[0.4em]"
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="password" className="text-sm font-medium">
          New password
        </label>
        <Input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="new-password"
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="confirmPassword" className="text-sm font-medium">
          Confirm new password
        </label>
        <Input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          required
          autoComplete="new-password"
        />
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <SubmitButton label="Set new password" />
      <p className="text-center text-xs text-muted-foreground">
        <Link href="/login" className="hover:text-foreground">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
