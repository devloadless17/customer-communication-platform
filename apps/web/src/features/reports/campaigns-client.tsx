"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, ChevronRight, Loader2, Megaphone } from "lucide-react";

import { PageHeader } from "@/components/layouts/page-header";
import { LocalTime } from "@/components/local-time";
import { apiFetch } from "@/lib/api/client-fetch";

/**
 * Every campaign in the workspace.
 *
 * A campaign is a NAME an operator typed on one or more broadcasts, not a
 * modelled entity — which is deliberate: a campaign is a human grouping of
 * sends ("spring sale"), and the moment it becomes a row with its own lifecycle
 * you inherit the question of what happens when a broadcast is deleted, moved,
 * or renamed. The name is the join key, so the answer is "nothing to reconcile".
 *
 * The cost of that is real and worth naming: two spellings are two campaigns.
 * The composer offers existing names as suggestions for exactly this reason.
 */
interface CampaignRow {
  campaignName: string;
  broadcasts: number;
  lastSentAt: string | null;
}

export function CampaignsClient() {
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [rows, setRows] = useState<CampaignRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch("/api/reports/campaigns");
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { campaigns: CampaignRow[] };
        if (!cancelled) setRows(body.campaigns);
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Same wrapper as the reports dashboard: SectionShell supplies no padding
  // of its own, so a page without it sits flush against the chrome and
  // reads as a different app.
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 px-4 py-6 sm:px-6 md:px-8">
      <Link
        href="/reports"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Reports
      </Link>

      <PageHeader
        title="Campaigns"
        description="Several broadcasts read as one set of numbers — by send, by account, by failure and by cost."
      />

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading…
        </div>
      ) : failed ? (
        <p className="py-6 text-sm text-muted-foreground">Couldn&apos;t load campaigns.</p>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed bg-card p-8 text-center">
          <Megaphone className="mx-auto mb-3 size-6 text-muted-foreground" />
          <p className="text-sm font-medium">No campaigns yet</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
            Name a campaign when you create a broadcast and every send under that
            name is reported together here.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border bg-card">
          {rows.map((r) => (
            <li key={r.campaignName}>
              <Link
                href={`/reports/campaigns/${encodeURIComponent(r.campaignName)}`}
                className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{r.campaignName}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {r.broadcasts} {r.broadcasts === 1 ? "send" : "sends"}
                    {r.lastSentAt && (
                      <>
                        {" · last "}
                        <LocalTime iso={r.lastSentAt} format="shortDate" />
                      </>
                    )}
                  </p>
                </div>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
