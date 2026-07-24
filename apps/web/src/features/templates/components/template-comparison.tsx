"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, Trophy } from "lucide-react";

import { apiFetch } from "@/lib/api/client-fetch";
import type { TemplateDto } from "@ccp/shared/types";
import { cn } from "@ccp/shared/utils";

/**
 * Head-to-head comparison of two templates — Meta's own verdict on which one
 * customers block less, how often each was sent, and each one's top block
 * reason.
 *
 * Two things about this data shape drive the whole design:
 *
 *   1. **Meta gives the block-rate ORDER, never the rate.** So this renders a
 *      winner, not a number. Inventing a percentage from the ordering would be
 *      fabrication.
 *   2. **Meta answers a constraint violation with an EMPTY result**, not an
 *      error. The commonest cause by far is a template under the 1,000-send
 *      threshold for the window — so an empty answer is reported as exactly that
 *      rather than drawn as a tie.
 */

const WINDOWS = [7, 30, 60, 90] as const;

interface ComparisonResult {
  days: number;
  blockRateOrder: string[];
  sends: Array<{ templateId: string; count: number }>;
  topBlockReasons: Array<{ templateId: string; reason: string }>;
  enoughData: boolean;
}

/** Meta's block-reason enum, in the words a human would use. */
function blockReasonLabel(reason: string): string {
  switch (reason) {
    case "NO_LONGER_NEEDED":
      return "No longer needed";
    case "NO_SIGN_UP":
      return "Didn't sign up for this";
    case "OFFENSIVE_MESSAGES":
      return "Offensive messages";
    case "OTP_DID_NOT_REQUEST":
      return "Didn't request the code";
    case "SPAM":
      return "Spam";
    case "OTHER":
      return "Other";
    case "NO_REASON":
    case "NO_REASON_GIVEN":
      return "No reason given";
    case "UNKNOWN_BLOCK_REASON":
      return "Not reported";
    default:
      return reason;
  }
}

export function TemplateComparison({
  template,
  candidates,
}: {
  template: TemplateDto;
  /** Every other template in the workspace — filtered to this one's WABA. */
  candidates: TemplateDto[];
}) {
  const [againstId, setAgainstId] = useState("");
  const [days, setDays] = useState<number>(30);
  const [result, setResult] = useState<ComparisonResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Comparison is WABA-scoped at Meta, so offering a template from another
  // account would only ever produce an error.
  const eligible = candidates.filter(
    (t) => t.id !== template.id && t.wabaId === template.wabaId && t.externalId,
  );

  const run = useCallback(async () => {
    if (!againstId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(
        `/api/workspace/whatsapp/templates/${template.id}/compare?against=${encodeURIComponent(
          againstId,
        )}&days=${days}`,
      );
      const data = (await res.json()) as ComparisonResult & {
        error?: string;
        detail?: string;
      };
      if (!res.ok) {
        throw new Error(
          [data.error, data.detail].filter(Boolean).join(": ") || `HTTP ${res.status}`,
        );
      }
      setResult(data);
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : "Comparison failed");
    } finally {
      setLoading(false);
    }
  }, [template.id, againstId, days]);

  // Re-run whenever the selection changes — the picker IS the query.
  useEffect(() => {
    if (againstId) void run();
    else setResult(null);
  }, [againstId, days, run]);

  if (!template.externalId) {
    return (
      <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        This template hasn&apos;t synced to Meta yet, so there&apos;s nothing to
        compare.
      </p>
    );
  }
  if (eligible.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        Comparison needs a second template on the same WhatsApp Business Account.
      </p>
    );
  }

  const nameOf = (id: string) =>
    id === template.id ? template.name : eligible.find((t) => t.id === id)?.name ?? id;
  const sendsOf = (id: string) =>
    result?.sends.find((s) => s.templateId === id)?.count ?? null;
  const reasonOf = (id: string) =>
    result?.topBlockReasons.find((r) => r.templateId === id)?.reason ?? null;
  const winner = result?.blockRateOrder[0] ?? null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={againstId}
          onChange={(e) => setAgainstId(e.target.value)}
          className="h-8 min-w-45 rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="">Compare with…</option>
          {eligible.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.language})
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1">
          {WINDOWS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              aria-pressed={days === d}
              className={cn(
                "rounded-full border px-2 py-0.5 text-2xs transition-colors",
                days === d
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:bg-accent/40",
              )}
            >
              {d}d
            </button>
          ))}
        </div>
        {loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="wrap-break-word">{error}</span>
        </div>
      )}

      {result && !result.enoughData && (
        <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          Meta has no verdict for this window. It only compares templates that
          were each sent at least <span className="font-medium">1,000 times</span>{" "}
          in the period — try a longer window.
        </div>
      )}

      {result?.enoughData && (
        <div className="grid grid-cols-2 gap-2">
          {[template.id, againstId].map((id) => (
            <div
              key={id}
              className={cn(
                "rounded-lg border p-3",
                winner === id ? "border-success-border bg-success-bg/40" : "border-border",
              )}
            >
              <div className="flex items-center gap-1.5">
                {winner === id && <Trophy className="size-3.5 text-success-fg" />}
                <span className="truncate text-xs font-medium">{nameOf(id)}</span>
              </div>
              <dl className="mt-2 flex flex-col gap-1 text-2xs">
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">Sent</dt>
                  <dd className="font-medium tabular-nums">
                    {sendsOf(id)?.toLocaleString() ?? "—"}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">Top block reason</dt>
                  <dd className="truncate text-right font-medium">
                    {reasonOf(id) ? blockReasonLabel(reasonOf(id)!) : "—"}
                  </dd>
                </div>
              </dl>
            </div>
          ))}
        </div>
      )}

      {result?.enoughData && winner && (
        <p className="text-2xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">{nameOf(winner)}</span> has
          the lower block rate over the last {result.days} days. Meta reports the
          ranking only — not the rate itself — so there is no percentage to show.
        </p>
      )}
    </div>
  );
}
