/**
 * Deleting a conversation that carries TICKETS is refused — and the refusal
 * says WHY.
 *
 * The guard itself came from audit 2026-08-19 (S12-2): a conversation delete
 * cascaded into Ticket → TicketShare, so tidying a thread destroyed a sibling
 * workspace's live work. The service returns 409 `conversation_has_tickets`
 * with a written explanation.
 *
 * This spec exists because the refusal had NO coverage, which is how the web
 * client got away with discarding the body and rendering "Please try again" —
 * advice that can never work, on the one error the person can actually act on.
 * It pins BOTH halves of the contract the UI depends on:
 *   - single delete → 409, machine key, and a human `detail` naming the count;
 *   - bulk delete   → ticket-bearing threads are SKIPPED and reported via
 *     `skippedWithTickets` while the clean ones still delete.
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

describe("conversation delete × ticket guard", () => {
  function service() {
    // The service only needs its db here; the bus/contacts collaborators are
    // never reached because the guard throws first — which is the point.
    const bus = { publish: async () => {} };
    const contacts = {};
    return new ConversationsService(
      db as never,
      bus as never,
      contacts as never,
    );
  }

  it("refuses, with a reason that names the ticket count", async () => {
    let thrown: unknown;
    try {
      await service().remove(workspaceId, "user-irrelevant", ticketedConversationId);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    const body = (thrown as { getResponse: () => Record<string, unknown> }).getResponse();
    expect(body.error).toBe("conversation_has_tickets");
    expect(body.ticketCount).toBe(1);
    // The `detail` is what the person actually reads — it must explain the
    // consequence, not restate the key. The web client renders it verbatim.
    expect(String(body.detail)).toMatch(/1 ticket/);
    expect(String(body.detail)).toMatch(/Delete the ticket/i);

    // And the thread is untouched.
    const still = await db.conversation.findUnique({ where: { id: ticketedConversationId } });
    expect(still).not.toBeNull();
  });

  it("the guard is the ONLY protection — the FK cascades", async () => {
    // Ticket.conversation is `onDelete: Cascade`, so a raw delete takes the
    // tickets (and their shares, thread and files) with it. That is precisely
    // the data loss the guard above prevents, and why it must never be relaxed
    // into a warning. Proven on a THROWAWAY pair so nothing else depends on it.
    const doomedId = await makeConversation(`Doomed ${SUFFIX}`, `1779${SUFFIX.slice(-7)}`);
    await db.ticket.create({
      data: {
        workspaceId,
        number: 2,
        conversationId: doomedId,
        channel: "whatsapp",
        subject: `doomed ${SUFFIX}`,
      },
    });
    await db.conversation.delete({ where: { id: doomedId } });
    const orphanedOrGone = await db.ticket.findFirst({
      where: { workspaceId, subject: `doomed ${SUFFIX}` },
    });
    expect(orphanedOrGone).toBeNull(); // cascaded away with the thread
  });

  it("a conversation with no tickets still deletes", async () => {
    await db.conversation.delete({ where: { id: cleanConversationId } });
    const gone = await db.conversation.findUnique({ where: { id: cleanConversationId } });
    expect(gone).toBeNull();
  });
});
