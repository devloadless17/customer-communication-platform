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
 *   - BullMQ workers: rely on NestJS's `Logger` module context (no ALS).
 *   - Socket.io: rely on the gateway's logger module context.
 *
 * Trust model: `X-Request-Id` from the client is accepted as the correlation
 * ID only when it looks like a plausible UUID/short string. Anything else
 * (long blobs, control chars) is rejected and we mint a fresh one. We sit
 * behind Caddy on the host — Caddy doesn't inject one today, so the inbound
 * value is effectively from the browser when present. Don't trust it for
 * authorization; use it only for log correlation.
 */

interface RequestContext {
  requestId: string;
  /** Inbound X-CCP-Depth (0 when absent) — the cross-system loop-guard
   *  counter. Carried ambiently so the outbound-webhook subscriber can stamp
   *  depth+1 on deliveries it enqueues for events caused by THIS request,
   *  without threading it through every publish() call. */
  chainDepth: number;
}

const als = new AsyncLocalStorage<RequestContext>();

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
  return als.getStore()?.requestId;
}

/**
 * Re-establish a correlation context around a callback OUTSIDE an HTTP request —
 * used by the outbox drainer to restore the `chainDepth` + `correlationId`
 * captured on an OutboundEvent row at publish time. Without this, a deferred
 * dispatch (e.g. a `message.sent` outbound webhook) runs with the ALS default
 * `chainDepth = 0`, resetting the cross-system loop counter to 1 every hop and
 * defeating the X-CCP-Depth guard (EVT-1).
 */
export function runWithCorrelationContext<T>(
  ctx: { requestId: string; chainDepth: number },
  fn: () => T,
): T {
  return als.run(ctx, fn);
}

/**
 * Inbound cross-system chain depth (X-CCP-Depth) for the current request, or
 * 0 outside any request / when the header is absent. Used by the outbound-
 * webhook subscriber to stamp depth+1 on deliveries, so a partner that bounces
 * our webhook back into /v1 carries an incrementing counter that trips at
 * MAX_CHAIN_DEPTH — breaking a cross-system loop.
 */
export function getChainDepth(): number {
  return als.getStore()?.chainDepth ?? 0;
}

/**
 * Format a log line with the current correlation ID prefix when one is
 * available. Use from framework-agnostic helpers in `lib/` where the NestJS
 * `Logger` isn't appropriate. Returns the original message untouched outside
 * a request scope so background sweepers and boot-time logs stay clean.
 */
export function withCorrelation(msg: string): string {
  const id = als.getStore()?.requestId;
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
    // Seed the inbound cross-system chain depth (X-CCP-Depth) so the outbound-
    // webhook subscriber can stamp depth+1 on deliveries for events this
    // request causes. Mirrors parseChainDepth in lib/workflows/events.ts
    // (inlined so this foundational util keeps zero workflows dependency):
    // absent / invalid / non-positive → 0.
    const rawDepth = req.headers["x-ccp-depth"];
    const depthStr = Array.isArray(rawDepth) ? rawDepth[0] : rawDepth;
    const parsedDepth = depthStr ? Number.parseInt(depthStr, 10) : NaN;
    const chainDepth = Number.isFinite(parsedDepth) && parsedDepth > 0 ? parsedDepth : 0;
    als.run({ requestId: id, chainDepth }, () => next());
  };
}

