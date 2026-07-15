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
  // No Origin header (native/non-browser client). Allow — the site key already
  // scoped the team; a headless client can't read a real visitor's data.
  if (!origin) return true;

  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return true;

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

  const list = (allowedOrigins ?? []).map((o) => o.trim().toLowerCase()).filter(Boolean);
  if (list.length === 0) return true; // not configured yet → permissive

  return list.some((entry) => {
    if (entry.startsWith("*.")) {
      const base = entry.slice(2);
      return host === base || host.endsWith(`.${base}`);
    }
    // Strip a scheme if the admin pasted a full origin.
    const bare = entry.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    return host === bare;
  });
}
