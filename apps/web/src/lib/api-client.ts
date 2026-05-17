import "server-only";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

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
 * Defaults: RSC pages redirect to /login on 401 (no error-UI for expired
 * sessions). Server actions opt into throwing so they can return a useful
 * error to the form.
 */

const BASE = process.env.INTERNAL_API_URL ?? "http://127.0.0.1:4000";

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

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const cookieHeader = cookieStore.toString();

  const url = new URL(path.startsWith("/") ? path : `/${path}`, BASE);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

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
    // RSC reads are always fresh — Socket.io drives staleness.
    cache: "no-store",
    signal: opts.signal,
  });

  if (res.status === 401) {
    if ((opts.on401 ?? "redirect") === "redirect") {
      redirect("/login");
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
