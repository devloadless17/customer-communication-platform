"use client";

import { useEffect, useState } from "react";
import { Megaphone } from "lucide-react";

import { LocalTime } from "@/components/local-time";
import { apiFetch } from "@/lib/api/client-fetch";

import { ReadOnlyRow } from "./read-only-row";

/**
 * WHERE THIS CUSTOMER CAME FROM.
 *
 * The same fact the first message bubble already shows — except that on a
 * customer you have been talking to for months, that bubble is thousands of
 * messages up the thread, so in practice nobody ever sees it. "Which ad won us
 * this customer" is a question asked while looking at the CUSTOMER, so the
 * answer belongs on the profile.
 *
 * ## Renders NOTHING when the customer arrived organically
 *
 * Not "—", not "Direct". Most contacts have no attribution, and a permanent
 * empty row on every profile is noise that trains agents to stop reading the
 * panel. Absence here means "no ad brought them in", which the acquisition
 * report states positively as its `organic` count.
 *
 * Fetched lazily, on its own endpoint, rather than riding the conversation
 * payload: the inbox loads that payload on every thread open and this is a
 * field read occasionally.
 */
interface Acquisition {
  source?: string;
  adId?: string;
  postId?: string;
  productId?: string;
  ref?: string;
  headline?: string;
  sourceUrl?: string;
  at?: string;
}

/** What Meta actually told us, in the order that identifies the source best. */
function describe(a: Acquisition): { label: string; id: string | null } {
  if (a.productId) return { label: "Product tap", id: a.productId };
  if (a.adId) return { label: "Ad", id: a.adId };
  if (a.postId) return { label: "Post", id: a.postId };
  if (a.ref) return { label: "Link", id: a.ref };
  return { label: "Referral", id: null };
}

export function ContactAcquisitionRow({ contactId }: { contactId: string }) {
  const [data, setData] = useState<Acquisition | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    void (async () => {
      try {
        const res = await apiFetch(`/api/contacts/${contactId}/acquisition`);
        if (!res.ok) return;
        const body = (await res.json()) as { acquisition: Acquisition | null };
        if (!cancelled && body.acquisition) setData(body.acquisition);
      } catch {
        // Silent: this is a supplementary profile field. A failed fetch must
        // never surface an error row on a panel whose job is the customer.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  if (!data) return null;

  const { label, id } = describe(data);
  const title = data.headline?.trim() || label;

  const body = (
    <span className="min-w-0">
      <span className="truncate">{title}</span>
      {/* The raw id, because it is what you paste into Ads Manager — a
          prettified version would be actively unhelpful. */}
      {id && <span className="block truncate font-mono text-3xs text-muted-foreground">{id}</span>}
      {data.at && (
        <span className="block text-3xs text-muted-foreground">
          <LocalTime iso={data.at} format="shortDate" />
        </span>
      )}
    </span>
  );

  return (
    <ReadOnlyRow
      icon={Megaphone}
      label="Came from"
      value={
        data.sourceUrl ? (
          <a
            href={data.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block min-w-0 hover:underline"
          >
            {body}
          </a>
        ) : (
          body
        )
      }
    />
  );
}
