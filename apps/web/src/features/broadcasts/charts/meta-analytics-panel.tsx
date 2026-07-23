"use client";

import { useState, useTransition } from "react";
import { Info, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { apiFetch } from "@/lib/api/client-fetch";
import { Button } from "@/components/ui/button";

/**
 * Meta's own aggregate figures for the campaign's template, shown BESIDE the
 * delivery funnel and never merged into it.
 *
 * The two sources measure different things and will not agree exactly. Our
 * funnel is per-recipient truth from status webhooks and is the only source of
 * `replied` and opt-outs. Meta's is an aggregate and is the only source of real
 * CURRENCY COST and of unique URL-button clicks. Averaging them would produce a
 * number matching neither — and one that silently changes meaning as Meta's
 * 7-day read/click window expires.
 *
 * So every null here gets a REASON rather than a dash. "—" with no explanation
 * is what makes people assume the feature is broken.
 */

export interface MetaAnalytics {
  sent: number;
  delivered: number;
  read: number | null;
  clicked: number | null;
  costAmountSpent: number | null;
  costPerDelivered: number | null;
  currency: string | null;
  days: number;
  costWithheld: boolean;
}

export function MetaAnalyticsPanel({
  broadcastId,
  analytics,
  onRefreshed,
}: {
  broadcastId: string;
  analytics: MetaAnalytics | null;
  onRefreshed?: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [dismissedHint, setDismissedHint] = useState(false);

  function refresh() {
    startTransition(async () => {
      const res = await apiFetch(`/api/broadcasts/${broadcastId}/analytics/refresh`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(
          body.error === "template_insights_not_enabled"
            ? "Turn on template analytics in Settings → WhatsApp first."
            : body.error === "template_not_synced"
              ? "This campaign's template isn't synced from Meta yet."
              : body.error === "broadcast_has_no_template"
                ? "Only template campaigns have Meta analytics."
                : "Couldn't fetch from Meta.",
        );
        return;
      }
      const body = (await res.json()) as { rows: number; costWithheld: boolean };
      if (body.rows === 0) {
        toast.warning("Meta has no data for this campaign's dates yet.");
      } else {
        toast.success(`Updated ${body.rows} day${body.rows === 1 ? "" : "s"} from Meta`);
      }
      onRefreshed?.();
    });
  }

  const money = (v: number | null) =>
    v === null
      ? null
      : new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: analytics?.currency || "USD",
          maximumFractionDigits: 2,
        }).format(v);

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Meta analytics</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Meta&apos;s own figures for this template. Shown separately from the
            funnel above — they measure different things and won&apos;t match exactly.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={pending}>
          {pending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          Fetch
        </Button>
      </header>

      {!analytics ? (
        <p className="mt-4 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          Nothing fetched yet. Press Fetch to pull this campaign&apos;s figures from
          Meta. If it reports nothing, template analytics may not be enabled for
          your account — that&apos;s a one-time switch in Settings → WhatsApp.
        </p>
      ) : (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            <Stat label="Sent" value={analytics.sent.toLocaleString()} />
            <Stat label="Delivered" value={analytics.delivered.toLocaleString()} />
            <Stat
              label="Read"
              value={analytics.read?.toLocaleString() ?? null}
              // The single most misread null in this panel: Meta simply stops
              // reporting reads after ~7 days. Saying so beats a bare dash.
              nullReason="Meta reports reads for 7 days only"
            />
            <Stat
              label="Link clicks"
              value={analytics.clicked?.toLocaleString() ?? null}
              nullReason="No URL buttons, or outside Meta's 7-day window"
            />
            <Stat
              label="Cost"
              value={money(analytics.costAmountSpent)}
              nullReason={
                analytics.costWithheld
                  ? "Withheld — this account is billed through a partner"
                  : "Not reported for these dates"
              }
            />
            <Stat label="Cost / delivered" value={money(analytics.costPerDelivered)} />
            <Stat
              label="Days covered"
              value={`${analytics.days} day${analytics.days === 1 ? "" : "s"}`}
            />
          </dl>

          {!dismissedHint && (
            <button
              type="button"
              onClick={() => setDismissedHint(true)}
              className="mt-4 flex w-full cursor-pointer items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-left text-2xs text-muted-foreground transition-colors hover:bg-muted/50"
            >
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <span>
                These cover the whole <strong>template</strong> on the days this
                campaign ran. If another campaign used the same template on the
                same day, its volume is included here — the funnel above is the
                one scoped strictly to this campaign. Tap to dismiss.
              </span>
            </button>
          )}
        </>
      )}
    </section>
  );
}

/** One figure. A null renders its REASON, never a bare dash. */
function Stat({
  label,
  value,
  nullReason,
}: {
  label: string;
  value: string | null;
  nullReason?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-semibold tabular-nums">
        {value ?? <span className="text-xs font-normal text-muted-foreground">Not reported</span>}
      </dd>
      {value === null && nullReason && (
        <p className="mt-0.5 text-4xs leading-tight text-muted-foreground/80">{nullReason}</p>
      )}
    </div>
  );
}
