import { NextResponse } from "next/server";

import { getSession } from "@/lib/current-user";
import { db } from "@/lib/db";

/**
 * Broadcast detail: parent row + recipient rows (with contact name/phone).
 * Used by the detail page for both initial render and live polling fallback
 * (when the socket dropped or hasn't reconnected).
 *
 * DELETE removes the audit row + recipient rows. The Message rows it
 * already sent stay — those are real messages on WhatsApp that need to
 * remain in the inbox history.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { teamId } = await getSession();
  const { id } = await ctx.params;

  const row = await db.broadcast.findFirst({
    where: { id, teamId },
    include: {
      createdBy: { select: { id: true, name: true } },
      recipients: {
        orderBy: [{ status: "asc" }, { id: "asc" }],
        include: {
          contact: { select: { id: true, name: true, phoneNumber: true } },
        },
      },
    },
  });
  if (!row) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json({
    broadcast: {
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
      createdById: row.createdById,
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
    },
  });
}

/**
 * Delete a broadcast + its recipient rows. Refuses to delete while the
 * runner is mid-loop — the running runner is reading the recipient rows
 * and would error out on a missing parent.
 */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { teamId } = await getSession();
  const { id } = await ctx.params;

  const row = await db.broadcast.findFirst({
    where: { id, teamId },
    select: { id: true, status: true },
  });
  if (!row) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (row.status === "running" || row.status === "queued") {
    return NextResponse.json(
      {
        error: "broadcast in progress",
        detail: "Wait for the broadcast to finish before deleting it.",
      },
      { status: 409 },
    );
  }

  await db.broadcast.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
