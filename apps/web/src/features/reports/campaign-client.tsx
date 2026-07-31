"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";

import { PageHeader } from "@/components/layouts/page-header";
import { LocalTime } from "@/components/local-time";
import { CHANNEL_LABEL } from "@/features/inbox/components/channel-badge";
import { apiFetch } from "@/lib/api/client-fetch";
import { cn } from "@ccp/shared/utils";
import type { Channel } from "@ccp/shared/types";

/**
 * ONE CAMPAIGN, READ END TO END.
 *
 * The page is built around a single idea: a headline number is only useful next
 * to the cut that explains it. So every section below answers the question the
 * section above provokes —
 *
 *   "62% delivered"        → which SEND dragged it down?      (per broadcast)
 *   "this send did badly"  → which ACCOUNT sent it?            (per account)
 *   "that Page failed"     → WHY?                              (failures)
 *   "we sent 40k messages" → what did Meta CHARGE for?          (cost)
 *   "who did we reach"     → where did those people COME from?  (sources)
 *
 * ## Whose numbers these are
 *
 * Every figure on this page is ours, counted from our own recipient rows as
 * Meta's delivery webhooks land. That matters, and the footnote says so: Meta's
 * own `template_analytics` read and click counts are only retained for **7 days
 * after send and then reset to zero**, so a campaign reviewed a month later
 * would read as having been read by nobody. The per-template panel on the
 * broadcast page is where Meta's figures live, clearly labelled as Meta's.
 */
interface Funnel {
  targeted: number;
  reached: number;
  read: number;
  failed: number;
  replied: number;
  clicked: number;
  optedOut: number;
}

interface Rollup extends Funnel {
  campaignName: string;
  broadcasts: Array<{
    id: string;
    name: string | null;
    channel: string;
    status: string;
    createdAt: string;
    funnel: Funnel;
  }>;
  accounts: Array<{
    accountId: string | null;
    label: string;
    channel: string | null;
    deleted: boolean;
    funnel: Funnel;
  }>;
  failures: Array<{
    code: string;
    label: string;
    bucket: string;
    metaCode: number | null;
    count: number;
  }>;
  cost: Array<{
    category: string | null;
    type: string | null;
    billable: boolean | null;
    count: number;
  }>;
  sources: Array<{
    source: string;
    sourceId: string | null;
    headline: string | null;
    contacts: number;
  }>;
  contactsReached: number;
  deliveryRate: number | null;
  readRate: number | null;
}

const SOURCE_LABEL: Record<string, string> = {
  ad: "Ad",
  post: "Post",
  ref: "Link",
  unknown: "Other",
};

/**
 * What Meta's `pricing.type` means in words. This is the column that makes a
 * mixed billable count explicable: two recipients of ONE utility campaign
 * legitimately differ, because the one who had messaged in the last 24 hours
 * rode an open service window for free.
 */
const PRICING_TYPE_LABEL: Record<string, string> = {
  regular: "Charged",
  free_customer_service: "Free — inside the customer's service window",
  free_entry_point: "Free — free-entry-point window",
  free_group_customer_service: "Free — group service window",
};

/** How alarming a failure bucket is, and what it implies about acting on it. */
const BUCKET_STYLE: Record<string, string> = {
  permanent: "bg-destructive/10 text-destructive",
  suppress: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  content: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  retryable: "bg-muted text-muted-foreground",
};

function pct(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

function num(v: number): string {
  return v.toLocaleString();
}

/** The five funnel numbers, as table cells. Used by both breakdown tables. */
function FunnelCells({ f }: { f: Funnel }) {
  return (
    <>
      <td className="px-3 py-2 text-right tabular-nums">{num(f.targeted)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{num(f.reached)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{num(f.read)}</td>
      <td className="px-3 py-2 text-right tabular-nums">
        {f.failed > 0 ? (
          <span className="text-destructive">{num(f.failed)}</span>
        ) : (
          num(f.failed)
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{num(f.replied)}</td>
      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
        {/* Delivery rate per row, computed from THIS row's counts — never
            inherited from the headline. That is the averaging-rates mistake the
            rollup's header warns about, just moved into the UI. */}
        {f.targeted > 0 ? `${Math.round((f.reached / f.targeted) * 100)}%` : "—"}
      </td>
    </>
  );
}

function FunnelHead({ first }: { first: string }) {
  return (
    <thead className="bg-muted/30 text-2xs uppercase tracking-wide text-muted-foreground">
      <tr>
        <th className="px-3 py-2 text-left font-medium">{first}</th>
        <th className="px-3 py-2 text-right font-medium">Sent to</th>
        <th className="px-3 py-2 text-right font-medium">Reached</th>
        <th className="px-3 py-2 text-right font-medium">Read</th>
        <th className="px-3 py-2 text-right font-medium">Failed</th>
        <th className="px-3 py-2 text-right font-medium">Replied</th>
        <th className="px-3 py-2 text-right font-medium">Rate</th>
      </tr>
    </thead>
  );
}

function Panel({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border bg-card p-5">
      <h2 className="text-sm font-semibold">{title}</h2>
      {hint && <p className="mt-1 mb-3 text-xs text-muted-foreground">{hint}</p>}
      <div className={cn(!hint && "mt-3")}>{children}</div>
    </section>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3">
      <p className="text-2xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-2xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

export function CampaignClient({ name }: { name: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<"missing" | "failed" | null>(null);
  const [data, setData] = useState<Rollup | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await apiFetch(
          `/api/reports/campaigns/${encodeURIComponent(name)}`,
        );
        if (res.status === 404) {
          if (!cancelled) setError("missing");
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as Rollup;
        if (!cancelled) setData(body);
      } catch {
        if (!cancelled) setError("failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [name]);

  // Same wrapper as the reports dashboard: SectionShell supplies no padding
  // of its own, so a page without it sits flush against the chrome and
  // reads as a different app.
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 px-4 py-6 sm:px-6 md:px-8">
      <Link
        href="/reports/campaigns"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Campaigns
      </Link>

      <PageHeader
        title={name}
        description={
          data
            ? `${data.broadcasts.length} ${data.broadcasts.length === 1 ? "send" : "sends"} · ${num(data.contactsReached)} people reached`
            : undefined
        }
      />

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading…
        </div>
      ) : error === "missing" ? (
        <p className="py-6 text-sm text-muted-foreground">
          No campaign by that name. It may have been renamed, or its broadcasts
          deleted.
        </p>
      ) : error || !data ? (
        <p className="py-6 text-sm text-muted-foreground">Couldn&apos;t load this campaign.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Sent to" value={num(data.targeted)} sub="recipients" />
            <Stat
              label="Reached"
              value={num(data.reached)}
              sub={`${pct(data.deliveryRate)} of sent`}
            />
            <Stat label="Read" value={num(data.read)} sub={`${pct(data.readRate)} of reached`} />
            <Stat label="Replied" value={num(data.replied)} />
            <Stat label="Clicked" value={num(data.clicked)} />
            <Stat
              label="Failed"
              value={num(data.failed)}
              // Opt-outs sit under Failed rather than in their own tile: they
              // are the number a marketer must weigh against reach, and burying
              // them in a seventh tile is how a rising opt-out rate goes unread.
              sub={data.optedOut > 0 ? `${num(data.optedOut)} opted out` : undefined}
            />
          </div>

          <Panel
            title="By send"
            hint="Each broadcast in this campaign, counted on its own. A campaign average hides the one send that went wrong."
          >
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-xs">
                <FunnelHead first="Send" />
                <tbody>
                  {data.broadcasts.map((b) => (
                    <tr key={b.id} className="border-t border-border">
                      <td className="px-3 py-2">
                        <Link
                          href={`/broadcasts/${b.id}`}
                          className="font-medium hover:underline"
                        >
                          {b.name ?? "Untitled send"}
                        </Link>
                        <span className="block text-2xs text-muted-foreground">
                          {CHANNEL_LABEL[b.channel as Channel] ?? b.channel} ·{" "}
                          <LocalTime iso={b.createdAt} format="shortDate" />
                        </span>
                      </td>
                      <FunnelCells f={b.funnel} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          {data.accounts.length > 0 && (
            <Panel
              title="By sending account"
              hint="Which number, Page or Instagram account each recipient was reached from. On Messenger and Instagram a customer can only be reached from the account that first talked to them, so one restricted Page shows up here as a block of failures and nowhere else."
            >
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-xs">
                  <FunnelHead first="Account" />
                  <tbody>
                    {data.accounts.map((a) => (
                      <tr key={a.accountId ?? "campaign"} className="border-t border-border">
                        <td className="px-3 py-2">
                          <span className="font-medium">{a.label}</span>
                          {a.deleted && (
                            <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-3xs text-muted-foreground">
                              disconnected
                            </span>
                          )}
                          {a.channel && (
                            <span className="block text-2xs text-muted-foreground">
                              {CHANNEL_LABEL[a.channel as Channel] ?? a.channel}
                            </span>
                          )}
                        </td>
                        <FunnelCells f={a.funnel} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}

          {data.failures.length > 0 && (
            <Panel
              title="Why messages failed"
              hint="Meta's reason for every message that never reached a handset, in the same words the broadcast report uses."
            >
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                {data.failures.map((f) => (
                  <li key={f.code} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium">{f.label}</p>
                      <p className="text-2xs text-muted-foreground">
                        {f.code}
                        {/* Meta's raw numeric code. Shown because it is what you
                            paste into a Meta support thread — our normalized
                            name means nothing to them. */}
                        {f.metaCode !== null && ` · Meta ${f.metaCode}`}
                      </p>
                    </div>
                    <span
                      className={cn(
                        "shrink-0 rounded px-1.5 py-0.5 text-3xs font-medium",
                        BUCKET_STYLE[f.bucket] ?? BUCKET_STYLE.retryable,
                      )}
                    >
                      {f.bucket}
                    </span>
                    <span className="w-16 shrink-0 text-right text-xs tabular-nums">
                      {num(f.count)}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          {data.cost.length > 0 && (
            <Panel
              title="What Meta charged for"
              hint="Meta reports a pricing category and whether the message was billable — never an amount, because rates are per-country cards that change. Apply your own rate card to these counts."
            >
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/30 text-2xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Category</th>
                      <th className="px-3 py-2 text-left font-medium">Why</th>
                      <th className="px-3 py-2 text-right font-medium">Messages</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.cost.map((c, i) => (
                      <tr key={`${c.category}:${c.type}:${i}`} className="border-t border-border">
                        <td className="px-3 py-2 font-medium capitalize">
                          {c.category ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {(c.type && PRICING_TYPE_LABEL[c.type]) ??
                            c.type ??
                            (c.billable === false ? "Free" : "—")}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{num(c.count)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-2xs text-muted-foreground">
                {num(data.cost.filter((c) => c.billable).reduce((n, c) => n + c.count, 0))}{" "}
                billable of {num(data.cost.reduce((n, c) => n + c.count, 0))} priced.
              </p>
            </Panel>
          )}

          {data.sources.length > 0 && (
            <Panel
              title="Where the people you reached came from"
              hint="The ad, post or link that first brought each of these customers to you — counted on their first attributed message, so it survives however many campaigns they have been in since."
            >
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/30 text-2xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Source</th>
                      <th className="px-3 py-2 text-left font-medium">Identifier</th>
                      <th className="px-3 py-2 text-right font-medium">People</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sources.map((s, i) => (
                      <tr key={`${s.source}:${s.sourceId ?? i}`} className="border-t border-border">
                        <td className="px-3 py-2">
                          <span className="font-medium">
                            {SOURCE_LABEL[s.source] ?? s.source}
                          </span>
                          {s.headline && (
                            <span className="block truncate text-2xs text-muted-foreground">
                              {s.headline}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <span className="font-mono text-2xs text-muted-foreground">
                            {s.sourceId ?? "—"}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{num(s.contacts)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}

          <p className="text-2xs leading-relaxed text-muted-foreground">
            Counted from delivery receipts as they arrive, and kept for as long
            as the campaign exists. Meta&apos;s own read and click figures expire
            seven days after a message is sent — the per-template panel on each
            broadcast shows those separately, labelled as Meta&apos;s.
          </p>
        </>
      )}
    </div>
  );
}
