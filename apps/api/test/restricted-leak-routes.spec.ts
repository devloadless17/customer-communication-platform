/**
 * The 2026-08-10 leak-route closures, exercised against a real database.
 *
 * A restricted agent (role=agent under `agentConversationVisibility:
 * "assigned"`) may only see conversations assigned to them. Five routes
 * skipped that boundary; each gets a guard here proving:
 *   - the restricted viewer is refused (404/409 — never a body),
 *   - the ASSIGNED agent and an admin still succeed (the fix must not
 *     over-close).
 *
 * Covered: AI customer memory (list / patch / delete — distilled thread
 * content reachable via the deliberately-open contacts directory), the public
 * comment-reply write, the direct ticket-attachment upload, and the
 * start-conversation existence oracle.
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AiInboxService } from "../src/ai-assistant/ai-inbox.service";
import { TicketsService } from "../src/tickets/tickets.service";
import { ConversationsService } from "../src/conversations/conversations.service";
import type { DbService } from "../src/db/db.service";
import type { ConversationViewer } from "@/lib/conversations/visibility";
import { createTicket } from "@/lib/tickets/mutations";
import {
  replyToCommentPublicly,
  ReplyToCommentError,
} from "@/lib/messaging/reply-to-comment";
import { setSharedDb } from "@/lib/db";

import { createTestPrismaClient } from "./_prisma";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);
const db = prisma as unknown as DbService;

const S = `rlk${Date.now().toString().slice(-8)}`;
let orgId = "";
let ws = "";
let ownerId = ""; // the agent the conversation is assigned to
let otherId = ""; // the restricted agent poking at it
let contactId = "";
let conversationId = "";
let customerId = "";
let contactSeq = 0;

const viewer = (userId: string): ConversationViewer => ({
  workspaceId: ws,
  userId,
  role: "agent",
  agentConversationVisibility: "assigned",
});
const admin: ConversationViewer = {
  workspaceId: "",
  userId: "",
  role: "admin",
  agentConversationVisibility: "assigned",
};

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `RLK ${S}`, status: "active" } })).id;
  ws = (await prisma.workspace.create({ data: { name: `RLK WS ${S}`, organizationId: orgId } })).id;
  const mkUser = async (tag: string) =>
    (
      await prisma.user.create({
        data: {
          organizationId: orgId,
          name: `RLK ${tag}`,
          email: `rlk-${tag}-${S}@test.local`,
          emailVerified: true,
        },
      })
    ).id;
  ownerId = await mkUser("owner");
  otherId = await mkUser("other");
  admin.workspaceId = ws;
  admin.userId = await mkUser("admin");

  const customer = await prisma.customer.create({
    data: { workspaceId: ws, name: `RLK Person ${S}` },
  });
  customerId = customer.id;
  contactId = (
    await prisma.contact.create({
      data: {
        workspaceId: ws,
        name: `RLK Contact ${S}`,
        phoneNumber: `+9869${S.slice(3)}${String(contactSeq++).padStart(3, "0")}`,
        identityChannel: "whatsapp",
        customerId,
      },
    })
  ).id;
  conversationId = (
    await prisma.conversation.create({
      data: { workspaceId: ws, contactId, channel: "whatsapp", assignedUserId: ownerId },
    })
  ).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.$disconnect();
});

describe("AI customer memory — distilled thread content behind the visibility gate", () => {
  const svc = new AiInboxService(db);
  let memoryId = "";

  beforeAll(async () => {
    memoryId = (
      await prisma.aiCustomerMemory.create({
        data: {
          workspaceId: ws,
          customerId,
          kind: "interest",
          value: "asked about the enterprise plan",
          sourceConversationId: conversationId,
        },
      })
    ).id;
  });

  it("refuses a restricted agent with no visible conversation (list, patch, delete)", async () => {
    await expect(svc.listMemory(ws, customerId, viewer(otherId))).rejects.toMatchObject({
      response: { error: "customer_not_found" },
    });
    // The row EXISTS — the refusal is phrased as customer_not_found, telling
    // the prober nothing they didn't already know from the directory.
    await expect(
      svc.patchMemory(ws, otherId, memoryId, { status: "rejected" }, viewer(otherId)),
    ).rejects.toMatchObject({ response: { error: "customer_not_found" } });
    await expect(svc.deleteMemory(ws, memoryId, viewer(otherId))).rejects.toMatchObject({
      response: { error: "customer_not_found" },
    });
  });

  it("still serves the ASSIGNED agent and an admin", async () => {
    const mine = await svc.listMemory(ws, customerId, viewer(ownerId));
    expect(mine.map((m) => m.id)).toContain(memoryId);
    const adminView = await svc.listMemory(ws, customerId, admin);
    expect(adminView.map((m) => m.id)).toContain(memoryId);
    const patched = await svc.patchMemory(
      ws,
      ownerId,
      memoryId,
      { status: "confirmed" },
      viewer(ownerId),
    );
    expect(patched.status).toBe("confirmed");
  });
});

describe("public comment-reply — bare-message-id route respects the boundary", () => {
  let commentMessageId = "";

  beforeAll(async () => {
    commentMessageId = (
      await prisma.message.create({
        data: {
          workspaceId: ws,
          conversationId,
          channel: "instagram",
          direction: "in",
          body: "nice product!",
          externalId: `rlk_comment_${S}`,
          structured: { kind: "comment", commentId: "1789" },
        },
      })
    ).id;
  });

  it("a restricted non-owner gets message_not_found — existence stays hidden", async () => {
    await expect(
      replyToCommentPublicly({
        workspaceId: ws,
        messageId: commentMessageId,
        body: "thanks!",
        userId: otherId,
        viewer: viewer(otherId),
      }),
    ).rejects.toMatchObject({ code: "message_not_found" });
  });

  it("the assigned agent passes the visibility filter (fails later, on provider wiring)", async () => {
    // With no live Meta credentials the call must get PAST the lookup and die
    // on channel/provider ground — ANY failure except message_not_found
    // proves the filter admitted the owner.
    let thrown: unknown;
    try {
      await replyToCommentPublicly({
        workspaceId: ws,
        messageId: commentMessageId,
        body: "thanks!",
        userId: ownerId,
        viewer: viewer(ownerId),
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    if (thrown instanceof ReplyToCommentError) {
      expect(thrown.code).not.toBe("message_not_found");
    }
  });
});

describe("direct ticket-attachment upload — the one ticket write that skipped assertVisible", () => {
  let ticketId = "";
  const tickets = new TicketsService(db, null as unknown as ConversationsService);

  beforeAll(async () => {
    const created = await createTicket(db as unknown as Parameters<typeof createTicket>[0], {
      workspaceId: ws,
      conversationId,
      actor: { userId: admin.userId, workspaceId: ws },
      source: "human",
      subject: "RLK attachment gate",
    });
    if (!created.ok) throw new Error(`ticket create failed: ${created.reason}`);
    ticketId = created.ticket.id;
  });

  it("refuses a restricted agent with no stake in the ticket", async () => {
    await expect(
      tickets.attachFiles(
        ws,
        { userId: otherId },
        ticketId,
        [
          {
            buffer: Buffer.from("evidence"),
            originalname: "evidence.txt",
            mimetype: "text/plain",
          } as Parameters<typeof tickets.attachFiles>[3][number],
        ],
        null,
        viewer(otherId),
      ),
    ).rejects.toMatchObject({ response: { error: "ticket_not_found" } });
  });

  it("still accepts the conversation's assigned agent", async () => {
    const out = await tickets.attachFiles(
      ws,
      { userId: ownerId },
      ticketId,
      [
        {
          buffer: Buffer.from("evidence"),
          originalname: "evidence.txt",
          mimetype: "text/plain",
        } as Parameters<typeof tickets.attachFiles>[3][number],
      ],
      null,
      viewer(ownerId),
    );
    expect(out).toHaveLength(1);
  });
});

describe("start-conversation existence oracle", () => {
  const conversations = new ConversationsService(
    db,
    // The oracle path (existing OPEN thread, restricted viewer) never reaches
    // the bus or the contacts find-or-create — a thrown 409 proves that.
    null as unknown as ConstructorParameters<typeof ConversationsService>[1],
    null as unknown as ConstructorParameters<typeof ConversationsService>[2],
  );

  it("refuses a restricted agent when the thread belongs to a teammate", async () => {
    await expect(
      conversations.startConversation(ws, otherId, { contactId }, viewer(otherId)),
    ).rejects.toMatchObject({ response: { error: "conversation_assigned_elsewhere" } });
  });

  it("returns the existing thread to its assigned agent", async () => {
    const res = await conversations.startConversation(ws, ownerId, { contactId }, viewer(ownerId));
    expect(res).toMatchObject({ conversationId, created: false });
  });
});
