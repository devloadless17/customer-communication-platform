import { cookies } from "next/headers";
import Link from "next/link";
import { Megaphone, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getSession } from "@/lib/auth/current-user";
import { listBroadcasts } from "@/lib/api/queries";

import {
  BROADCASTS_SEARCH_COOKIE,
  BROADCASTS_STATUS_COOKIE,
  BROADCASTS_VIEW_COOKIE,
  BroadcastsBrowser,
  parseBroadcastStatus,
  parseBroadcastView,
} from "./broadcasts-browser";

export const metadata = { title: "Broadcasts" };
export const dynamic = "force-dynamic";

export default async function BroadcastsPage() {
  // Restore the user's last filter / search / view across hard refreshes.
  // The seed query below uses the persisted filter + search so first paint
  // already renders the right rows — no SSR-vs-client desync, no flash.
  const cookieStore = await cookies();
  const persistedStatus = parseBroadcastStatus(
    cookieStore.get(BROADCASTS_STATUS_COOKIE)?.value,
  );
  const persistedSearch =
    cookieStore.get(BROADCASTS_SEARCH_COOKIE)?.value ?? "";
  const persistedView = parseBroadcastView(
    cookieStore.get(BROADCASTS_VIEW_COOKIE)?.value,
  );

  const [{ permissions }, rows] = await Promise.all([
    getSession(),
    listBroadcasts({
      ...(persistedStatus !== "all" ? { status: persistedStatus } : {}),
      ...(persistedSearch ? { search: persistedSearch } : {}),
    }),
  ]);
  const canManage = permissions["broadcasts:manage"];

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 md:py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Broadcasts</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Send a pre-approved WhatsApp template to many contacts in one go.
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
          canManage={canManage}
          initialFilter={persistedStatus}
          initialSearch={persistedSearch}
          initialView={persistedView}
        />
      )}
    </div>
  );
}

function EmptyState({ canManage }: { canManage: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card px-6 py-16 text-center">
      <div className="inline-flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Megaphone className="size-5" />
      </div>
      <div className="text-sm font-medium">No broadcasts yet</div>
      <p className="max-w-md text-[12px] leading-relaxed text-muted-foreground">
        Reach out to many contacts at once with an approved WhatsApp template.
        Each broadcast tracks per-recipient delivery so you can spot failures.
      </p>
      {canManage && (
        <Button asChild className="mt-2">
          <Link href="/broadcasts/new">Create your first broadcast</Link>
        </Button>
      )}
    </div>
  );
}
