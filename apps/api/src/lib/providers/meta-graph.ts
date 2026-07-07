/**
 * Lean Graph API helpers shared by the Meta SOCIAL providers (Messenger,
 * Instagram). Kept deliberately separate from the WhatsApp provider's internal
 * `metaFetch` (meta.ts) so the stable WhatsApp send path is never touched by
 * social-channel changes — the retry/timeout posture mirrors it:
 *
 *   - Customer-visible POSTs are NON-idempotent → no auto-retry (a network blip
 *     after Meta accepted the send would double-post). Meta rejects duplicates
 *     on the app side anyway; our OutboundSendAttempt ledger is the real guard.
 *   - Bearer auth in the header (never the query string) so a token can't leak
 *     into access logs or an error URL.
 *
 * Both providers get their `SendConfig` (page/ig id + access token) from their
 * own `*-config.ts` loader, exactly like WhatsApp's `getMetaSendConfig`.
 */

export const GRAPH_BASE = "https://graph.facebook.com";
const GRAPH_TIMEOUT_MS = 15_000;

/** Redact any query string so a future signed-URL param can't leak into logs. */
function redactUrl(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : `${url.slice(0, q)}?<redacted>`;
}

/**
 * GET JSON from a Graph endpoint with a Bearer token. Used for best-effort
 * reads (e.g. a social contact's display name). Throws on non-2xx / timeout so
 * the caller can fail soft. `retry: true` retries once on 5xx / network blip
 * (GETs are idempotent, unlike sends).
 */
export async function graphGetJson(
  url: string,
  accessToken: string,
  opts?: { retry?: boolean },
): Promise<Record<string, unknown>> {
  const maxAttempts = opts?.retry ? 2 : 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), GRAPH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: ac.signal,
      });
      const text = await res.text().catch(() => "");
      if (!res.ok) {
        if (res.status >= 500 && attempt < maxAttempts - 1) continue;
        throw new Error(`graph GET ${res.status} ${redactUrl(url)}: ${text.slice(0, 300)}`);
      }
      return text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts - 1) continue;
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(`graph GET timed out after ${GRAPH_TIMEOUT_MS}ms: ${redactUrl(url)}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error("graphGetJson: no attempts ran");
}

/**
 * POST JSON to a Graph endpoint with a Bearer token. Throws on a non-2xx with
 * a truncated body so the caller (send path) surfaces a clean error to the
 * agent instead of a cryptic Meta blob. No retry — see file header.
 */
export async function graphPostJson(
  url: string,
  accessToken: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), GRAPH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw new Error(`graph POST ${res.status} ${redactUrl(url)}: ${text.slice(0, 500)}`);
    }
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`graph POST timed out after ${GRAPH_TIMEOUT_MS}ms: ${redactUrl(url)}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
