import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { getSession } from "@/lib/current-user";
import { db } from "@/lib/db";

import { BroadcastDetail, type BroadcastDetailDto } from "./broadcast-detail";

export const metadata = { title: "Broadcast" };
export const dynamic = "force-dynamic";

export default async function BroadcastDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { teamId } = await getSession();
  const { id } = await params;

  const row = await db.broadcast.findFirst({
    where: { id, teamId },
    include: {
      createdBy: { select: { name: true } },
      recipients: {
        orderBy: [{ status: "asc" }, { id: "asc" }],
        include: {
          contact: { select: { id: true, name: true, phoneNumber: true } },
        },
      },
    },
  });
  if (!row) notFound();

  const initial: BroadcastDetailDto = {
    id: row.id,
    status: row.status,
    templateId: row.templateId,
    templateName: row.templateName,
    templateLanguage: row.templateLanguage,
    audienceMode: row.audienceMode,
    variables: row.variables,
    totalCount: row.totalCount,
    sentCount: row.sentCount,
    failedCount: row.failedCount,
    lastError: row.lastError,
    createdByName: row.createdBy.name,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    recipients: row.recipients.map((r) => ({
      id: r.id,
      contactId: r.contactId,
      contactName: r.contact.name,
      contactPhone: r.contact.phoneNumber,
      conversationId: r.conversationId,
      status: r.status,
      externalId: r.externalId,
      errorMessage: r.errorMessage,
      sentAt: r.sentAt?.toISOString() ?? null,
    })),
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-8">
      <Link
        href="/broadcasts"
        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Back to broadcasts
      </Link>
      <BroadcastDetail initial={initial} />
    </div>
  );
}
