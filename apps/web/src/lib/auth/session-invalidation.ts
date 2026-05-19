import "server-only";

/**
 * Tell NestJS to drop a user's sockets + per-process session cache.
 * Fire-and-forget — the caller (sign-out redirect) shouldn't wait on this.
 *
 * Sign-out happens in the Next.js /logout route, but the sockets + the
 * 15s session cache live in NestJS. Without this bridge a signed-out
 * user's socket keeps emitting for up to ~2 min (the Socket.io
 * connectionStateRecovery window). The 15s cache TTL is the fallback if
 * the call fails; nothing here is load-bearing for correctness, only for
 * "felt-instant" latency.
 */

export type SessionInvalidationReason =
  | "signout"
  | "deactivation"
  | "password-change"
  | "role-change"
  | "team-deletion";

export async function fireSessionInvalidated(
  userId: string,
  reason: SessionInvalidationReason,
): Promise<void> {
  const base = process.env.INTERNAL_API_URL ?? "http://127.0.0.1:4000";
  const secret = process.env.INTERNAL_BUS_SECRET;
  if (!secret) return; // dev without the secret; 15s cache TTL is the fallback.

  // 2s timeout so a stuck api can't hang the redirect.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    await fetch(`${base}/api/internal/session-invalidated`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": secret,
      },
      body: JSON.stringify({ userId, reason }),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch {
    // best-effort
  } finally {
    clearTimeout(timeout);
  }
}
