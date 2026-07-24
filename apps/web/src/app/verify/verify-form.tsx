"use client";

import { useActionState, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { resendCodeAction, verifyCodeAction, type VerifyState } from "./actions";

const INITIAL: VerifyState = { error: null };

/** How long before "Resend" becomes clickable again. Long enough that an
 *  impatient double-click doesn't spend two of the day's 300 sends. */
const RESEND_COOLDOWN_S = 45;

// No `email` prop: the page above renders the address, and the ACTIONS resolve
// it from the session — passing it through the client would invite someone to
// tamper with it and request codes for an address they don't own.
export function VerifyForm() {
  const [state, action] = useActionState(verifyCodeAction, INITIAL);
  const [notice, setNotice] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [resending, setResending] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function startCooldown() {
    setCooldown(RESEND_COOLDOWN_S);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setCooldown((s) => {
        if (s <= 1 && timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        return Math.max(0, s - 1);
      });
    }, 1000);
  }

  async function resend() {
    setResending(true);
    setNotice(null);
    setResendError(null);
    try {
      const result = await resendCodeAction();
      if (result.error) setResendError(result.error);
      else {
        setNotice(result.notice ?? "Sent — check your inbox.");
        // Only start the cooldown on SUCCESS: a failed send should be
        // immediately retryable, otherwise a transient blip strands the user
        // for 45 seconds with no code and no way to ask for one.
        startCooldown();
      }
    } finally {
      setResending(false);
    }
  }

  return (
    <>
      <form action={action} className="mt-5 flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="sr-only">6-digit code</span>
          <Input
            name="code"
            autoFocus
            // `inputMode` + `autocomplete` are what let iOS and Android offer
            // the code straight from the notification — without them the user
            // switches apps to read it, which is where signups get abandoned.
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            placeholder="000000"
            aria-label="6-digit verification code"
            className="h-12 text-center font-mono text-2xl tracking-[0.4em]"
          />
        </label>

        {state.error && (
          <p role="alert" className="text-xs text-destructive">
            {state.error}
          </p>
        )}

        <SubmitButton />
      </form>

      <div className="mt-4 flex items-center justify-between gap-3 text-xs">
        <span className="text-muted-foreground">Didn&apos;t get it?</span>
        <button
          type="button"
          onClick={() => void resend()}
          disabled={resending || cooldown > 0}
          className="cursor-pointer font-medium text-primary disabled:cursor-not-allowed disabled:text-muted-foreground"
        >
          {resending
            ? "Sending…"
            : cooldown > 0
              ? `Resend in ${cooldown}s`
              : "Resend code"}
        </button>
      </div>

      {notice && <p className="mt-2 text-xs text-success-fg">{notice}</p>}
      {resendError && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {resendError}
        </p>
      )}

      <p className="mt-4 border-t pt-3 text-2xs text-muted-foreground">
        Wrong address?{" "}
        <a href="/logout" className="font-medium text-primary">
          Sign out
        </a>{" "}
        and start again — nothing has been set up yet.
      </p>
    </>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="h-10 w-full">
      {pending && <Loader2 aria-hidden className="mr-1.5 size-4 animate-spin" />}
      {pending ? "Verifying…" : "Verify email"}
    </Button>
  );
}
