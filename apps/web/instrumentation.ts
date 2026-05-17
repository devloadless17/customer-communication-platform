/**
 * Next.js boot hook — called once per server process (dev + prod).
 *
 * Currently a no-op. Pre-cleanup this registered a `cache-revalidate` bus
 * subscriber that bridged `team.catalog_changed` events to
 * `revalidateTag(...)`, but the catalog queries themselves no longer use
 * `unstable_cache` (they crashed when invoked from the NestJS process), so
 * there's nothing left to revalidate. Cross-tab catalog freshness is
 * handled by the Socket.io `team:catalog:changed` emit instead.
 *
 * Keeping the file (even empty) because Next.js's instrumentation API
 * resolves `register` by filename — the hook signature is part of the
 * contract and re-adding wiring later is cheaper from here than from
 * scratch.
 *
 * Reference: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
}
