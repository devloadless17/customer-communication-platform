import "server-only";

import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { dispatchTest } from "@/lib/automations/dispatcher";
import type {
  ConversationAssignedPayload,
  ConversationStatusChangedPayload,
  EventPayload,
  MessageReceivedPayload,
} from "@/lib/automations/events";

/**
 * POST /api/team/automations/[id]/test
 *
 * Fire the automation with a synthetic payload. Useful for verifying a
 * webhook URL before flipping `enabled` to true. Returns the enqueued
 * BullMQ job id; the UI polls /runs to see the result.
 *
 * Synthetic payloads use placeholder ids — the action handler will POST a
 * real envelope to n8n, but the conversation/contact ids won't resolve in
 * the callback API (404). That's the trade-off of testing without picking a
 * real conversation; admins who want a more realistic test should send a
 * real message.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;
  const { id } = await ctx.params;

  const auto = await db.automation.findFirst({
    where: { id, teamId: session.teamId },
    select: { id: true, trigger: true },
  });
  if (!auto) return NextResponse.json({ error: "not found" }, { status: 404 });

  const payload = syntheticPayload(auto.trigger);
  const jobId = await dispatchTest(auto.id, session.teamId, payload);
  return NextResponse.json({ ok: true, jobId });
}

function syntheticPayload(trigger: "message_received" | "conversation_assigned" | "conversation_status_changed"): EventPayload {
  const baseContact = {
    id: "test_contact",
    phoneNumber: "10000000000",
    name: "Test Contact",
    email: null,
    customFields: {},
  };
  const baseConversation = {
    id: "test_conversation",
    status: "open" as const,
    assignedUserId: null,
    unreadCount: 1,
    lastMessageAt: new Date().toISOString(),
  };

  switch (trigger) {
    case "message_received": {
      const p: MessageReceivedPayload = {
        message: {
          id: "test_message",
          conversationId: baseConversation.id,
          externalId: "test_wamid",
          direction: "in",
          body: "This is a test message from the automations builder.",
          mediaKind: null,
          mediaCaption: null,
          timestamp: new Date().toISOString(),
          senderUserId: null,
        },
        conversation: baseConversation,
        contact: baseContact,
        recentMessages: [],
      };
      return p;
    }
    case "conversation_assigned": {
      const p: ConversationAssignedPayload = {
        conversation: { ...baseConversation, assignedUserId: "test_user" },
        contact: baseContact,
        assignedUser: { id: "test_user", name: "Test Agent", email: "agent@example.com" },
        previousAssignedUserId: null,
      };
      return p;
    }
    case "conversation_status_changed": {
      const p: ConversationStatusChangedPayload = {
        conversation: { ...baseConversation, status: "closed" },
        contact: baseContact,
        previousStatus: "open",
        newStatus: "closed",
        changedByUserId: null,
      };
      return p;
    }
  }
}
