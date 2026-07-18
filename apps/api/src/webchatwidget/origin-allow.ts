/**
 * Whether a request `Origin` may embed a widget, given its allow-list.
 *
 * Entries are hosts, not full origins: `example.com` (exact host, any scheme/port)
 * or `*.example.com` (any subdomain). We compare on HOST so an admin doesn't have
 * to think about `https://`/port. An EMPTY allow-list means "not locked down yet"
 * → allow (dev convenience); the onboarding UI nudges admins to add their domains.
 * `localhost` / `127.0.0.1` are always allowed so the embed test page + local dev
 * work without configuration.
 *
 * Note: CORS is not the security boundary for the widget (visitors are anonymous,
 * the site key is public) — this origin check + per-IP rate limits are. The
 * WebSocket transport isn't CORS-enforced by browsers, so this server-side check
 * is what actually gates which sites may open a widget socket.
 */
export function originAllowed(origin: string | null, allowedOrigins: string[]): boolean {
  const configured = (allowedOrigins ?? []).map((o) => o.trim().toLowerCase()).filter(Boolean);
  const isProd = process.env.NODE_ENV === "production";

  // No Origin header (native/non-browser client). Browsers ALWAYS send Origin on a
  // WebSocket handshake, so a missing one means a script, not a visitor — and a
  // script can also set Origin to anything it likes. That means this check only
  // ever constrains honest browsers, and the escapes below are what a bot uses to
  // walk around a configured allow-list. So: once an org has actually locked its
  // list down, honour that and refuse the no-Origin case. An org that has NOT
  // configured anything keeps the permissive behaviour, so no live widget breaks.
  if (!origin) return configured.length === 0;

  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  // Loopback is a DEV convenience (embed test page, local development). In
  // production it was a free bypass of any allow-list: `Origin: http://localhost`
  // is one header on a scripted client.
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") {
    if (!isProd || configured.length === 0) return true;
    return configured.some((e) => e === host || e === `*.${host}`);
  }

  // Always allow our OWN app origin — the inline-embed / any first-party host page
  // (e.g. a page on this app's domain) must pass even when the org locked its
  // allow-list to just their marketing site.
  const appOrigin = (process.env.APP_PUBLIC_URL || process.env.NEXT_PUBLIC_APP_URL || "").trim();
  if (appOrigin) {
    try {
      if (host === new URL(appOrigin).hostname.toLowerCase()) return true;
    } catch {
      /* ignore a malformed env */
    }
  }

  if (configured.length === 0) return true; // not configured yet → permissive

  return configured.some((entry) => {
    if (entry.startsWith("*.")) {
      const base = entry.slice(2);
      return host === base || host.endsWith(`.${base}`);
    }
    // Strip a scheme if the admin pasted a full origin.
    const bare = entry.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    return host === bare;
  });
}
