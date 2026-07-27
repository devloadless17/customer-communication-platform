/**
 * Turn a failed `Response` into something worth showing a person.
 *
 * Lives in @ccp/shared because it is framework-agnostic (a `Response` in, a
 * string out) and because apps/web has no test runner — keeping it here is what
 * lets the behaviour be covered instead of an api-side spec reaching across the
 * monorepo into web source.
 *
 * The API's error contract is `{ error: "<snake_case_key>", detail?: "<sentence>" }`
 * (see CLAUDE.md §13). Call sites were reading `.error` alone, so the user got
 * the machine key: an admin who hit a seat cap saw
 *
 *     member_limit_reached
 *
 * instead of the sentence the service had already written for them —
 * "This workspace is at its member limit (2 members). Ask your platform
 * administrator to raise the limit before inviting more." The server was doing
 * the right thing and the UI was throwing it away, in ~24 places.
 *
 * Order: `detail` (written for a human) → humanized `error` key → caller's
 * fallback. Humanizing the key is the important middle rung — most endpoints
 * send no detail, and "Member limit reached" beats "member_limit_reached" for
 * free, everywhere, without touching the API.
 */
export function humanizeErrorKey(key: string): string {
  const spaced = key.replace(/[_-]+/g, " ").trim();
  if (!spaced) return "";
  // Keys are already lowercase snake_case; sentence-case the first letter and
  // leave the rest alone so acronyms a key might carry (api, id) aren't
  // mangled into something odd.
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Read the body of a failed response and return the best available message.
 *
 * Never throws: a non-JSON body (an HTML error page from a proxy, an empty 502)
 * falls through to the fallback rather than replacing a useful error with a
 * parse exception.
 */
export async function apiErrorMessage(
  res: Response,
  fallback: string,
): Promise<string> {
  const data = (await res.json().catch(() => null)) as
    | { error?: unknown; detail?: unknown }
    | null;
  return apiErrorMessageFrom(data, fallback);
}

/**
 * Same rule, for a body the caller has ALREADY parsed.
 *
 * Plenty of call sites read the JSON themselves (they need another field from
 * it too) and then reached for `body.error` alone — which since the 2026-07-27
 * key normalization renders a bare snake_case identifier like
 * `invalid_phone_number` on screen. This exists so those sites get the same
 * detail → humanized-key → fallback order without re-reading the response,
 * and so there is exactly ONE definition of that order.
 */
export function apiErrorMessageFrom(
  data: { error?: unknown; detail?: unknown } | null | undefined,
  fallback: string,
): string {
  if (typeof data?.detail === "string" && data.detail.trim()) {
    return data.detail;
  }
  if (typeof data?.error === "string" && data.error.trim()) {
    const humanized = humanizeErrorKey(data.error);
    if (humanized) return humanized;
  }
  return fallback;
}

/**
 * The message to show when a request never produced a response at all.
 *
 * `apiFetch` THROWS on a 401 and on any network failure rather than returning
 * the response, so every mutation needs a catch — an unguarded one leaves a
 * spinner running forever with nothing on screen. Centralised so the wording is
 * consistent and nobody has to remember the reason.
 */
export const NETWORK_ERROR_MESSAGE =
  "Couldn't reach the server. Check your connection and try again.";
