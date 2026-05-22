import { subscribe, SubscriberPriority } from "@/lib/events/bus";
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

/**
 * Scopes we KNOW don't need a cross-process bust today. Listed
 * explicitly so adding a new scope is forced to choose: wire a tag
 * here, or add the scope name to this set with a one-line rationale.
 * Anything that falls into neither bucket logs a warn — surfaces the
 * silently-stale-after-edit bug class before a customer notices.
 */
const NO_TAG_SCOPES = new Set<TeamCatalogChangedEvent["scope"]>([
  // No client-side cached fetch consumes these — RSC reads the rows
  // directly via Prisma and Next.js's per-request memo is enough,
  // OR the consumer already invalidates via a more specific path
  // (whatsapp-templates flips via the templates settings page itself).
  "audience-groups",
  "workflows",
  "whatsapp-templates",
  "invites",
  "api-keys",
  "team-channels",
]);

let registered = false;

export function registerWebCacheRevalidateSubscriber(): void {
  if (registered) return;
  registered = true;

  subscribe("team.catalog_changed", (e) => {
    const tag = SCOPE_TO_TAG[e.scope];
    if (!tag) {
      // Either an intentional no-op (NO_TAG_SCOPES) or a new scope that
      // someone forgot to wire. The warn surfaces the latter loudly so a
      // future "why is my tag rename invisible for 60s" bug surfaces in
      // logs the first time the new scope mutates, not weeks later.
      if (!NO_TAG_SCOPES.has(e.scope)) {
        console.warn(
          `[web-cache-revalidate] no tag mapping for catalog scope "${e.scope}" — ` +
            `add it to SCOPE_TO_TAG or NO_TAG_SCOPES in web-cache-revalidate.ts. ` +
            `Until then, the only freshness signal is the 60s time-based revalidate.`,
        );
      }
      return;
    }
    // Default targets the docker-compose web service name (`app`). Override
    // via WEB_INTERNAL_URL when running outside docker or with a different
    // topology — host dev typically sets `http://127.0.0.1:3000`.
    const url = process.env.WEB_INTERNAL_URL ?? "http://app:3000";
    const secret = process.env.INTERNAL_BUS_SECRET;
    // Dev convenience: no secret configured → skip the bridge (the 60s
    // time-based revalidate still works). Prod's validateEnv refuses to
    // boot without it, so this branch only fires in dev / unit-test.
    if (!secret) return;

    // Fire-and-forget. Awaiting the cross-process HTTP call inside the bus
    // subscriber chain reliably pushed the synchronous publish() path past
    // the 100ms outbox-drainer poll interval, triggering double-dispatch on
    // every catalog change. The 60s time-based revalidate is the fallback
    // when this fetch fails; correctness doesn't depend on the bust landing.
    void fetch(`${url}/api/internal/revalidate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": secret,
      },
      body: JSON.stringify({ tag, teamId: e.teamId }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          console.warn(
            `[web-cache-revalidate] HTTP ${res.status} from ${url}: ${body.slice(0, 200)}`,
          );
        }
      })
      .catch((err) => {
        console.warn(
          `[web-cache-revalidate] fetch failed: ${err instanceof Error ? err.message : err}`,
        );
      });
  }, SubscriberPriority.WEB_CACHE_REVALIDATE);
}
