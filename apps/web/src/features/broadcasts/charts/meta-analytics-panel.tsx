"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Info, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { apiFetch } from "@/lib/api/client-fetch";
import { Button } from "@/components/ui/button";
import { LocalTime } from "@/components/local-time";

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
  /** Per-button engagement: which button, quick-reply vs URL, unique vs total. */
  clickedButtons: Array<{
    type: string;
    buttonContent: string | null;
    count: number;
  }> | null;
  costAmountSpent: number | null;
  costPerDelivered: number | null;
  currency: string | null;
  days: number;
  costWithheld: boolean;
  /** When these figures were last pulled from Meta. */
  fetchedAt: string | null;
}

/** Meta's aggregate moves on a scale of hours; fresher than this and an
 *  auto-fetch would just spend Graph budget re-reading the same numbers. */
const AUTO_FETCH_STALE_MS = 6 * 60 * 60_000;

/** Human label for Meta's click-entry types. Unknown types pass through raw
 *  rather than being dropped — a new Meta type must stay visible. */
const CLICK_TYPE_LABELS: Record<string, string> = {
  url_button: "clicks",
  unique_url_button: "unique clicks",
  quick_reply_button: "taps",
};

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

  // Self-updating: pull from Meta once on open when nothing is stored or the
  // stored figures are stale — the operator shouldn't have to know a Fetch
  // button exists to see their campaign's cost and clicks. ONE attempt per
  // mount, silent on failure (the manual button still surfaces errors), so a
  // broken account can't turn every report-open into a toast storm — and the
  // 6h staleness gate keeps repeated opens from spending Graph budget.
  const autoFetchedRef = useRef(false);
  useEffect(() => {
    if (autoFetchedRef.current) return;
    const stale =
      !analytics?.fetchedAt ||
      Date.now() - Date.parse(analytics.fetchedAt) > AUTO_FETCH_STALE_MS;
    if (!stale) return;
    autoFetchedRef.current = true;
    void (async () => {
      try {
        const res = await apiFetch(`/api/broadcasts/${broadcastId}/analytics/refresh`, {
          method: "POST",
        });
        if (!res.ok) return;
        const body = (await res.json()) as { rows: number };
        if (body.rows > 0) onRefreshed?.();
      } catch {
        // Silent — the panel renders whatever is stored, and the manual
        // button remains the loud path.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [broadcastId]);

  function refresh() {
    startTransition(async () => {
      const res = await apiFetch(`/api/broadcasts/${broadcastId}/analytics/refresh`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          detail?: string;
        };
        toast.error(
          body.error === "template_insights_not_enabled"
            ? "Turn on template analytics in Settings → WhatsApp first."
            : body.error === "template_not_synced"
              ? "This campaign's template isn't synced from Meta yet."
              : body.error === "broadcast_has_no_template"
                ? "Only template campaigns have Meta analytics."
                : // Meta's own sentence when we have it — "Couldn't fetch"
                  // with no reason is a dead end the operator can't act on
                  // (and can't even report usefully).
                  body.detail
                  ? `Meta refused the fetch: ${body.detail}`
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
          {/* The freshness contract, stated instead of implied: these numbers
              are a slow-moving aggregate that the server re-captures on its
              own — not a live feed, and not something the operator must
              babysit with the button. */}
          <p className="mt-0.5 text-2xs text-muted-foreground/80">
            {analytics?.fetchedAt ? (
              <>
                Updated <LocalTime iso={analytics.fetchedAt} format="listTime" /> · re-captured
                automatically while Meta still reports this campaign
              </>
            ) : (
              "Fetches automatically when you open this report"
            )}
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
            {/* Derived from Meta's own totals, never mixed with the funnel's:
                the rates people quote when they compare campaigns. */}
            <Stat
              label="Read rate"
              value={
                analytics.read !== null && analytics.delivered > 0
                  ? `${Math.round((analytics.read / analytics.delivered) * 100)}%`
                  : null
              }
              nullReason="Needs read data"
            />
            <Stat
              label="Click rate"
              value={
                analytics.clicked !== null && analytics.delivered > 0
                  ? `${Math.round((analytics.clicked / analytics.delivered) * 100)}%`
                  : null
              }
              nullReason="Needs click data"
            />
            <Stat
              label="Cost / link click"
              value={
                analytics.costAmountSpent !== null &&
                analytics.clicked !== null &&
                analytics.clicked > 0
                  ? money(analytics.costAmountSpent / analytics.clicked)
                  : null
              }
              nullReason="Needs cost and click data"
            />
            <Stat
              label="Days covered"
              value={`${analytics.days} day${analytics.days === 1 ? "" : "s"}`}
            />
          </dl>

          {analytics.clickedButtons && analytics.clickedButtons.length > 0 && (
            <div className="mt-4">
              <h4 className="text-2xs font-medium text-muted-foreground">
                Button engagement
              </h4>
              <ul className="mt-1.5 space-y-1">
                {analytics.clickedButtons.map((b, i) => (
                  <li
                    key={`${b.type}-${b.buttonContent ?? i}`}
                    className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/20 px-2.5 py-1.5 text-xs"
                  >
                    <span className="min-w-0 truncate">
                      {b.buttonContent ?? "Button"}
                    </span>
                    <span className="shrink-0 tabular-nums font-medium">
                      {b.count.toLocaleString()}{" "}
                      <span className="font-normal text-muted-foreground">
                        {CLICK_TYPE_LABELS[b.type] ?? b.type.replaceAll("_", " ")}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

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
