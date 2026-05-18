import { useCallback, useRef } from "react";

/**
 * Coalesced async action — at most one in flight at a time; subsequent
 * invocations while in-flight collapse into a single trailing re-run.
 * Inbound bursts of N socket events fire one POST instead of N, without
 * losing the final-state confirmation.
 *
 * Used by `markRead` in both inbox and team-chat hooks. The HTTP shape
 * differs (per-conversation vs per-channel), so the wrapped fn does the
 * actual fetch; this hook only owns the in-flight/queued coordination.
 *
 * The `deps` arg follows the same contract as `useCallback`: the returned
 * function identity is stable across renders unless deps change. Read
 * latest external state from refs inside `fn` if needed — the wrapper
 * captures `fn` via a ref so a fresh closure each render still runs the
 * latest implementation while keeping the returned action stable.
 */
export function useCoalescedAsync(
  fn: () => Promise<void>,
  deps: React.DependencyList,
): () => Promise<void> {
  const inFlight = useRef(false);
  const queued = useRef(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  // Self-ref so the trailing re-run can recurse without including the
  // returned action in its own deps (which would re-create on every call).
  const selfRef = useRef<() => Promise<void>>(async () => undefined);
  const action = useCallback(async () => {
    if (inFlight.current) {
      queued.current = true;
      return;
    }
    inFlight.current = true;
    try {
      await fnRef.current();
    } finally {
      inFlight.current = false;
      if (queued.current) {
        queued.current = false;
        void selfRef.current();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  selfRef.current = action;
  return action;
}
