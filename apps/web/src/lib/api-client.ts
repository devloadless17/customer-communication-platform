import "server-only";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { Agent, setGlobalDispatcher } from "undici";

/**
 * Typed internal API client. Used by RSC pages + server actions to fetch from
 * the NestJS api over HTTP. The browser never imports this — client components
 * talk to NestJS directly via plain fetch (cookies are HttpOnly + first-party).
 *
 * Env:
 *   - INTERNAL_API_URL: server-only target for RSC fetches.
 *       dev: http://127.0.0.1:4000
 *       prod (docker): http://api:4000
 *   - NEXT_PUBLIC_API_URL stays separate — that's the browser Socket.io target.
 *
 * Defaults: RSC pages redirect to /logout on 401 — /logout clears the stale
 * cookie and then redirects to /login. Hitting /login directly with a stale
 * cookie still set would just bounce back via the middleware, looping. Server
 * actions opt into throwing so they can return a useful error to the form.
 */

const BASE = process.env.INTERNAL_API_URL ?? "http://127.0.0.1:4000";

/**
 * Keep-alive socket pool for RSC → NestJS fetches. Each RSC render fires
 * ~8 parallel fetches; without a pool every one opens a fresh TCP connection.
 * On loopback that's ~1-3ms/connection of pure setup overhead — small per
 * call but stacks across the parallel fan-out for every page load.
 *
 *  - keepAliveTimeout: how long an idle socket survives. 30s is comfortably
 *    longer than typical inter-request gaps from a single user.
 *  - keepAliveMaxTimeout: hard cap from the spec (some proxies enforce 60s).
 *  - connections: per-origin pool size. The api process is one origin;
 *    8 sockets covers the inbox fan-out without queueing.
 *  - pipelining: 0 disables HTTP pipelining (broken by many intermediaries
 *    and unnecessary when sockets are pooled — undici reuses idle sockets
 *    instead).
 *
 * Module-scope init: runs once when the api-client is first imported in the
 * Node server process, before any user code calls fetch().
 */
const apiKeepAliveAgent = new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connections: 8,
  pipelining: 0,
});
setGlobalDispatcher(apiKeepAliveAgent);

export interface ApiOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Default `"redirect"` for RSC; pass `"throw"` from server actions. */
  on401?: "redirect" | "throw";
  signal?: AbortSignal;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

/**
 * Retry only when the upstream isn't reachable at all (TCP refused, DNS,
 * undici socket close mid-flight). These manifest as `TypeError: fetch
 * failed` and only happen in dev when the NestJS process restarts on a
 * code change — prod has Caddy in front so the proxy returns 502 (an HTTP
 * response, not a fetch throw) for the same ~3s window.
 *
 * Limited to idempotent verbs so a POST that DID reach NestJS but timed
 * out on the response isn't double-applied. Three retries with linear
 * backoff covers a typical @swc-node restart (~2-5s); past that, the
 * caller's RSC error boundary takes over.
 */
const NETWORK_RETRY_BUDGET_MS = 6_000;
const NETWORK_RETRY_DELAYS_MS = [400, 800, 1_500];

async function fetchWithDevRestartRetry(
  url: URL,
  init: RequestInit,
  method: string,
): Promise<Response> {
  const idempotent = method === "GET" || method === "HEAD";
  const start = Date.now();
  let attempt = 0;
  while (true) {
    try {
      return await fetch(url, init);
    } catch (err) {
      // Only retry network failures, only on idempotent verbs, only in dev,
      // and only within the budget. Everything else: throw so the original
      // error path runs.
      if (
        !idempotent ||
        process.env.NODE_ENV === "production" ||
        attempt >= NETWORK_RETRY_DELAYS_MS.length ||
        Date.now() - start > NETWORK_RETRY_BUDGET_MS ||
        init.signal?.aborted
      ) {
        throw err;
      }
      const delay = NETWORK_RETRY_DELAYS_MS[attempt]!;
      attempt += 1;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const cookieHeader = cookieStore.toString();

  const url = new URL(path.startsWith("/") ? path : `/${path}`, BASE);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  // RSC reads always go fresh — Socket.io drives staleness for hot data,
  // and the catalog reads are cheap enough not to need fetch-cache layering.
  // The fetch-cache opt-in + `/api/internal/revalidate` bridge that lived
  // here was removed 2026-05-29: every caller passed `cache: "no-store"`
  // anyway, so the bridge was firing a cross-process round-trip to
  // invalidate tags nothing ever fetched with.
  const fetchInit: RequestInit = {
    method: opts.method ?? "GET",
    headers: {
      "content-type": "application/json",
      cookie: cookieHeader,
      // Forward client IP so NestJS's trust-proxy + rate limiter see the
      // real client, not 127.0.0.1.
      "x-forwarded-for": headerStore.get("x-forwarded-for") ?? "",
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
    signal: opts.signal,
  };
  const res = await fetchWithDevRestartRetry(url, fetchInit, opts.method ?? "GET");

  if (res.status === 401) {
    if ((opts.on401 ?? "redirect") === "redirect") {
      // Route to /logout, NOT /login. Server components can't mutate cookies,
      // so a stale cookie (signed + parses, but the underlying Session row
      // is gone) would survive a /login redirect — middleware then bounces
      // /login back to /inbox, /inbox 401s again, loop. `lib/auth/current-user`
      // uses the same /logout-bounce pattern for the same reason.
      // See `apps/web/src/app/logout/route.ts` — it clears every Better Auth
      // cookie variant on the response and then redirects to /login.
      redirect("/logout");
    }
    throw new ApiError(401, "Unauthorized");
  }

  if (!res.ok) {
    let body: unknown;
    let text = "";
    try {
      text = await res.text();
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    throw new ApiError(res.status, text || res.statusText, body);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
