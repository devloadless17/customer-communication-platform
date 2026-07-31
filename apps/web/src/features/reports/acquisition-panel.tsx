"use client";

import { useEffect, useState } from "react";
import { Loader2, Megaphone } from "lucide-react";

import { LocalTime } from "@/components/local-time";
import { apiFetch } from "@/lib/api/client-fetch";
import { cn } from "@ccp/shared/utils";

/**
 * WHERE CUSTOMERS CAME FROM — the acquisition panel.
 *
 * Reads `/api/reports/acquisition`, which aggregates the attribution every
 * ad-sourced inbound already carries: a Click-to-Messenger ad, a Click-to-
 * WhatsApp ad, an m.me deep link, an Instagram Shop product tap. One row per
 * source, counted by distinct CONTACT.
 *
 * ## Two things this panel deliberately does NOT do
 *
 * It does not fold `organic` into the table. Organic is the ABSENCE of a source,
 * and as a row it would sort by volume above every real campaign and read as the
 * best-performing one. It sits outside, as context for the rest.
 *
 * It does not show a conversion RATE per source. We know how many people arrived
 * from an ad; we do not know what the ad cost or how many impressions it bought,
 * because that lives in the Marketing API behind an ad-account connection this
 * platform does not have. A "rate" computed from only the numerator would be a
 * number that looks like performance and isn't.
 */
interface SourceRow {
  source: string;
  sourceId: string | null;
  headline: string | null;
  contacts: number;
  firstAt: string | null;
  lastAt: string | null;
}

const SOURCE_LABEL: Record<string, string> = {
  ad: "Ad",
  post: "Post",
  ref: "Link",
  unknown: "Other",
};

export function AcquisitionPanel({ channel }: { channel?: string }) {
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [rows, setRows] = useState<SourceRow[]>([]);
  const [organic, setOrganic] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    void (async () => {
      try {
        const qs = channel ? `?channel=${encodeURIComponent(channel)}` : "";
        const res = await apiFetch(`/api/reports/acquisition${qs}`);
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { rows: SourceRow[]; organic: number };
        if (cancelled) return;
        setRows(body.rows);
        setOrganic(body.organic);
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channel]);

  const attributed = rows.reduce((n, r) => n + r.contacts, 0);

  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="mb-1 flex items-center gap-2">
        <Megaphone className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Where customers came from</h2>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        People whose first message arrived from an ad, a post or a link. Counted
        once per person, on the message that started the conversation.
      </p>

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Loading…
        </div>
      ) : failed ? (
        <p className="py-4 text-xs text-muted-foreground">
          Couldn&apos;t load acquisition sources.
        </p>
      ) : rows.length === 0 ? (
        // Distinguishes "nobody has arrived from an ad" from "something broke".
        // The organic count proves the query ran and found people — it just found
        // none with a source.
        <p className="py-4 text-xs text-muted-foreground">
          No ad or link attribution recorded yet.
          {organic > 0 && ` All ${organic.toLocaleString()} contacts arrived directly.`}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/30 text-3xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">Source</th>
                  <th className="px-3 py-1.5 text-left font-medium">Identifier</th>
                  <th className="px-3 py-1.5 text-right font-medium">People</th>
                  <th className="px-3 py-1.5 text-right font-medium">Share</th>
                  <th className="px-3 py-1.5 text-right font-medium">Last</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.source}:${r.sourceId ?? i}`} className="border-t border-border">
                    <td className="px-3 py-1.5">
                      <span className="font-medium">
                        {SOURCE_LABEL[r.source] ?? r.source}
                      </span>
                      {r.headline && (
                        <span className="block truncate text-2xs text-muted-foreground">
                          {r.headline}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      {/* The ad / post / link id. Shown raw and monospaced: it is
                          what you paste into Ads Manager, so a prettified version
                          would be actively unhelpful. */}
                      <span className="font-mono text-2xs text-muted-foreground">
                        {r.sourceId ?? "—"}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {r.contacts.toLocaleString()}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                      {/* Share of ATTRIBUTED people, not of all contacts — the
                          denominators are different questions and mixing them
                          would make the column sum to less than 100% with no
                          explanation. The organic line below carries the rest. */}
                      {attributed > 0
                        ? `${Math.round((r.contacts / attributed) * 100)}%`
                        : "—"}
                    </td>
                    <td
                      className={cn(
                        "px-3 py-1.5 text-right tabular-nums text-muted-foreground",
                      )}
                    >
                      {/* <LocalTime>, never a raw toLocaleDateString: the server and the
                          browser format in different timezones, so a bare call
                          renders one date during SSR and another after hydration. */}
                      {r.lastAt ? <LocalTime iso={r.lastAt} format="shortDate" /> : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-2xs text-muted-foreground">
            {attributed.toLocaleString()} from a tracked source
            {organic > 0 && ` · ${organic.toLocaleString()} arrived directly`}.
            Percentages are of tracked sources only.
          </p>
        </>
      )}
    </div>
  );
}
