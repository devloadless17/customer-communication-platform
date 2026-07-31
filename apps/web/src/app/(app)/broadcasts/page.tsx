import { cookies } from "next/headers";
import Link from "next/link";
import { Megaphone, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getSession } from "@/lib/auth/current-user";
import { listBroadcasts } from "@/lib/api/queries";

import { BroadcastsBrowser } from "@/features/broadcasts/components/broadcasts-browser";
// Pure SSR-safe primitives (no "use client") — same split as the inbox
// filter cookies. Importing parsers / constants from a client component
// crashes at runtime with "Attempted to call X() from the server but X
// is on the client."
import {
  BROADCASTS_SEARCH_COOKIE,
  BROADCASTS_STATUS_COOKIE,
  BROADCASTS_VIEW_COOKIE,
  parseBroadcastStatus,
  parseBroadcastView,
} from "@/features/broadcasts/lib/broadcasts-cookies";

export const metadata = { title: "Broadcasts" };
export const dynamic = "force-dynamic";

// Strictly per-channel: `people` (the removed omnichannel mode's scope) is no
// longer accepted — a legacy `?channel=people` link falls back to the
// unscoped list rather than applying a silent, unclearable filter.
const OUTREACH_CHANNELS = ["whatsapp", "messenger", "instagram"] as const;

export default async function BroadcastsPage({
  searchParams,
}: {
  // `?channel=` from the channel-scoped Outreach nav. Kept in the URL (not a
  // cookie) so a shared link carries its scope — and so the SSR seed below can
  // apply it, making the first paint already correct.
  searchParams: Promise<{ channel?: string | string[] }>;
}) {
  const sp = await searchParams;
  const rawChannel = Array.isArray(sp.channel) ? sp.channel[0] : sp.channel;
  const channel = OUTREACH_CHANNELS.includes(
    rawChannel as (typeof OUTREACH_CHANNELS)[number],
  )
    ? (rawChannel as string)
    : null;

  // Restore the user's last filter / search / view across hard refreshes.
  // The seed query below uses the persisted filter + search so first paint
  // already renders the right rows — no SSR-vs-client desync, no flash.
  const cookieStore = await cookies();
  const persistedStatus = parseBroadcastStatus(
    cookieStore.get(BROADCASTS_STATUS_COOKIE)?.value,
  );
  // The client writes this cookie with encodeURIComponent (broadcasts-browser),
  // but cookies().get() returns the raw value — decode it here or a search with
  // a space/non-ASCII char seeds as percent-encoded text that matches nothing.
  // Same manual-decode pattern as templates/page.tsx.
  const rawSearch = cookieStore.get(BROADCASTS_SEARCH_COOKIE)?.value ?? "";
  let persistedSearch = rawSearch;
  try {
    persistedSearch = decodeURIComponent(rawSearch);
  } catch {
    // Malformed encoding — fall back to the raw value.
  }
  const persistedView = parseBroadcastView(
    cookieStore.get(BROADCASTS_VIEW_COOKIE)?.value,
  );

  const [{ permissions }, broadcastsPage] = await Promise.all([
    getSession(),
    // Seed page 1 in numbered mode so the SSR rows match the paginated browser
    // (25/page). page/take must match BROADCASTS_PAGE_SIZE in broadcasts-browser.
    listBroadcasts({
      ...(persistedStatus !== "all" ? { status: persistedStatus } : {}),
      ...(persistedSearch ? { search: persistedSearch } : {}),
      ...(channel ? { channel } : {}),
      page: 1,
      take: 25,
    }),
  ]);
  const rows = broadcastsPage.broadcasts;
  const initialTotalCount = broadcastsPage.totalCount ?? null;
  const canManage = permissions["broadcasts:manage"];

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 md:py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Broadcasts</h1>
            {/* Visible scope chip — without it a channel-filtered list is
                indistinguishable from the full history. */}
            {channel && (
              <span className="rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-xs font-medium capitalize text-muted-foreground">
                {channel}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {channel === "messenger" || channel === "instagram"
              ? `Send a free-form message to many ${channel === "messenger" ? "Messenger" : "Instagram"} contacts inside their messaging window.`
              : "Send a pre-approved WhatsApp template to many contacts in one go."}{" "}
            Filter by status, search, or switch to the calendar to see scheduled
            sends.
          </p>
        </div>
        {canManage && (
          <Button asChild>
            <Link href="/broadcasts/new" className="gap-1.5">
              <Plus className="size-4" />
              New broadcast
            </Link>
          </Button>
        )}
      </div>

      {rows.length === 0 && persistedStatus === "all" && persistedSearch === "" ? (
        // Genuine empty state — the team has no broadcasts at all. When a
        // filter / search is active, render the browser anyway so the user
        // sees the controls + "no matching broadcasts" copy and can clear
        // the filter; otherwise this looked like the team had no broadcasts
        // when really the failed-status filter just had no matches.
        <EmptyState canManage={canManage} />
      ) : (
        <BroadcastsBrowser
          initial={rows}
          initialTotalCount={initialTotalCount}
          canManage={canManage}
          initialFilter={persistedStatus}
          initialSearch={persistedSearch}
          initialView={persistedView}
          channel={channel}
        />
      )}
    </div>
  );
}

function EmptyState({ canManage }: { canManage: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border bg-card px-6 py-20 text-center">
      <div className="inline-flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Megaphone className="size-6" />
      </div>
      <div className="text-base font-semibold text-foreground">No broadcasts yet</div>
      <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
        Reach many contacts at once on one channel — an approved template on
        WhatsApp, or a free-form message on Messenger / Instagram. Each
        broadcast tracks per-recipient delivery so you can spot failures.
      </p>
      {canManage && (
        <Button asChild className="mt-2">
          <Link href="/broadcasts/new">Create your first broadcast</Link>
        </Button>
      )}
    </div>
  );
}
