import { ForgotPasswordForm } from "./forgot-password-form";

export const metadata = { title: "Reset your password" };

/**
 * Self-serve password reset — the replacement for the super-admin
 * "set a member's password" action, which is gone.
 *
 * Unauthenticated by design and deliberately says nothing about whether an
 * address has an account (see actions.ts). The copy is written to be true in
 * every case: "if there's an account" covers a registered address, an
 * unregistered one, and a Google-only account with no password to reset.
 */
export default function ForgotPasswordPage() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/30 p-6">
      <div className="w-full max-w-sm rounded-xl border bg-card p-6 shadow-sm">
        <h1 className="text-lg font-semibold">Reset your password</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Enter your email and we&apos;ll send you a 6-digit code. If there&apos;s
          an account for it, the code arrives in a moment.
        </p>
        {/* Generic advice, deliberately not conditional on the address: a hint
            that appeared only for Google accounts would be an enumeration
            oracle. Stated up front because someone who signed up with Google
            has no password to reset and would otherwise sit waiting for a code
            they don't need. */}
        <p className="mt-2 rounded-md border border-border bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
          Signed up with Google? You don&apos;t need a password — go back and use{" "}
          <span className="font-medium text-foreground">Continue with Google</span>.
        </p>
        <ForgotPasswordForm />
      </div>
    </main>
  );
}
