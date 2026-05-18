/**
 * Seed three fake conversations whose last inbound message is older than the
 * 24h customer-service window — so the inbox reply box renders the "Send
 * template" CTA and the agent can exercise the template flow without waiting
 * for a real customer to go cold.
 *
 *   npm run db:seed:closed                  # lists teams, prints usage
 *   npm run db:seed:closed -- <team-id>     # seed into a specific team by id
 *   npm run db:seed:closed -- "Acme Inc"    # …or by exact / case-insensitive name
 *
 * Idempotent: every row uses team-scoped IDs (`dev_closed_<teamId>_*`) so
 * running it for two different teams creates two separate sets, and re-running
 * for the same team just refreshes timestamps.
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = new PrismaClient({ adapter: new PrismaPg(pool) });

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

interface FakeChat {
  // Slug used to derive per-team conversation/contact ids, NOT a primary key.
  slug: string;
  name: string;
  phone: string;
  // How many days ago the most recent inbound landed. > 1 means the window
  // is closed for sure.
  lastInboundDaysAgo: number;
  // Ordered oldest → newest. The last `in` message determines the window.
  messages: Array<{ direction: "in" | "out"; body: string; minutesOffset: number }>;
}

const FAKE_CHATS: FakeChat[] = [
  {
    slug: "convo_1",
    name: "Lara Mendes",
    phone: "5511999000111",
    lastInboundDaysAgo: 3,
    messages: [
      { direction: "in", body: "Oi! Quero saber sobre o status do meu pedido", minutesOffset: 0 },
      { direction: "out", body: "Oi Lara! Vou verificar agora mesmo", minutesOffset: 4 },
      { direction: "in", body: "Obrigada!", minutesOffset: 6 },
      { direction: "out", body: "Saiu para entrega hoje cedo, deve chegar até as 17h", minutesOffset: 12 },
    ],
  },
  {
    slug: "convo_2",
    name: "Marcus Tan",
    phone: "6591234567",
    lastInboundDaysAgo: 5,
    messages: [
      { direction: "in", body: "Hi, is the warranty still active on my unit?", minutesOffset: 0 },
      { direction: "out", body: "Let me pull that up — one sec", minutesOffset: 3 },
      { direction: "out", body: "Yes, you're covered through November 2026", minutesOffset: 11 },
      { direction: "in", body: "Perfect, thanks for confirming", minutesOffset: 18 },
    ],
  },
  {
    slug: "convo_3",
    name: "Aïcha Ndiaye",
    phone: "33611223344",
    lastInboundDaysAgo: 8,
    messages: [
      { direction: "in", body: "Bonjour, j'aimerais savoir si vous livrez en France", minutesOffset: 0 },
      { direction: "out", body: "Bonjour! Oui, nous livrons en France en 3-5 jours", minutesOffset: 7 },
      { direction: "in", body: "Super, merci beaucoup", minutesOffset: 12 },
    ],
  },
];

/**
 * Resolve the target team from a CLI argument. Tries (in order):
 *   1) exact id match
 *   2) exact name match (case-sensitive — the obvious one)
 *   3) case-insensitive name match — for shells that lowercase / typos
 *
 * If the arg is omitted, prints a usage banner with the available teams so
 * the user can pick one. We never silently default to "first team" — that
 * caused a footgun where data landed in the wrong tenant.
 */
async function resolveTeam(arg: string | undefined) {
  const teams = await db.team.findMany({
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });
  if (teams.length === 0) {
    console.error("no teams found — run `npm run db:seed` first to create the dev team");
    process.exit(1);
  }

  if (!arg) {
    console.error("Usage: npm run db:seed:closed -- <team-id-or-name>\n");
    console.error("Available teams:");
    for (const t of teams) {
      console.error(`  • ${t.name}   (${t.id})`);
    }
    process.exit(1);
  }

  const lower = arg.toLowerCase();
  const match =
    teams.find((t) => t.id === arg) ??
    teams.find((t) => t.name === arg) ??
    teams.find((t) => t.name.toLowerCase() === lower);
  if (!match) {
    console.error(`no team matches "${arg}". Known teams:`);
    for (const t of teams) console.error(`  • ${t.name}   (${t.id})`);
    process.exit(1);
  }
  return match;
}

async function main() {
  const team = await resolveTeam(process.argv[2]);
  console.log(`→ seeding into team "${team.name}" (${team.id})`);

  const now = Date.now();
  // Namespace every stable id by team so the same script can populate two
  // teams without colliding on the message externalId UNIQUE index.
  const ns = `dev_closed_${team.id}`;

  for (const chat of FAKE_CHATS) {
    const conversationId = `${ns}_${chat.slug}`;
    const contactId = `${ns}_contact_${chat.slug}`;
    // Anchor the last inbound at exactly `lastInboundDaysAgo` ago. The latest
    // message in the script is the last entry — but outbound messages don't
    // refresh the window, so what we actually need to land at the cutoff is
    // the latest `in` entry.
    const lastInMinuteOffset = Math.max(
      ...chat.messages
        .map((m, i) => ({ m, i }))
        .filter((x) => x.m.direction === "in")
        .map((x) => x.m.minutesOffset),
    );
    const baseTime =
      now - chat.lastInboundDaysAgo * ONE_DAY_MS - lastInMinuteOffset * 60 * 1000;

    await db.contact.upsert({
      where: { id: contactId },
      create: {
        id: contactId,
        teamId: team.id,
        phoneNumber: chat.phone,
        name: chat.name,
        source: "inbound",
      },
      update: { name: chat.name, phoneNumber: chat.phone },
    });

    const latestMsg = chat.messages[chat.messages.length - 1]!;
    const lastMessageAt = new Date(baseTime + latestMsg.minutesOffset * 60 * 1000);

    await db.conversation.upsert({
      where: { id: conversationId },
      create: {
        id: conversationId,
        teamId: team.id,
        contactId,
        status: "open",
        unreadCount: 0,
        lastMessageAt,
        lastMessagePreview: latestMsg.body.slice(0, 200),
      },
      update: {
        lastMessageAt,
        lastMessagePreview: latestMsg.body.slice(0, 200),
        status: "open",
      },
    });

    for (let i = 0; i < chat.messages.length; i += 1) {
      const m = chat.messages[i]!;
      const ts = new Date(baseTime + m.minutesOffset * 60 * 1000);
      const externalId = `${conversationId}_msg_${String(i).padStart(3, "0")}`;
      await db.message.upsert({
        where: {
          teamId_provider_externalId: {
            teamId: team.id,
            provider: "meta_cloud",
            externalId,
          },
        },
        create: {
          teamId: team.id,
          conversationId,
          externalId,
          senderUserId: null,
          body: m.body,
          direction: m.direction,
          provider: "meta_cloud",
          status: m.direction === "in" ? "delivered" : "sent",
          rawPayload: { source: "dev-closed-window" } as Prisma.InputJsonValue,
          timestamp: ts,
        },
        update: {
          body: m.body,
          timestamp: ts,
          direction: m.direction,
          status: m.direction === "in" ? "delivered" : "sent",
        },
      });
    }

    console.log(
      `  • ${chat.name} (${chat.phone}) — last inbound ${chat.lastInboundDaysAgo}d ago → /inbox/${conversationId}`,
    );
  }

  console.log("\n✓ done. Open the inbox to see the 3 closed-window chats.");
  console.log("  Each one will show the 'Send template' CTA in the composer.");
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
