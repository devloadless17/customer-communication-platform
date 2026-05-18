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
  /**
   * Opt into Next.js' data cache for THIS call. Default behavior is
   * `cache: "no-store"` — every render hits the api fresh. Pass `next` to
   * enable caching for read-mostly catalogs (tags, stages, fields, etc.)
   * so subsequent renders return from the data cache. Tags allow targeted
   * busting via `revalidateTag(tag)` from mutation routes.
   *
   * Per-request cookies are NOT mixed into the cache key, so this is only
   * safe for team-scoped reads where the api derives the team from the
   * cookie — two users on the same team share the cache, which is correct
   * for these catalogs.
   */
  next?: {
    tags?: string[];
    /** Seconds. 0 disables time-based revalidation (tag-only). */
    revalidate?: number;
  };
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
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

  // Caller opted into Next.js' data cache for this read — drop `cache:
  // "no-store"` (which would override `next`) and let Next.js manage
  // freshness via tags + revalidate.
  const useDataCache = opts.next !== undefined;
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers: {
      "content-type": "application/json",
      cookie: cookieHeader,
      // Forward client IP so NestJS's trust-proxy + rate limiter see the
      // real client, not 127.0.0.1.
      "x-forwarded-for": headerStore.get("x-forwarded-for") ?? "",
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    // RSC reads default to fresh (Socket.io drives staleness for hot data).
    // Opt-in caching for read-mostly catalogs via the `next` option.
    ...(useDataCache ? { next: opts.next } : { cache: "no-store" }),
    signal: opts.signal,
  });

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
