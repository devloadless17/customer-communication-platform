"use client";

import { useEffect, useState } from "react";

import { apiFetch } from "@/lib/api/client-fetch";

/**
 * Live recipient count for an audience expressed as `{ tagIds, contactIds }` —
 * the UNION semantics the server resolves (contacts carrying ANY chosen tag,
 * OR hand-picked by id). Debounced + race-safe, and it never ships the team
 * contact list to the browser (counts via `/api/contacts/count`).
 *
 * Single source of truth for the count badges in the audience group form and
 * the broadcast custom-audience builder — previously this effect was
 * copy-pasted in both with subtly different debounce timings.
 */
export function useAudienceCount(
  tagIds: string[],
  contactIds: string[],
  {
    initial = 0,
    debounceMs = 300,
    channel,
    all = false,
  }: { initial?: number; debounceMs?: number; channel?: string; all?: boolean } = {},
): { count: number; loading: boolean; resolved: boolean } {
  const [count, setCount] = useState(initial);
  const [loading, setLoading] = useState(false);
  // `count` is only trustworthy once a request for the CURRENT key succeeded.
  // Callers that have a sane approximation (the all-channel total, a group's
  // memberCount) render that until `resolved` flips, instead of showing the 0
  // this hook leaves behind after an empty-selection run or a failed fetch.
  const [resolved, setResolved] = useState(false);

  // Stable keys so the effect only re-runs on actual membership changes, not
  // on every render that produces a new array identity.
  const tagKey = tagIds.join(",");
  const contactKey = contactIds.join(",");

  useEffect(() => {
    // A new key invalidates the previous answer until this run succeeds.
    setResolved(false);
    // `all` counts every team contact (channel-scoped) with no tag/id selection,
    // so it must NOT take the empty-selection early return.
    if (!all && tagIds.length === 0 && contactIds.length === 0) {
      setCount(0);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    const t = window.setTimeout(async () => {
      try {
        const res = await apiFetch("/api/contacts/count", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            tagIds,
            contactIds,
            ...(channel ? { channel } : {}),
            ...(all ? { all: true } : {}),
          }),
          signal: controller.signal,
        });
        // A non-2xx (429 rate-limit, 401 session blip, 500 during an api
        // restart) still returns JSON, but without a `count` — parsing it would
        // zero the badge. Throw so the keep-last catch below handles it too.
        if (!res.ok) throw new Error(`count failed: ${res.status}`);
        const data = (await res.json()) as { count?: number };
        if (!cancelled) {
          setCount(data.count ?? 0);
          setResolved(true);
        }
      } catch {
        // Either an abort (a newer query superseded this one — `cancelled` is
        // already true, so no write), an HTTP error status, or a real network
        // error. On any real error
        // KEEP the last known count: zeroing it here disabled Send for a valid
        // audience on a transient blip. A genuinely-empty audience is already
        // handled by the early return above.
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, debounceMs);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagKey, contactKey, channel, all]);

  return { count, loading, resolved };
}
