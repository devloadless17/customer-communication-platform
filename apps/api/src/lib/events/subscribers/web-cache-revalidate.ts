import { subscribe } from "@/lib/events/bus";
import type { TeamCatalogChangedEvent } from "@ccp/shared/events/types";

/**
 * Cross-process cache invalidator. Listens for `team.catalog_changed`
 * on NestJS' in-process bus and pings the Next.js process at
 * `/api/internal/revalidate` so it can call `revalidateTag()` on the
 * matching catalog. Without this bridge the 60s time-based revalidate
 * is the only freshness guarantee — admin renames a tag and 15-60s of
 * stale labels persist in cached RSC payloads.
 *
 * Failures are logged and swallowed:
 *   - Web process unreachable (deploy mid-flip): the time-based
 *     revalidate already covers this; a missed bust just means up to
 *     60s extra staleness, not a correctness bug.
 *   - Wrong secret / 401 from web: surface loudly so the operator
 *     fixes the env var; the alternative (silent) is worse because
 *     stale cache would persist indefinitely.
 *
 * Secret: shared between processes via INTERNAL_BUS_SECRET. Required
 * in prod (validateEnv); optional in dev so a one-process dev box
 * doesn't have to set it.
 */

const SCOPE_TO_TAG: Partial<Record<TeamCatalogChangedEvent["scope"], string>> = {
  stages: "catalog-stages",
  tags: "catalog-tags",
  "contact-fields": "catalog-contact-fields",
  snippets: "catalog-snippets",
  members: "team-members",
  // Scopes without a matching cache tag are intentionally absent —
  // their consumers don't (yet) opt into Next.js' data cache.
};

let registered = false;

export function registerWebCacheRevalidateSubscriber(): void {
  if (registered) return;
  registered = true;

  subscribe("team.catalog_changed", async (e) => {
    const tag = SCOPE_TO_TAG[e.scope];
    if (!tag) return;
    const url = process.env.WEB_INTERNAL_URL ?? "http://web:3000";
    const secret = process.env.INTERNAL_BUS_SECRET;
    // Dev convenience: no secret configured → skip the bridge (the 60s
    // time-based revalidate still works). Prod's validateEnv refuses to
    // boot without it, so this branch only fires in dev / unit-test.
    if (!secret) return;

    try {
      const res = await fetch(`${url}/api/internal/revalidate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-secret": secret,
        },
        body: JSON.stringify({ tag, teamId: e.teamId }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn(
          `[web-cache-revalidate] HTTP ${res.status} from ${url}: ${body.slice(0, 200)}`,
        );
      }
    } catch (err) {
      console.warn(
        `[web-cache-revalidate] fetch failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  });
}
