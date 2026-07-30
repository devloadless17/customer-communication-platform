/**
 * Private replies to Instagram comments, driven against the REAL database.
 *
 * `resolvePrivateReplyTarget` decides the single most consequential thing on this
 * channel: whether an agent typing into a comment thread reaches the customer at
 * all. It leans on a Prisma JSON-PATH filter
 * (`structured: { path: ["kind"], equals: "comment" }`), and a JSON path filter
 * that matches nothing is completely silent — it type-checks, it runs, it returns
 * `[]`, and the only symptom is that every comment thread reports "outside the
 * 24-hour window" forever. No unit test with a mocked Prisma could catch that,
 * because the mock would be asserting the query I wrote rather than the rows
 * Postgres actually returns.
 *
 * So this spec seeds real rows and reads them back. What it pins:
 *
 *  1. The JSON filter genuinely selects comment rows (and ONLY comment rows —
 *     a location or story structured message is an ordinary DM).
 *  2. Meta permits exactly ONE private reply per comment, so a comment that has
 *     been answered is never offered again. Getting this wrong costs a billed
 *     round trip and an opaque Graph error instead of a local refusal.
 *  3. A comment older than 7 days is not offered — Meta would reject it.
 *  4. The NEWEST eligible comment wins: freshest context, most window left.
 *
 *   pnpm --filter @ccp/api exec vitest run test/instagram-private-reply.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { setSharedDb } from "@/lib/db";
import { resolvePrivateReplyTarget } from "@/lib/messaging/private-reply";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `ipr${Date.now().toString().slice(-8)}`;
const DAY_MS = 24 * 60 * 60 * 1000;

let orgId = "";
let workspaceId = "";
let conversationId = "";
let seq = 0;

async function freshWorkspace() {
  orgId = (
    await prisma.organization.create({ data: { name: `IPR Org ${S}`, status: "active" } })
  ).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `IPR WS ${S}`, organizationId: orgId } })
  ).id;
  const contact = await prisma.contact.create({
    data: {
      workspaceId,
      name: "Commenter",
      identityChannel: "instagram",
      externalContactId: `IGSID_${S}`,
    },
  });
  conversationId = (
    await prisma.conversation.create({
      data: { workspaceId, contactId: contact.id, channel: "instagram" },
    })
  ).id;
}

/** Seed an inbound COMMENT exactly as the parser + ingest would write it. */
async function seedComment(commentId: string, ageMs = 0, isLive = false) {
  seq += 1;
  return prisma.message.create({
    data: {
      workspaceId,
      conversationId,
      externalId: `comment:${commentId}:${S}:${seq}`,
      body: "is this in stock?",
      direction: "in",
      channel: "instagram",
      structured: { kind: "comment", commentId, ...(isLive ? { isLive: true } : {}) },
      createdAt: new Date(Date.now() - ageMs),
    },
    select: { id: true },
  });
}

/** Seed an inbound DM carrying OTHER structured content — must never match. */
async function seedStructuredDm(kind: string) {
  seq += 1;
  return prisma.message.create({
    data: {
      workspaceId,
      conversationId,
      externalId: `dm:${S}:${seq}`,
      body: "a normal direct message",
      direction: "in",
      channel: "instagram",
      structured:
        kind === "location"
          ? { kind: "location", latitude: 1, longitude: 2 }
          : { kind: "story", storyType: "reply" },
    },
    select: { id: true },
  });
}

/** The outbound private reply, linked to the comment it answers. */
async function seedReply(commentMessageId: string) {
  seq += 1;
  return prisma.message.create({
    data: {
      workspaceId,
      conversationId,
      externalId: `out:${S}:${seq}`,
      body: "yes, we ship there",
      direction: "out",
      channel: "instagram",
      replyToMessageId: commentMessageId,
    },
    select: { id: true },
  });
}

beforeEach(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  seq = 0;
  await freshWorkspace();
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("resolvePrivateReplyTarget", () => {
  it("finds an unanswered comment — the JSON path filter really matches", async () => {
    const comment = await seedComment("COMMENT-1");

    const target = await resolvePrivateReplyTarget(workspaceId, conversationId);

    // If the JSON filter silently matched nothing this would be null, and every
    // comment thread in the product would report the window closed forever.
    expect(target).not.toBeNull();
    expect(target).toEqual({
      commentId: "COMMENT-1",
      commentMessageId: comment.id,
      isLive: false,
    });
  });

  it("returns null when the thread holds no comment at all", async () => {
    await seedStructuredDm("location");
    await seedStructuredDm("story");

    // A shared location and a story reply ARE direct messages, just rich ones.
    // Treating either as a comment would address a send at a comment id that
    // does not exist.
    expect(await resolvePrivateReplyTarget(workspaceId, conversationId)).toBeNull();
  });

  it("never offers a comment we have already replied to", async () => {
    const comment = await seedComment("COMMENT-1");
    await seedReply(comment.id);

    // Meta permits exactly one private reply per comment. Offering it again
    // spends a billed round trip to earn an opaque error.
    expect(await resolvePrivateReplyTarget(workspaceId, conversationId)).toBeNull();
  });

  it("moves on to a NEWER unanswered comment once the first is spent", async () => {
    const first = await seedComment("COMMENT-OLD", 2 * DAY_MS);
    await seedReply(first.id);
    const second = await seedComment("COMMENT-NEW");

    const target = await resolvePrivateReplyTarget(workspaceId, conversationId);
    expect(target?.commentId).toBe("COMMENT-NEW");
    expect(target?.commentMessageId).toBe(second.id);
  });

  it("prefers the NEWEST eligible comment — freshest context, most window left", async () => {
    await seedComment("COMMENT-OLD", 5 * DAY_MS);
    await seedComment("COMMENT-MID", 2 * DAY_MS);
    await seedComment("COMMENT-NEW");

    expect((await resolvePrivateReplyTarget(workspaceId, conversationId))?.commentId).toBe(
      "COMMENT-NEW",
    );
  });

  it("refuses a comment past Meta's 7-day window rather than letting Meta refuse it", async () => {
    await seedComment("COMMENT-STALE", 8 * DAY_MS);

    expect(await resolvePrivateReplyTarget(workspaceId, conversationId)).toBeNull();
  });

  it("carries the live flag through, whose real window is the broadcast", async () => {
    await seedComment("COMMENT-LIVE", 0, true);

    expect((await resolvePrivateReplyTarget(workspaceId, conversationId))?.isLive).toBe(true);
  });

  it("is workspace-scoped — another tenant's comment is never a reply target", async () => {
    await seedComment("COMMENT-1");

    // The same conversation id read as a DIFFERENT workspace must yield nothing;
    // `workspaceId` is in the where of every query (CLAUDE.md §7).
    const otherOrg = await prisma.organization.create({
      data: { name: `IPR Other ${S}`, status: "active" },
    });
    const otherWs = await prisma.workspace.create({
      data: { name: `IPR Other WS ${S}`, organizationId: otherOrg.id },
    });
    try {
      expect(await resolvePrivateReplyTarget(otherWs.id, conversationId)).toBeNull();
    } finally {
      await prisma.organization.delete({ where: { id: otherOrg.id } }).catch(() => undefined);
    }
  });
});
