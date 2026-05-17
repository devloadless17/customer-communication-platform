import "server-only";

import { cookies } from "next/headers";

export const TIMEZONE_COOKIE = "tz";

/** Default zone used until the client's TZ-syncer writes the cookie. The
 *  pilot + early customers are in Lebanon, so starting in Asia/Beirut means
 *  most first-ever visitors see correct times on first paint with no flash. */
const DEFAULT_TZ = "Asia/Beirut";

/**
 * Reads the user's IANA timezone from the `tz` cookie set by `TimezoneProvider`
 * after first load. Falls back to `Asia/Beirut` until the cookie exists.
 * Reading cookies() opts the route into dynamic rendering, which is what we
 * want — every timestamp the server emits needs to reflect the viewer's zone.
 *
 * Lives in apps/web because cookies() is a Next.js-only API; nothing in
 * apps/api can call this. The legacy mirror under apps/api/src/lib was a
 * shim leftover from the pre-monorepo lib/ structure.
 */
export async function getServerTimezone(): Promise<string> {
  const c = await cookies();
  const raw = c.get(TIMEZONE_COOKIE)?.value;
  if (!raw) return DEFAULT_TZ;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return DEFAULT_TZ;
  }
  // Validate it's a real IANA zone before we hand it to Intl — a busted
  // cookie value would otherwise throw deep inside every formatter call.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: decoded });
    return decoded;
  } catch {
    return DEFAULT_TZ;
  }
}
