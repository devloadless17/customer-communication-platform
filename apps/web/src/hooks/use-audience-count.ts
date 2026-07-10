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
  }: { initial?: number; debounceMs?: number; channel?: string } = {},
): { count: number; loading: boolean } {
  const [count, setCount] = useState(initial);
  const [loading, setLoading] = useState(false);

  // Stable keys so the effect only re-runs on actual membership changes, not
  // on every render that produces a new array identity.
  const tagKey = tagIds.join(",");
  const contactKey = contactIds.join(",");

  useEffect(() => {
    if (tagIds.length === 0 && contactIds.length === 0) {
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
          body: JSON.stringify({ tagIds, contactIds, ...(channel ? { channel } : {}) }),
          signal: controller.signal,
        });
        // A non-2xx (429 rate-limit, 401 session blip, 500 during an api
        // restart) still returns JSON, but without a `count` — parsing it would
        // zero the badge. Throw so the keep-last catch below handles it too.
        if (!res.ok) throw new Error(`count failed: ${res.status}`);
        const data = (await res.json()) as { count?: number };
        if (!cancelled) setCount(data.count ?? 0);
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
  }, [tagKey, contactKey, channel]);

  return { count, loading };
}
