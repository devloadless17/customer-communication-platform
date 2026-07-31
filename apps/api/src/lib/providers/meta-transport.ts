import { withAppsecretProof } from "./appsecret-proof";
import { wireOut } from "./meta-wire";
import { metaWireEnabled } from "./meta-wire";
export const META_FETCH_TIMEOUT_MS = Number(process.env.META_FETCH_TIMEOUT_MS) || 20_000;

/**
 * WhatsApp Graph TRANSPORT — stage 3 of the meta.ts split (2026-07-31).
 * metaFetch (retry, redaction, appsecret handling) and its config. Everything
 * above (senders, the provider) imports from here; nothing here knows a wire
 * shape.
 */

export const META_FETCH_MAX_ATTEMPTS = 2; // 1 retry on transient 5xx
// Graph origin for every WhatsApp call. Real Meta by default; `META_GRAPH_BASE_URL`
// overrides it so an e2e run can point the whole app at a local mock Graph server.
// Read once at load (fixed for the process lifetime); duplicated locally rather
// than imported from meta-graph.ts to keep this stable WhatsApp path decoupled
// from the social helpers — same posture as DEFAULT_GRAPH_VERSION across configs.

export const GRAPH_BASE = process.env.META_GRAPH_BASE_URL || "https://graph.facebook.com";


/**
 * Does a Graph 400 mean "you asked for this the wrong SHAPE" (as opposed to a
 * real data or permission error)? Used to fall back between the edge form
 * (`GET /{wabaId}/<field>`) and the field-expansion form
 * (`GET /{wabaId}?fields=<field>...`) for the WABA analytics surfaces.
 *
 * Widened 2026-07-30: the pattern was `/unknown path|nonexisting field/`, which
 * misses the response Meta actually documents for an unsupported edge —
 * "Unsupported get request. Object with ID * does not exist, cannot be loaded due
 * to missing permissions, or does not support this operation." (code 100,
 * subcode 33). Because it never matched, the fallback never fired and three of
 * the four analytics surfaces surfaced as an empty panel whose reason blamed
 * Meta. `error parsing graph query` (#2500) covers a malformed modifier list.
 */
export function isGraphShapeDisagreement(text: string): boolean {
  return /unknown path|nonexisting field|nonexistent field|unsupported get request|does not support this operation|error parsing graph query/i.test(
    text,
  );
}


/**
 * Per-call fetch options layered on top of `RequestInit`.
 *
 *   retry — opt IN to the transient-5xx/timeout retry. Defaults to FALSE so a
 *           non-idempotent POST (a /messages send, a /calls initiation) is NEVER
 *           silently re-sent. Meta's send + call POSTs carry no idempotency key,
 *           so blindly retrying a 503/timeout blip can deliver the SAME WhatsApp
 *           message twice (customer-visible duplicate) or ring the customer
 *           twice — the exact failure class the OutboundSendAttempt /
 *           BroadcastSendAttempt guards + workflow skipped_after_crash journal
 *           exist to prevent. Those guards own the retry/refuse decision for
 *           sends; metaFetch must not pre-empt them. Idempotent / safe-to-repeat
 *           reads (fetchMedia, markIncomingRead, fetchTemplates, media upload,
 *           settings GET) pass `retry: true` and keep the one-shot blip recovery.
 */
export interface MetaFetchOptions extends RequestInit {
  retry?: boolean;
  /**
   * This ACCOUNT'S OWN app secret, to sign the call with `appsecret_proof`.
   *
   * Passed per call rather than read from a module global because the correct
   * secret is per-account: the secret must belong to the app that issued the
   * bearer token on this very request, and an account onboarted under a
   * different Meta app has its own. `metaFetch` reads the token straight out of
   * the Authorization header, so this is the only extra input it needs.
   *
   * Omit it and the call goes out exactly as before — the proof is additive, and
   * the whole feature is gated off by default anyway.
   */
  appSecret?: string;
}


/**
 * Strip the query string from a URL/string for error text. The upload-session
 * call (and any future query-param-bearing endpoint) must never echo a
 * credential through a thrown error message or a 502 body.
 */
export function redactUrlForError(input: string | URL): string {
  try {
    const u = typeof input === "string" ? new URL(input) : input;
    return u.origin + u.pathname;
  } catch {
    // Not a parseable absolute URL — return as-is (no query to leak).
    return String(input);
  }
}


/**
 * Pull the bearer token out of whatever `HeadersInit` shape a caller used.
 *
 * `metaFetch` signs with `appsecret_proof`, which is the HMAC of the ACCESS
 * TOKEN — and the token is already on the request as `Authorization: Bearer …`.
 * Reading it back here is what lets the proof be applied in ONE place instead of
 * threading the token through 50+ call sites alongside the secret it pairs with.
 *
 * All three header forms are handled because this file uses the plain
 * object form while a future caller may not, and a missed shape would silently
 * mean "no proof" — the failure mode that looks fine until Meta starts requiring
 * one. Returns undefined when there is no bearer token, which correctly disables
 * the proof rather than hashing an empty string.
 */
export function bearerFromHeaders(headers: RequestInit["headers"]): string | undefined {
  if (!headers) return undefined;
  const raw =
    headers instanceof Headers
      ? headers.get("authorization")
      : Array.isArray(headers)
        ? headers.find(([k]) => k.toLowerCase() === "authorization")?.[1]
        : Object.entries(headers).find(([k]) => k.toLowerCase() === "authorization")?.[1];
  if (typeof raw !== "string") return undefined;
  // BOTH schemes: Meta's resumable-upload endpoint authenticates with
  // `OAuth <token>` rather than `Bearer <token>`, and it needs a proof just the
  // same — matching only Bearer would leave template media uploads unsigned, i.e.
  // failing the moment "Require App Secret" is switched on.
  const m = /^(?:Bearer|OAuth)\s+(.+)$/i.exec(raw.trim());
  return m?.[1]?.trim() || undefined;
}


export async function metaFetch(
  input: string | URL,
  init?: MetaFetchOptions,
): Promise<Response> {
  // Retry policy: transient 5xx + network errors get one quick retry, but ONLY
  // when the caller opts in via `retry: true`. Default OFF — see MetaFetchOptions
  // for why non-idempotent send/call POSTs must not be auto-replayed. We never
  // retry 4xx either way — those are policy errors (24h-window closed, template
  // missing, bad auth) where retrying just hides the real problem.
  const retry = init?.retry === true;
  const maxAttempts = retry ? META_FETCH_MAX_ATTEMPTS : 1;
  // Don't pass our own `retry` / `appSecret` flags through to fetch's RequestInit.
  const { retry: _retry, appSecret, ...fetchInit } = init ?? {};
  // `appsecret_proof` — ONE place for every WhatsApp Graph call.
  //
  // Meta: "an access token can be stolen… then used from an entirely different
  // system", so the proof binds a call to knowledge of the app secret. It is a
  // query parameter, and the token it hashes is already on this request in the
  // Authorization header — so signing centrally here needs nothing threaded
  // through except the secret, and no call site can forget it.
  //
  // Additive and gated: `withAppsecretProof` returns the URL untouched unless
  // META_APPSECRET_PROOF=1 AND both inputs are present, so the wire is
  // byte-identical until someone opts in.
  const target = withAppsecretProof(
    typeof input === "string" ? input : input.toString(),
    bearerFromHeaders(fetchInit.headers),
    appSecret,
  );
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), META_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(target, { ...fetchInit, signal: ac.signal });
      // 5xx is transient by Meta convention. Retry once with backoff. The
      // request body is whatever the caller passed in `init.body` — fetch
      // re-uses it on retry without re-streaming concerns because all our
      // bodies are buffered (JSON or FormData built from in-memory bytes).
      if (res.status >= 500 && res.status < 600 && attempt < maxAttempts - 1) {
        // Drain so the connection can be reused by the keepalive pool.
        await res.text().catch(() => {});
        await sleep(500 + Math.random() * 250);
        continue;
      }
      // Dev wire log (DEBUG_META_WIRE): read a CLONE so the caller's body is
      // untouched. Gated + guarded — never affects the returned response.
      if (metaWireEnabled()) {
        const reqBody = typeof fetchInit.body === "string" ? fetchInit.body : "<binary>";
        const text = await res.clone().text().catch(() => "");
        wireOut(String(fetchInit.method ?? "GET"), redactUrlForError(input), reqBody, res.status, text);
      }
      return res;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // Timeouts surface as a typed error after the last attempt; mid-loop
        // we treat them as retryable network blips. The URL is redacted so a
        // query-param credential (e.g. a future signed-URL endpoint) can't leak
        // into the message that propagates to logs / a 502 error body.
        lastErr = new Error(
          `meta request timed out after ${META_FETCH_TIMEOUT_MS}ms: ${redactUrlForError(input)}`,
        );
      } else {
        lastErr = err;
      }
      if (attempt < maxAttempts - 1) {
        await sleep(500 + Math.random() * 250);
        continue;
      }
      throw lastErr;
    } finally {
      clearTimeout(timer);
    }
  }
  // Unreachable — loop returns or throws above.
  throw lastErr ?? new Error("metaFetch: no attempts ran");
}


export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}


