/**
 * Whether a request `Origin` may embed a widget, given its allow-list.
 *
 * Entries are hosts, not full origins: `example.com` (exact host, any scheme/port)
 * or `*.example.com` (any subdomain). We compare on HOST so an admin doesn't have
 * to think about `https://`/port. An EMPTY allow-list means "not locked down yet"
 * → allow (dev convenience); the onboarding UI nudges admins to add their domains.
 * `localhost` / `127.0.0.1` are allowed while the list is EMPTY (embed test page,
 * local dev) and outside production; once a production tenant locks the list down,
 * loopback must be listed like any other host — `Origin: http://localhost` is one
 * header on a scripted client, so a permanent exemption is a free bypass.
 *
 * Note: CORS is not the security boundary for the widget (visitors are anonymous,
 * the site key is public) — this origin check + per-IP rate limits are. The
 * WebSocket transport isn't CORS-enforced by browsers, so this server-side check
 * is what actually gates which sites may open a widget socket.
 */
export function originAllowed(
  origin: string | null,
  allowedOrigins: string[],
  /**
   * Which transport is asking. This MATTERS for the missing-Origin case,
   * because the two have opposite meanings:
   *
   *   "websocket" — a browser ALWAYS sends Origin on a WS handshake, so its
   *     absence means a non-browser client (a script), which is what we want
   *     to refuse once an org has locked its allow-list down.
   *
   *   "http" — per the Fetch spec a SAME-ORIGIN GET omits Origin entirely,
   *     while every cross-origin fetch sends it. So on this path a missing
   *     Origin means first-party, which must be allowed.
   *
   * Defaulting to "websocket" keeps the strict reading for any future caller
   * that forgets to say.
   */
  transport: "websocket" | "http" = "websocket",
): boolean {
  const configured = (allowedOrigins ?? []).map((o) => o.trim().toLowerCase()).filter(Boolean);
  const isProd = process.env.NODE_ENV === "production";

  // No Origin header. See `transport` above for why the answer differs.
  //
  // Getting this wrong broke a real first-party flow: `GET /api/widget/config`
  // is fetched same-origin by widget.js, so it carries no Origin, and treating
  // that like a script meant the Settings → "Test this widget" page returned
  // 403 for any org that had configured an allow-list — the inline first-party
  // embed too. The "always allow our OWN app origin" branch below exists for
  // exactly that case and was being short-circuited before it could run.
  if (!origin) return transport === "http" || configured.length === 0;

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
