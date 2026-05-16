import "server-only";

import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { enqueueWorkflowRun } from "@/lib/workflows/queue";

/**
 * POST /api/team/workflows/[id]/test
 *
 *   { contactId?: string, conversationId?: string }
 *
 * Fires this workflow synthetically. If contactId is provided, builds a
 * payload from the live row so the run is realistic; otherwise uses a
 * synthetic stub (real conversations/contact lookups inside step handlers
 * will 404 but the run still records what would have happened).
 *
 * Bypasses trigger conditions + once-per-contact dedupe (the admin is
 * explicitly testing). Skips the dispatcher entirely so a draft workflow
 * (enabled=true, published=false) can still be test-run from the canvas.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;
  const { id } = await ctx.params;

  const wf = await db.workflow.findFirst({
    where: { id, teamId: session.teamId },
    select: { id: true, trigger: true, enabled: true },
  });
  if (!wf) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!wf.enabled) {
    return NextResponse.json(
      { error: "workflow is disabled — enable it before testing" },
      { status: 409 },
    );
  }

  let body: { contactId?: unknown; conversationId?: unknown };
  try {
    body = (await req.json().catch(() => ({}))) as typeof body;
  } catch {
    body = {};
  }
  const contactId = typeof body.contactId === "string" ? body.contactId : null;
  const conversationId = typeof body.conversationId === "string" ? body.conversationId : null;

  // Build payload — real if contactId given, synthetic otherwise.
  let eventPayload: unknown;
  if (contactId) {
    const [contact, conversation] = await Promise.all([
      db.contact.findFirst({
        where: { id: contactId, teamId: session.teamId },
        include: { tags: { select: { id: true } } },
      }),
      conversationId
        ? db.conversation.findFirst({
            where: { id: conversationId, teamId: session.teamId },
          })
        : Promise.resolve(null),
    ]);
    if (!contact) return NextResponse.json({ error: "contact not found" }, { status: 404 });
    eventPayload = {
      contact: {
        id: contact.id,
        phoneNumber: contact.phoneNumber,
        identityProvider: contact.identityProvider,
        externalContactId: contact.externalContactId,
        name: contact.name,
        email: contact.email,
        stageId: contact.stageId,
        tagIds: contact.tags.map((t) => t.id),
        customFields:
          contact.customFields && typeof contact.customFields === "object" && !Array.isArray(contact.customFields)
            ? (contact.customFields as Record<string, unknown>)
            : {},
      },
      conversation: conversation
        ? {
            id: conversation.id,
            status: conversation.status,
            assignedUserId: conversation.assignedUserId,
            unreadCount: conversation.unreadCount,
            lastMessageAt: conversation.lastMessageAt.toISOString(),
          }
        : null,
    };
  } else {
    eventPayload = {
      contact: {
        id: "test_contact",
        phoneNumber: "10000000000",
        identityProvider: null,
        externalContactId: null,
        name: "Test Contact",
        email: null,
        stageId: null,
        tagIds: [],
        customFields: {},
      },
      conversation: {
        id: "test_conversation",
        status: "open",
        assignedUserId: null,
        unreadCount: 1,
        lastMessageAt: new Date().toISOString(),
      },
    };
  }

  const run = await db.workflowRun.create({
    data: {
      workflowId: wf.id,
      teamId: session.teamId,
      trigger: wf.trigger,
      contactId,
      conversationId,
      eventPayload: eventPayload as Prisma.InputJsonValue,
      status: "queued",
    },
    select: { id: true },
  });
  const jobId = await enqueueWorkflowRun(run.id);
  return NextResponse.json({ ok: true, runId: run.id, jobId });
}
