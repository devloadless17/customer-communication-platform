import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { getBroadcast } from "@/lib/api/queries";

import { BroadcastDetail, type BroadcastDetailDto } from "./broadcast-detail";

export const metadata = { title: "Broadcast" };
export const dynamic = "force-dynamic";

export default async function BroadcastDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const broadcast = await getBroadcast(id);
  if (!broadcast) notFound();

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-8">
      <Link
        href="/broadcasts"
        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Back to broadcasts
      </Link>
      <BroadcastDetail initial={broadcast as BroadcastDetailDto} />
    </div>
  );
}
