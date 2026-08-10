import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { getBroadcast } from "@/lib/api/queries";
import { getCurrentTeam } from "@/lib/api/queries/team";
import { getSession } from "@/lib/auth/current-user";

import { BroadcastDetail, type BroadcastDetailDto } from "@/features/broadcasts/components/broadcast-detail";

export const metadata = { title: "Broadcast" };
export const dynamic = "force-dynamic";

export default async function BroadcastDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Restricted viewers: same direct-URL guard as /broadcasts (audit 2026-08-10).
  {
    const [s, t] = await Promise.all([getSession(), getCurrentTeam()]);
    if (s.user.role === "agent" && t.agentConversationVisibility === "assigned") {
      redirect("/inbox");
    }
  }
  const { id } = await params;
  const broadcast = await getBroadcast(id);
  if (!broadcast) notFound();

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-6 sm:px-6 md:py-8">
      <Link
        // Keep the channel scope on the way back — returning from a Messenger
        // campaign should land on the Messenger-scoped list, not the unscoped
        // one. Legacy customer-mode rows keep the bare list (their stored
        // channel is an inert default).
        href={
          broadcast.targetMode === "customer"
            ? "/broadcasts"
            : `/broadcasts?channel=${broadcast.channel}`
        }
        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Back to broadcasts
      </Link>
      <BroadcastDetail initial={broadcast as BroadcastDetailDto} />
    </div>
  );
}
