"use client";

import { useCallback, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * `router.refresh()` wrapped in `useTransition` so Suspense boundaries
 * don't fall back to their `loading.tsx` skeletons while the new RSC
 * streams in. The existing UI stays mounted; the new data swaps into
 * place silently when ready.
 *
 * Use this anywhere you'd reach for `router.refresh()` after a mutation —
 * tag added, contact edited, snippet saved, etc. The bare `refresh()`
 * call SUSPENDS the route on every fetch whose cache was just busted,
 * which the user perceives as a full-page flicker.
 *
 * For mutations that already wrap in a save-transition (most save buttons
 * do via `useTransition()` directly), this is functionally equivalent —
 * the second transition nests cleanly. Standardising on the hook means
 * "I want a refresh that doesn't flash" is one import, one call.
 *
 * Returns the bare wrapped function so callers can pass it as a callback
 * (`onClick={softRefresh}`) without an extra wrapper.
 */
export function useSoftRefresh(): () => void {
  const router = useRouter();
  const [, startTransition] = useTransition();
  // Memoized so callers can list `softRefresh` in their own hook dep arrays
  // without re-creating effects/callbacks every render. `router` and
  // `startTransition` are both stable, so this is effectively constant.
  return useCallback(() => startTransition(() => router.refresh()), [router]);
}
