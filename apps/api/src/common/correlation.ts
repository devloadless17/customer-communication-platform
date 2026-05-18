import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Per-request correlation ID, propagated implicitly through async boundaries
 * via Node's AsyncLocalStorage. Lets log lines from any hot-path code be
 * grouped back to the originating HTTP request without threading an
 * argument through every function.
 *
 * Wiring:
 *   - HTTP: `correlationMiddleware` installed in main.ts BEFORE bodyParser
 *     so the context is established before any body-parsing async work.
 *   - BullMQ workers: opt-in via `runWithCorrelation(jobId, fn)` — not
 *     wired automatically since most worker code paths use NestJS's
 *     `Logger` (which already carries the module context).
 *   - Socket.io: opt-in similarly per emitted event if useful.
 *
 * Trust model: `X-Request-Id` from the client is accepted as the correlation
 * ID only when it looks like a plausible UUID/short string. Anything else
 * (long blobs, control chars) is rejected and we mint a fresh one. We sit
 * behind Caddy on the host — Caddy doesn't inject one today, so the inbound
 * value is effectively from the browser when present. Don't trust it for
 * authorization; use it only for log correlation.
 */

const als = new AsyncLocalStorage<string>();

const REQUEST_ID_HEADER = "x-request-id";
const REQUEST_ID_MAX_LEN = 64;
// Accepts UUID v4-ish, short hex, alphanumeric+dash+underscore. Tight enough
// to reject anything that could break a grep, loose enough to honor common
// distributed-tracing id formats.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

function sanitizeIncomingId(raw: string | string[] | undefined): string | null {
  if (!raw) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || value.length > REQUEST_ID_MAX_LEN) return null;
  return REQUEST_ID_PATTERN.test(value) ? value : null;
}

/** Read the current correlation ID, or undefined if outside any request. */
export function getCorrelationId(): string | undefined {
  return als.getStore();
}

/**
 * Format a log line with the current correlation ID prefix when one is
 * available. Use from framework-agnostic helpers in `lib/` where the NestJS
 * `Logger` isn't appropriate. Returns the original message untouched outside
 * a request scope so background sweepers and boot-time logs stay clean.
 */
export function withCorrelation(msg: string): string {
  const id = als.getStore();
  return id ? `[req=${id}] ${msg}` : msg;
}

/**
 * Express middleware factory. Reads (or mints) a request id, echoes it
 * back via `X-Request-Id`, and binds it to ALS for the lifetime of the
 * request handler. Logged in the default access-log pattern.
 */
export function correlationMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = sanitizeIncomingId(req.headers[REQUEST_ID_HEADER]);
    const id = incoming ?? randomUUID();
    res.setHeader("X-Request-Id", id);
    als.run(id, () => next());
  };
}

/**
 * Bind a synchronous or async fn to a fresh correlation scope. Use for
 * background jobs (BullMQ workers, scheduled sweepers, broadcast iterations)
 * where logs from a single job should group together but there's no HTTP
 * request to inherit from.
 */
export function runWithCorrelation<T>(id: string, fn: () => T): T {
  return als.run(id, fn);
}
