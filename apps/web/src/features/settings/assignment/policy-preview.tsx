"use client";

import { useState } from "react";
import { Loader2, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api/client-fetch";

import type { PreviewResult } from "./types";

/** Plain-language explanation of each `AssignmentReason`. An admin debugging
 *  "why is nothing being assigned?" gets the answer here rather than from a
 *  server log they can't see. */
const REASON_COPY: Record<string, string> = {
  picked: "picked by this policy",
  fixed: "this policy always assigns one person",
  fallback: "everyone was full, so the fallback person took it",
  overflow_uncapped: "everyone was at their limit, and the policy ignores limits",
  manual_strategy: "this policy never auto-assigns",
  no_policy: "the team has no usable policy",
  no_candidates: "nobody is eligible right now — check who's online and who's in the policy",
  at_capacity: "everyone eligible is at their limit",
};

/**
 * "Who would take a conversation right now?" — run against LIVE presence and
 * workload, so it answers the question an admin actually has while configuring.
 *
 * Read-only on the server (`commit: false`): it never advances the rotation
 * cursor or the weighted counters, so clicking it repeatedly can't skew the
 * fairness state it's reporting on.
 */
export function PolicyPreview({ policyId }: { policyId: string }) {
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(false);

  const run = async () => {
    setRunning(true);
    setError(false);
    try {
      const res = await apiFetch("/api/team/assignment/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "inbound", policyId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setResult((await res.json()) as PreviewResult);
    } catch {
      setError(true);
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="rounded-md border border-dashed border-border px-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 text-sm">
          <span className="font-medium">Try it</span>
          <span className="ml-2 text-xs text-muted-foreground">
            Who would take a new conversation right now?
          </span>
        </div>
        <Button size="sm" variant="outline" onClick={() => void run()} disabled={running}>
          {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
          Run
        </Button>
      </div>
      {error && (
        <p className="mt-2 text-xs text-destructive">Couldn&apos;t run the preview.</p>
      )}
      {result && (
        <p className="mt-2 text-sm">
          {result.user ? (
            <>
              <span className="font-medium">{result.user.name}</span>
              <span className="text-muted-foreground">
                {" "}
                — {REASON_COPY[result.decision.reason] ?? result.decision.reason}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">
              Nobody — {REASON_COPY[result.decision.reason] ?? result.decision.reason}. The
              conversation would stay in the Unassigned queue.
            </span>
          )}
        </p>
      )}
    </div>
  );
}
