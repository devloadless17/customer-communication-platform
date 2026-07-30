"use client";

import { useEffect, useState } from "react";
import { Info } from "lucide-react";

import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import { LocalTime } from "@/components/local-time";

/**
 * What WhatsApp actually COST — Meta's own account-level analytics.
 *
 * A deliberately SEPARATE panel with its own request, for two reasons. It reads
 * Meta over the network rather than our database, so it is an order of magnitude
 * slower than the rest of the dashboard and must never hold the page hostage;
 * and it measures a different thing. Every other number on /reports counts what
 * WE sent, from our own message rows. These count what META DELIVERED AND
 * CHARGED FOR. The two legitimately differ — a message we sent and Meta never
 * delivered is in one and not the other — so they sit apart and are never summed.
 *
 * Per WhatsApp Business Account, never pooled: currency and Meta's volume-tier
 * ladders are per-WABA, so adding two accounts' spend would produce a figure in
 * no currency, and one account's outage would read as a company-wide drop.
 */

interface TierStanding {
  country: string | null;
  category: string | null;
  tier: string;
  volume: number;
  upper: number | null;
  /** How many more messages buy the cheaper rate. Null = unbounded tier. */
  toNextTier: number | null;
}

interface PricingSlice {
  category: string | null;
  type: string | null;
  country: string | null;
  volume: number;
  cost: number | null;
}

interface CallSlice {
  direction: string | null;
  country: string | null;
  count: number;
  cost: number | null;
  averageDurationSec: number | null;
}

interface WabaAccount {
  wabaAccountId: string;
  externalWabaId: string;
  label: string | null;
  currency: string | null;
  insightsEnabled: boolean;
  unavailable: string | null;
  pricing: PricingSlice[];
  tiers: TierStanding[];
  calls: CallSlice[];
  totals: {
    sent: number;
    delivered: number;
    billableVolume: number;
    freeVolume: number;
    messagingCost: number | null;
    callCost: number | null;
    conversations: number;
    calls: number;
  };
  costWithheld: boolean;
}

interface WabaAnalyticsResult {
  from: string;
  to: string;
  accounts: WabaAccount[];
  fetchedAt: string;
}

/** Meta's pricing categories, in the operator's words. Unknown values pass
 *  through raw rather than being dropped — Meta adds categories (GROUP_*,
 *  MARKETING_LITE_DYNAMIC, AI_BOT) and a new one must stay visible. */
const CATEGORY_LABEL: Record<string, string> = {
  MARKETING: "Marketing",
  MARKETING_LITE: "Marketing (Lite)",
  MARKETING_LITE_DYNAMIC: "Marketing (Lite, dynamic)",
  UTILITY: "Utility",
  AUTHENTICATION: "Authentication",
  AUTHENTICATION_INTERNATIONAL: "Authentication (international)",
  SERVICE: "Service (free)",
  REFERRAL_CONVERSION: "Referral conversion",
  AI_BOT: "AI bot",
  GROUP_MARKETING: "Group marketing",
  GROUP_UTILITY: "Group utility",
  GROUP_SERVICE: "Group service (free)",
  GROUP_MARKETING_LITE: "Group marketing (Lite)",
};

/** Why a message wasn't charged — the answer to "same campaign, different bill". */
const TYPE_LABEL: Record<string, string> = {
  REGULAR: "Billed",
  FREE_CUSTOMER_SERVICE: "Free — service window",
  FREE_ENTRY_POINT: "Free — entry point",
  FREE_GROUP_CUSTOMER_SERVICE: "Free — group service window",
};

function label(map: Record<string, string>, v: string | null): string {
  if (!v) return "—";
  return map[v.toUpperCase()] ?? v.replaceAll("_", " ").toLowerCase();
}

export function WhatsappSpendPanel({ days }: { days: number }) {
  const [data, setData] = useState<WabaAnalyticsResult | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    setData(null);
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    const qs = new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
      granularity: "day",
    });
    void (async () => {
      try {
        const res = await fetchWithSessionGuard(`/api/reports/whatsapp-analytics?${qs}`);
        if (cancelled) return;
        if (!res.ok) {
          setState("error");
          return;
        }
        const body = (await res.json()) as WabaAnalyticsResult;
        if (cancelled) return;
        setData(body);
        setState("ready");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [days]);

  // No WhatsApp account at all — render nothing rather than an empty money
  // panel. A workspace on Messenger only has no WhatsApp spend to report, and an
  // explanatory placeholder for a channel they don't use is pure noise.
  if (state === "ready" && data && data.accounts.length === 0) return null;

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <header>
        <h3 className="text-sm font-semibold">WhatsApp spend &amp; volume tiers</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Meta&apos;s own figures for what it <strong>delivered and charged for</strong>.
          Separate from the volumes above, which count what we sent — the two
          measure different things and won&apos;t match exactly.
        </p>
        {data && (
          <p className="mt-0.5 text-2xs text-muted-foreground/80">
            Read from Meta <LocalTime iso={data.fetchedAt} format="listTime" /> · cached
            for a few minutes so switching ranges doesn&apos;t spend the
            account&apos;s API budget
          </p>
        )}
      </header>

      {state === "loading" && (
        <div className="mt-4 flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-6 animate-pulse rounded bg-muted/30" />
          ))}
        </div>
      )}

      {state === "error" && (
        <p className="mt-4 text-xs text-muted-foreground">
          Couldn&apos;t read analytics from Meta. The rest of this page is
          unaffected — it comes from our own records.
        </p>
      )}

      {state === "ready" &&
        data?.accounts.map((account) => (
          <AccountBlock key={account.wabaAccountId} account={account} />
        ))}
    </section>
  );
}

function AccountBlock({ account }: { account: WabaAccount }) {
  const money = (v: number | null): string | null =>
    v === null
      ? null
      : new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: account.currency || "USD",
          maximumFractionDigits: 2,
        }).format(v);

  const totalCost =
    account.totals.messagingCost === null && account.totals.callCost === null
      ? null
      : (account.totals.messagingCost ?? 0) + (account.totals.callCost ?? 0);

  // Biggest spend first — the row an operator is looking for is the expensive
  // one, and a category-alphabetical table buries it.
  const spend = [...account.pricing]
    .filter((s) => s.volume > 0 || (s.cost ?? 0) > 0)
    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.volume - a.volume)
    .slice(0, 12);

  return (
    <div className="mt-4 border-t border-border pt-4 first:mt-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-xs font-medium">
          {account.label || `WABA ${account.externalWabaId.slice(-6)}`}
          {account.currency && (
            <span className="ml-1.5 font-normal text-muted-foreground">
              {account.currency}
            </span>
          )}
        </h4>
        {!account.insightsEnabled && (
          <span className="text-2xs text-muted-foreground">
            Template analytics not switched on for this account
          </span>
        )}
      </div>

      {account.unavailable ? (
        <p className="mt-2 text-xs text-muted-foreground">{account.unavailable}</p>
      ) : (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            <Stat
              label="Total cost"
              value={money(totalCost)}
              nullReason={
                account.costWithheld
                  ? "Withheld — this account is billed through a partner"
                  : "Not reported for this range"
              }
            />
            <Stat label="Delivered" value={account.totals.delivered.toLocaleString()} />
            <Stat
              label="Billed messages"
              value={account.totals.billableVolume.toLocaleString()}
              hint={`${account.totals.freeVolume.toLocaleString()} free`}
            />
            <Stat
              label="Calls"
              value={account.totals.calls.toLocaleString()}
              hint={money(account.totals.callCost) ?? undefined}
            />
          </dl>

          {account.tiers.length > 0 && (
            <div className="mt-4">
              <h5 className="text-2xs font-medium text-muted-foreground">
                Volume tiers
              </h5>
              {/* The only actionable number Meta gives on pricing: how many more
                  messages to the cheaper rate. Marketing is pinned at 0:MAX
                  (tiers don't apply) and free messages carry no tier at all, so
                  an unbounded row says so rather than drawing an empty bar to a
                  target that doesn't exist. */}
              <ul className="mt-1.5 space-y-1">
                {account.tiers.map((t) => (
                  <li
                    key={`${t.country}-${t.category}-${t.tier}`}
                    className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/20 px-2.5 py-1.5 text-xs"
                  >
                    <span className="min-w-0 truncate">
                      {label(CATEGORY_LABEL, t.category)}
                      {t.country && (
                        <span className="text-muted-foreground"> · {t.country}</span>
                      )}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {t.volume.toLocaleString()}
                      {t.upper === null ? (
                        <span className="ml-1 font-normal">· no tier ceiling</span>
                      ) : (
                        <span className="ml-1 font-normal">
                          / {t.upper.toLocaleString()} ·{" "}
                          <strong className="font-medium text-foreground">
                            {(t.toNextTier ?? 0).toLocaleString()} to next tier
                          </strong>
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {spend.length > 0 && (
            <div className="mt-4">
              <h5 className="text-2xs font-medium text-muted-foreground">
                Where it went
              </h5>
              <ul className="mt-1.5 space-y-1">
                {spend.map((s, i) => (
                  <li
                    key={`${s.category}-${s.type}-${s.country}-${i}`}
                    className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/20 px-2.5 py-1.5 text-xs"
                  >
                    <span className="min-w-0 truncate">
                      {label(CATEGORY_LABEL, s.category)}
                      <span className="text-muted-foreground">
                        {" · "}
                        {label(TYPE_LABEL, s.type)}
                        {s.country ? ` · ${s.country}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {money(s.cost) ?? "—"}
                      <span className="ml-1.5 font-normal text-muted-foreground">
                        {s.volume.toLocaleString()} msg
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {account.calls.some((c) => c.count > 0) && (
            <div className="mt-4">
              <h5 className="text-2xs font-medium text-muted-foreground">Calls</h5>
              <ul className="mt-1.5 space-y-1">
                {account.calls
                  .filter((c) => c.count > 0)
                  .map((c, i) => (
                    <li
                      key={`${c.direction}-${c.country}-${i}`}
                      className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/20 px-2.5 py-1.5 text-xs"
                    >
                      <span className="min-w-0 truncate">
                        {c.direction === "USER_INITIATED"
                          ? "Customer called us"
                          : c.direction === "BUSINESS_INITIATED"
                            ? "We called the customer"
                            : "Calls"}
                        {c.country && (
                          <span className="text-muted-foreground"> · {c.country}</span>
                        )}
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {c.count.toLocaleString()}
                        {c.averageDurationSec !== null && (
                          <span className="ml-1.5 font-normal text-muted-foreground">
                            avg {Math.round(c.averageDurationSec)}s
                          </span>
                        )}
                        {/* User-initiated calls are ALWAYS free at Meta — saying
                            so beats a zero that reads as missing data. */}
                        <span className="ml-1.5 font-normal text-muted-foreground">
                          {c.direction === "USER_INITIATED"
                            ? "free"
                            : (money(c.cost) ?? "—")}
                        </span>
                      </span>
                    </li>
                  ))}
              </ul>
            </div>
          )}

          {account.costWithheld && (
            <p className="mt-3 flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-2.5 text-2xs text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <span>
                Meta reported volume but no cost for this account — the documented
                behaviour when a WhatsApp Business Account is billed through a
                Solution Partner. Volumes and tiers above are still exact; ask
                your partner for the charges.
              </span>
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** One figure. A null renders its REASON, never a bare dash. */
function Stat({
  label: text,
  value,
  hint,
  nullReason,
}: {
  label: string;
  value: string | null;
  hint?: string;
  nullReason?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs text-muted-foreground">{text}</dt>
      <dd className="mt-0.5 truncate text-sm font-semibold tabular-nums">
        {value ?? (
          <span className="text-xs font-normal text-muted-foreground">Not reported</span>
        )}
      </dd>
      {value === null && nullReason && (
        <p className="mt-0.5 text-4xs leading-tight text-muted-foreground/80">
          {nullReason}
        </p>
      )}
      {value !== null && hint && (
        <p className="mt-0.5 text-4xs leading-tight text-muted-foreground/80">{hint}</p>
      )}
    </div>
  );
}
