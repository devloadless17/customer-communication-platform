/**
 * Stuff 150 messages into one conversation so the message-thread pagination
 * (50 per page, scroll-up to load older) is visible without finding a real
 * customer who chats a lot.
 *
 *   npm run db:seed:long           # default: 150 messages
 *   npm run db:seed:long -- 300    # custom count
 *
 * Targets the first non-closed conversation in the DB (stable order). Idempotent:
 * each fake message uses externalId `dev_long_<convoId>_<i>` and is upserted, so
 * re-running just refreshes content without duplicating.
 */

import { existsSync } from "node:fs";

import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import { Pool } from "pg";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = new PrismaClient({ adapter: new PrismaPg(pool) });

const COUNT = (() => {
  const arg = process.argv[2];
  if (!arg) return 150;
  const n = Number.parseInt(arg, 10);
  if (!Number.isFinite(n) || n <= 0) return 150;
  return Math.min(n, 1000);
})();

// Two-minute spacing covers ~5 hours for 150 messages — gives the timeline
// realistic spread without crossing day boundaries excessively.
const SPACING_MS = 2 * 60 * 1000;

const INBOUND_LINES = [
  "Hi, just checking in on my order",
  "Did the package ship today?",
  "Sorry for the delay on my side",
  "That works for me 👍",
  "Could you double-check the address?",
  "Quick question about the warranty",
  "Got it, thanks!",
  "Any update?",
  "Perfect, talk soon",
  "Will the new size be available next week?",
];

const OUTBOUND_LINES = [
  "Hey! Let me check that for you",
  "Yes, it shipped this morning — tracking incoming",
  "No worries at all",
  "Great, I'll get that sorted",
  "Confirming the address now",
  "Sure thing, the warranty covers 12 months",
  "Anytime!",
  "Just looking, one moment",
  "Talk soon — have a good one",
  "Restock lands Thursday, I'll ping you",
];

function pick<T>(arr: T[], i: number): T {
  return arr[i % arr.length]!;
}

async function main() {
  const conversation = await db.conversation.findFirst({
    where: { status: { not: "closed" } },
    orderBy: { id: "asc" },
    // (`team` was included here until the Team → Workspace rename; the row's
    // scalar `workspaceId` is all the seed actually uses.)
    include: { contact: true },
  });
  if (!conversation) {
    console.error("no open conversation found — run `npm run db:seed` first");
    process.exit(1);
  }

  console.log(
    `→ stuffing ${COUNT} messages into ${conversation.contact.name}'s thread (${conversation.id})`,
  );

  const baseTime = Date.now();
  let latestTimestamp = new Date(baseTime);
  let latestBody = "";
  let latestDirection: "in" | "out" = "in";

  for (let i = 0; i < COUNT; i++) {
    // Newest at i=0, oldest at i=COUNT-1.
    const ts = new Date(baseTime - i * SPACING_MS);
    const direction: "in" | "out" = i % 2 === 0 ? "in" : "out";
    const body =
      direction === "in" ? pick(INBOUND_LINES, i) : pick(OUTBOUND_LINES, i);
    const externalId = `dev_long_${conversation.id}_${String(i).padStart(4, "0")}`;

    await db.message.upsert({
      where: {
        workspaceId_channel_externalId: {
          workspaceId: conversation.workspaceId,
          channel: "whatsapp",
          externalId,
        },
      },
      create: {
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        externalId,
        senderUserId: null, // outbound dev messages keep null sender to keep the script simple
        body,
        direction,
        channel: "whatsapp",
        status: direction === "in" ? "delivered" : "sent",
        rawPayload: { source: "dev-long-thread" } as Prisma.InputJsonValue,
        timestamp: ts,
      },
      update: {
        body,
        timestamp: ts,
        direction,
        status: direction === "in" ? "delivered" : "sent",
      },
    });

    if (i === 0) {
      latestTimestamp = ts;
      latestBody = body;
      latestDirection = direction;
    }
  }

  // Bump the conversation summary so the inbox row reflects the latest message.
  await db.conversation.update({
    where: { id: conversation.id },
    data: {
      lastMessageAt: latestTimestamp,
      lastMessagePreview: latestBody.slice(0, 200),
      // Inbox UX: bumping unread when the latest is inbound is realistic.
      ...(latestDirection === "in" ? { unreadCount: { increment: 0 } } : {}),
    },
  });

  console.log(`✓ open the inbox and click the first thread, or visit:`);
  console.log(`  /inbox/${conversation.id}`);
}

main()
  .then(async () => {
    await db.$disconnect();
    await pool.end();
  })
  .catch(async (err) => {
    console.error(err);
    await db.$disconnect();
    await pool.end();
    process.exit(1);
  });
