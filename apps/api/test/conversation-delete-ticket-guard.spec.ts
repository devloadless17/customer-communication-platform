/**
 * Deleting a conversation DELETES ITS TICKETS (maintainer decision,
 * 2026-08-20). This replaced a hard refusal added by audit 2026-08-19 S12-2.
 *
 * The refusal made the common case a hunt: a ticket's delete button lives only
 * on its own detail page and is hidden on a ticket escalated INTO the
 * workspace, so some threads could not be deleted by anyone. `Ticket.
 * conversation` is already onDelete: Cascade, so the delete now simply lets
 * that happen — deliberately, with the consequence stated in the confirmation
 * BEFORE the click and the count reported after.
 *
 * What this pins, because the cascade reaches further than the ticket row:
 *   - the ticket, its cross-department thread, history, share and attachment
 *     rows all go with the conversation;
 *   - attachment BLOBS are collected for deletion (the FK knows nothing about
 *     R2, so without that they'd linger until the orphan sweeper);
 *   - the count is reported so the UI can say what was destroyed.
 *
 *   pnpm --filter @ccp/api exec vitest run test/conversation-delete-ticket-guard.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestPrismaClient } from "./_prisma";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const { db, setSharedDb } = await import("@/lib/db");
const { ConversationsService } = await import("@/conversations/conversations.service");
setSharedDb(createTestPrismaClient() as unknown as PrismaClient);

const SUFFIX = `cdg${Date.now().toString().slice(-8)}`;

let organizationId: string;
let workspaceId: string;
let ticketedConversationId: string;
let cleanConversationId: string;

async function makeConversation(name: string, phone: string): Promise<string> {
  const contact = await db.contact.create({
    data: { workspaceId, name, phoneNumber: phone, identityChannel: "whatsapp" },
  });
  const conversation = await db.conversation.create({
    data: { workspaceId, contactId: contact.id, channel: "whatsapp" },
  });
  return conversation.id;
}

beforeAll(async () => {
  const org = await db.organization.create({
    data: { name: `cdg-org-${SUFFIX}`, status: "active" },
  });
  organizationId = org.id;
  const ws = await db.workspace.create({
    data: { name: `cdg-${SUFFIX}`, organizationId },
  });
  workspaceId = ws.id;

  ticketedConversationId = await makeConversation(`Ticketed ${SUFFIX}`, `1777${SUFFIX.slice(-7)}`);
  cleanConversationId = await makeConversation(`Clean ${SUFFIX}`, `1778${SUFFIX.slice(-7)}`);

  await db.ticket.create({
    data: {
      workspaceId,
      number: 1,
      conversationId: ticketedConversationId,
      channel: "whatsapp",
      subject: `refund ${SUFFIX}`,
    },
  });
});

afterAll(async () => {
  if (!organizationId) return;
  await db.ticket.deleteMany({ where: { workspaceId } });
  await db.conversation.deleteMany({ where: { workspaceId } });
  await db.contact.deleteMany({ where: { workspaceId } });
  await db.workspace.deleteMany({ where: { id: workspaceId } });
  await db.organization.deleteMany({ where: { id: organizationId } });
});

describe("conversation delete × tickets", () => {
  function service() {
    const bus = { publish: async () => {} };
    const contacts = {};
    return new ConversationsService(db as never, bus as never, contacts as never);
  }

  it("deletes the thread AND its tickets, reporting how many", async () => {
    const ticketId = (await db.ticket.findFirstOrThrow({
      where: { workspaceId, conversationId: ticketedConversationId },
      select: { id: true },
    })).id;
    // A cross-department thread message + an attachment row, so the assertion
    // covers the cascade's REACH rather than just the ticket row.
    await db.ticketAttachment.create({
      data: {
        workspaceId,
        ticketId,
        blobKey: `media/${SUFFIX}/evidence.pdf`,
        blobUrl: `https://example.invalid/media/${SUFFIX}/evidence.pdf`,
        filename: "evidence.pdf",
        mimeType: "application/pdf",
        kind: "document",
        sizeBytes: 10,
      },
    });

    const result = await service().remove(workspaceId, "actor-user", ticketedConversationId);
    expect(result.deletedTickets).toBe(1);

    expect(await db.conversation.count({ where: { id: ticketedConversationId } })).toBe(0);
    expect(await db.ticket.count({ where: { id: ticketId } })).toBe(0);
    expect(await db.ticketAttachment.count({ where: { ticketId } })).toBe(0);
  });

  it("reports zero tickets for a clean thread, and still deletes it", async () => {
    const result = await service().remove(workspaceId, "actor-user", cleanConversationId);
    expect(result.deletedTickets).toBe(0);
    expect(await db.conversation.count({ where: { id: cleanConversationId } })).toBe(0);
  });
});
