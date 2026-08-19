import "server-only";

import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";

import { ApiError } from "../api-client";

/**
 * Degrade gracefully on a failed data load — but LOUDLY in the server log.
 *
 * WHY THIS EXISTS. RSC pages routinely wrap a secondary fetch in
 * `.catch(() => [])` so one flaky panel can't 500 the whole page. That instinct
 * is right; the problem is what it does to a PERMANENT failure. A route that
 * always fails renders as "no data" forever, and looks identical to a workspace
 * that genuinely has none — no error, no console line, nothing to grep.
 *
 * That is not hypothetical. The channel-account directory shipped without
 * `@UseGuards(SessionGuard)`, so it 401'd for every valid session. The inbox
 * layout's `.catch(() => [])` absorbed it, the account chip silently never
 * rendered, and typecheck, lint, the Prisma field checker and 239 unit tests all
 * passed over it. Only a browser test that asserted the endpoint was *readable*
 * caught it.
 *
 * So: same graceful fallback, plus one log line carrying the label, the status
 * and the correlation id — the difference between a bug you can find in the logs
 * and one you find in production months later.
 *
 * Logged at WARN, deliberately, and this is not cosmetic. Next's dev overlay
 * promotes `console.error` from a server component into a full-screen error
 * dialog — so using `error` here made a *handled* degradation look like the page
 * had crashed. That is worse than the silence it replaced: it hides real errors
 * behind noise and trains everyone to dismiss the overlay. `warn` is also the
 * honest severity — the page rendered, it just rendered with less.
 *
 * NOT for the page's PRIMARY data. If a page is meaningless without a fetch,
 * let it throw and let the error boundary say so; rendering an empty shell is
 * worse than an honest error.
 *
 * @example
 *   const accounts = await soft("channel-account directory", [], () =>
 *     listChannelAccountDirectory(),
 *   );
 */
export async function soft<T>(
  /** What was being loaded, in words — this is what you'll grep for. */
  label: string,
  fallback: T,
  load: () => Promise<T>,
): Promise<T> {
  try {
    return await load();
  } catch (err) {
    // Next signals redirect() / notFound() by THROWING. Swallowing those turns
    // an intended bounce (the api client redirects to /logout on a 401) into a
    // degraded page that renders as if the session were fine — and it made the
    // 401 branch below unreachable, since the loader never surfaced an ApiError.
    unstable_rethrow(err);

    // A 401 here is never "no data" — it means the route is unreachable for a
    // session that IS authenticated (a missing guard, a wrong role, an expired
    // cookie mid-render). Call it out separately: it is the single most
    // misleading status to swallow, because the page still renders.
    let detail: string;
    if (err instanceof ApiError) {
      detail =
        err.status === 401
          ? `HTTP 401 — the route rejected an authenticated session (missing guard? wrong role?)`
          : `HTTP ${err.status} ${err.message}`;
    } else {
      detail = err instanceof Error ? err.message : String(err);
    }

    let requestId: string | null = null;
    try {
      requestId = (await headers()).get("x-request-id");
    } catch {
      // Outside a request scope (a build-time render) — the id is a nicety.
    }

    console.warn(
      `[soft] ${label} failed, rendering the fallback: ${detail}` +
        (requestId ? ` (request ${requestId})` : ""),
    );
    return fallback;
  }
}
