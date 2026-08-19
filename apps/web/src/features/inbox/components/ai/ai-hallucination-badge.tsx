"use client";

import { TriangleAlert } from "lucide-react";

import { useAiOverview } from "./ai-overview-context";

/**
 * "Worth a second look" flag on an outbound bubble. Only ever non-null for an
 * AI-authored reply scored at/above HALLUCINATION_FLAG_THRESHOLD server-side
 * (lib/ai/hallucination.ts); a human-sent message always renders nothing.
 *
 * Reads the thread's conversation-level rollup (AiOverviewProvider) — it does
 * NOT fetch. One badge per outbound bubble fetching its own flag was ~30
 * requests on thread open and hundreds after paging, two DB queries each. The
 * rollup's bounds carry over: the last 300 outbound messages, at most 25 flags,
 * newest first. Outside the provider (surfaces that don't mount the inbox
 * contexts) it renders nothing.
 */
export function AiHallucinationBadge({ messageId }: { messageId: string }) {
  const ai = useAiOverview();
  const flag = ai?.flagFor(messageId) ?? null;

  if (!flag) return null;

  return (
    <span
      title={
        flag.notes
          ? `Possibly unverified: ${flag.notes}`
          : "This AI reply may contain an unverified claim — worth a second look"
      }
      className="inline-flex shrink-0 items-center text-amber-600 dark:text-amber-400"
    >
      <TriangleAlert className="size-3" aria-label="AI reply flagged for review" />
    </span>
  );
}
