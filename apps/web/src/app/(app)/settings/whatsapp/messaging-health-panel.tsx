"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { Gauge, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@ccp/shared/utils";
import { Button } from "@/components/ui/button";
import { LocalTime } from "@/components/local-time";
import { apiFetch } from "@/lib/api/client-fetch";

/**
 * WhatsApp messaging health — what Meta currently allows this number to do.
 *
 * These numbers already existed and already gated broadcasts; they were just
 * never SHOWN. The result was a customer whose 8,000-recipient campaign got
 * refused with no way to see why, or who had no idea their quality rating had
 * slipped to RED until sends started failing.
 *
 * Reads `GET /api/broadcasts/messaging-health` — the same endpoint the
 * broadcast composer uses for its pre-send warning, deliberately reused rather
 * than duplicated so the settings page and the composer can never disagree
 * about the remaining budget.
 */

interface Health {
  messagingTier: string | null;
  messagingDailyCap: number | null;
  qualityRating: string | null;
  hasSnapshot: boolean;
  recentUniqueRecipients: number | null;
  remainingDailyBudget: number | null;
  throughputLevel: string | null;
  externalPortfolioId: string | null;
  portfolioAccountCount: number;
  messagingHealthUpdatedAt: string | null;
}

/** Meta publishes ~80 msg/s for STANDARD and up to ~1,000 for HIGH. */
const THROUGHPUT_LABEL: Record<string, string> = {
  STANDARD: "Standard · up to ~80 messages/second",
  HIGH: "High · up to ~1,000 messages/second",
};

export function MessagingHealthPanel({ canManage }: { canManage: boolean }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, startTransition] = useTransition();

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/broadcasts/messaging-health");
      if (!res.ok) return;
      setHealth((await res.json()) as Health);
    } catch {
      // Leave the last good value on screen. A transient blip must not blank a
      // panel whose whole job is to state the current limits.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function resync() {
    startTransition(async () => {
      const res = await apiFetch("/api/team/whatsapp/health/refresh", { method: "POST" });
      if (!res.ok) {
        toast.error(
          res.status === 429
            ? "Too many refreshes — try again in a minute."
            : "Couldn't reach Meta. The figures below are the last known good ones.",
        );
        return;
      }
      const body = (await res.json()) as { refreshed: boolean };
      // An honest outcome, not a blanket success toast: `refreshed:false` means
      // Meta didn't answer and what's on screen is still the OLD snapshot.
      if (body.refreshed) toast.success("Refreshed from Meta");
      else toast.warning("Meta didn't respond — showing the last known figures");
      await load();
    });
  }

  if (loading) {
    // Fixed height so the panel doesn't shift the page when it lands.
    return <div className="h-40 animate-pulse rounded-xl border border-border bg-muted/30" />;
  }
  if (!health) return null;

  const used = health.recentUniqueRecipients;
  const cap = health.messagingDailyCap;
  const pct = cap && used != null ? Math.min(100, Math.round((used / cap) * 100)) : null;

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Gauge className="size-4 text-muted-foreground" />
            Messaging health
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            What Meta currently allows this number to send. Updated automatically;
            refresh to pull it now.
          </p>
        </div>
        {canManage && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={resync}
            disabled={pending}
          >
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            Refresh
          </Button>
        )}
      </header>

      {!health.hasSnapshot ? (
        <p className="mt-4 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          No snapshot yet. Meta pushes these figures as they change, and we poll
          periodically — press Refresh to fetch them now. Until then, sends are
          not pre-checked against a limit (Meta still enforces the real one).
        </p>
      ) : (
        <>
          {/* The 24h budget is the number people actually act on, so it gets the
              bar and the top slot rather than being one row in a definition list. */}
          {cap != null && used != null ? (
            <div className="mt-4">
              <div className="flex items-baseline justify-between text-xs">
                <span className="font-medium">24-hour sending budget</span>
                <span className="tabular-nums text-muted-foreground">
                  {(health.remainingDailyBudget ?? 0).toLocaleString()} of{" "}
                  {cap.toLocaleString()} remaining
                </span>
              </div>
              <div
                className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-valuenow={pct ?? 0}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="24-hour sending budget used"
              >
                <div
                  className={cn(
                    "h-full rounded-full transition-[width] duration-500",
                    // Colour by headroom, not by a fixed palette: at 90% the
                    // next campaign is the one that gets refused.
                    (pct ?? 0) >= 90
                      ? "bg-destructive"
                      : (pct ?? 0) >= 70
                        ? "bg-warning-fg"
                        : "bg-success-fg",
                  )}
                  style={{ width: `${pct ?? 0}%` }}
                />
              </div>
              <p className="mt-1.5 text-2xs text-muted-foreground">
                {used.toLocaleString()} unique customer
                {used === 1 ? "" : "s"} messaged in the last 24 hours.
                {health.portfolioAccountCount > 1 && (
                  <>
                    {" "}
                    This budget is shared across{" "}
                    <strong>{health.portfolioAccountCount} numbers</strong> in the same
                    business portfolio.
                  </>
                )}
              </p>
            </div>
          ) : (
            <p className="mt-4 text-xs text-muted-foreground">
              No 24-hour cap — this portfolio is on an unlimited messaging tier.
            </p>
          )}

          <dl className="mt-4 grid grid-cols-[130px_1fr] gap-x-3 gap-y-2 border-t border-border pt-4 text-xs">
            <dt className="text-muted-foreground">Messaging tier</dt>
            <dd>{health.messagingTier ? tierLabel(health.messagingTier) : "Unknown"}</dd>

            <dt className="text-muted-foreground">Quality rating</dt>
            <dd>
              {health.qualityRating ? (
                <span
                  className={cn(
                    "rounded-full border px-1.5 py-0.5 text-2xs font-medium",
                    health.qualityRating === "GREEN" &&
                      "border-success-border bg-success-bg text-success-fg",
                    health.qualityRating === "YELLOW" &&
                      "border-warning-border bg-warning-bg text-warning-fg",
                    health.qualityRating === "RED" &&
                      "border-destructive/30 bg-destructive/10 text-destructive",
                  )}
                >
                  {health.qualityRating}
                </span>
              ) : (
                <span className="text-muted-foreground">Unknown</span>
              )}
              {health.qualityRating === "RED" && (
                <span className="ml-2 text-muted-foreground">
                  At risk of a tier downgrade — reduce volume and check your
                  templates.
                </span>
              )}
            </dd>

            <dt className="text-muted-foreground">Throughput</dt>
            <dd>
              {health.throughputLevel
                ? (THROUGHPUT_LABEL[health.throughputLevel] ?? health.throughputLevel)
                : "Unknown"}
            </dd>

            <dt className="text-muted-foreground">Business portfolio</dt>
            <dd className="min-w-0 break-all font-mono">
              {health.externalPortfolioId ?? (
                <span className="font-sans text-muted-foreground">
                  Not resolved — the connected token may lack{" "}
                  <span className="font-mono">business_management</span>.
                </span>
              )}
            </dd>

            <dt className="text-muted-foreground">Last synced</dt>
            <dd className="text-muted-foreground">
              {health.messagingHealthUpdatedAt ? (
                <LocalTime iso={health.messagingHealthUpdatedAt} format="localeString" />
              ) : (
                "Never"
              )}
            </dd>
          </dl>
        </>
      )}
    </section>
  );
}

/** "TIER_10K" → "10,000 customers / 24h". Meta's own vocabulary is opaque. */
function tierLabel(tier: string): string {
  if (tier === "TIER_UNLIMITED") return "Unlimited";
  const m = /^TIER_(\d+)(K?)$/.exec(tier);
  if (!m) return tier;
  const n = Number(m[1]) * (m[2] === "K" ? 1_000 : 1);
  return `${n.toLocaleString()} customers / 24h`;
}
