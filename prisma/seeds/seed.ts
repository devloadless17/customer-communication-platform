/**
 * Seed the development database with a small, deterministic demo dataset.
 *
 *   npm run db:seed
 *
 * Idempotent — every write goes through `upsert` keyed on stable string IDs,
 * so it's safe to re-run. Production seed should be limited to creating the
 * first superAdmin via a one-shot script; this file is dev-only by intent.
 *
 * Self-contained: data lives inline here, NOT in any production module. The
 * app reads conversations from Postgres via lib/queries.ts, never from a
 * fake-data import — so deleting this file would only break `db:seed`,
 * not the app.
 */

import { Prisma, PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const db = new PrismaClient();

if (process.env.NODE_ENV === "production") {
  // Belt-and-braces: prisma config + the package.json script run this only
  // on `npm run db:seed`, but a misconfigured CI could still wire it into a
  // prod boot. Refuse to write demo data to a production database.
  console.error(
    "[seed] refusing to run with NODE_ENV=production — this seeds DEMO data.",
  );
  process.exit(1);
}

// Default password for every seeded user — change after first login. Hashing
// once here (not per-user) is fine for dev and keeps `db:seed` instant.
const DEV_PASSWORD = "loadless";
const DEV_PASSWORD_HASH = bcrypt.hashSync(DEV_PASSWORD, 10);

const TEAM = { id: "team_1", name: "Loadless Support" };

const USERS = [
  { id: "u_me",   role: "superAdmin", name: "Ali Al-Ahmad", email: "ali@loadless.ai" },
  { id: "u_sara", role: "admin",      name: "Sara Khalil",  email: "sara@loadless.ai" },
  { id: "u_omar", role: "manager",    name: "Omar Reyes",   email: "omar@loadless.ai" },
  { id: "u_lina", role: "agent",      name: "Lina Becker",  email: "lina@loadless.ai" },
] as const;

const CONTACTS = [
  { id: "c_amelia",   phoneNumber: "+447911123456",  name: "Amelia Carter" },
  { id: "c_jamal",    phoneNumber: "+201001234567",  name: "Jamal El-Sayed" },
  { id: "c_sven",     phoneNumber: "+4915112345678", name: "Sven Rodriguez" },
  { id: "c_priya",    phoneNumber: "+919876543210",  name: "Priya Nair" },
  { id: "c_unknown",  phoneNumber: "+13105550199",   name: "+1 310 555 0199" },
  { id: "c_marco",    phoneNumber: "+393331234567",  name: "Marco Bianchi" },
  { id: "c_yuki",     phoneNumber: "+819012345678",  name: "Yuki Tanaka" },
  { id: "c_brigitte", phoneNumber: "+33612345678",   name: "Brigitte Laurent" },
  { id: "c_kwame",    phoneNumber: "+233244123456",  name: "Kwame Osei" },
  { id: "c_olivia",   phoneNumber: "+61412345678",   name: "Olivia Ng" },
] as const;

// Timestamps relative to seed time so "12m ago" labels stay realistic across
// re-seeds. ago(0) = now.
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000);

type SeedConvo = {
  id: string;
  contactId: typeof CONTACTS[number]["id"];
  assignedUserId: typeof USERS[number]["id"] | null;
  status: "open" | "pending" | "closed";
  unreadCount: number;
  messages: Array<
    | { dir: "in";  body: string; minutesAgo: number }
    | { dir: "out"; body: string; minutesAgo: number; senderUserId: typeof USERS[number]["id"]; status?: "sent" | "delivered" | "read" | "failed" }
  >;
  notes?: Array<{ authorUserId: typeof USERS[number]["id"]; body: string; minutesAgo: number }>;
};

const CONVERSATIONS: SeedConvo[] = [
  {
    id: "conv_amelia", contactId: "c_amelia", assignedUserId: "u_me",
    status: "open", unreadCount: 2,
    messages: [
      { dir: "in",  body: "Hi! I just bought the annual plan but I didn't get an invoice email.", minutesAgo: 47 },
      { dir: "in",  body: "Could you resend it to amelia@candor.co?", minutesAgo: 46 },
      { dir: "out", body: "Hey Amelia — looking into it now, give me a moment.", minutesAgo: 38, senderUserId: "u_me", status: "read" },
      { dir: "out", body: "Found the order, resending the invoice to that address right now.", minutesAgo: 24, senderUserId: "u_me", status: "read" },
      { dir: "in",  body: "Got it, thanks! One more thing — can I switch the billing email later?", minutesAgo: 9 },
      { dir: "in",  body: "Or is it locked once the subscription is active?", minutesAgo: 8 },
    ],
    notes: [
      { authorUserId: "u_sara", body: "FYI Stripe shows the invoice as paid, original send bounced — typo in their domain.", minutesAgo: 30 },
    ],
  },
  {
    id: "conv_jamal", contactId: "c_jamal", assignedUserId: "u_sara",
    status: "open", unreadCount: 1,
    messages: [
      { dir: "in",  body: "Salam! The dashboard is loading blank for my whole team since this morning.", minutesAgo: 120 },
      { dir: "out", body: "Hi Jamal — sorry about that. Could you share a screenshot of what you're seeing?", minutesAgo: 110, senderUserId: "u_sara", status: "read" },
      { dir: "in",  body: "Sent it to your email just now.", minutesAgo: 90 },
      { dir: "out", body: "Got it, our team is investigating. We'll update you within 30 min.", minutesAgo: 85, senderUserId: "u_sara", status: "read" },
      { dir: "in",  body: "Any update? It's been a while.", minutesAgo: 14 },
    ],
    notes: [
      { authorUserId: "u_omar", body: "Their workspace is on the affected shard — incident #2104, ETA 20 min.", minutesAgo: 70 },
    ],
  },
  {
    id: "conv_sven", contactId: "c_sven", assignedUserId: null,
    status: "open", unreadCount: 1,
    messages: [
      { dir: "in", body: "Hey, can I get a refund? Bought the wrong tier yesterday.", minutesAgo: 35 },
    ],
  },
  {
    id: "conv_priya", contactId: "c_priya", assignedUserId: "u_omar",
    status: "pending", unreadCount: 0,
    messages: [
      { dir: "in",  body: "Trying to integrate the API but I'm getting 401s on every request.", minutesAgo: 600 },
      { dir: "out", body: "Hey Priya — could you confirm you're using the workspace key, not the personal one?", minutesAgo: 590, senderUserId: "u_omar", status: "read" },
      { dir: "in",  body: "Oh, hadn't noticed those were different. Let me try.", minutesAgo: 540 },
      { dir: "out", body: "Sounds good, ping me here if it still fails.", minutesAgo: 535, senderUserId: "u_omar", status: "read" },
    ],
  },
  {
    id: "conv_unknown", contactId: "c_unknown", assignedUserId: null,
    status: "open", unreadCount: 1,
    messages: [
      { dir: "in", body: "Is this loadless? saw your post on linkedin", minutesAgo: 240 },
    ],
  },
  {
    id: "conv_marco", contactId: "c_marco", assignedUserId: "u_me",
    status: "open", unreadCount: 0,
    messages: [
      { dir: "in",  body: "Ciao! Quick one — can I export conversations to CSV?", minutesAgo: 1500 },
      { dir: "out", body: "Hi Marco! Not yet, but it's on the short-term roadmap. I'll DM you when it ships.", minutesAgo: 1490, senderUserId: "u_me", status: "read" },
      { dir: "in",  body: "Perfect, grazie!", minutesAgo: 1485 },
    ],
  },
  {
    id: "conv_yuki", contactId: "c_yuki", assignedUserId: "u_lina",
    status: "open", unreadCount: 0,
    messages: [
      { dir: "in",  body: "ありがとう、it's working now!", minutesAgo: 2880 },
      { dir: "out", body: "Glad to hear it Yuki — let me know if anything else comes up.", minutesAgo: 2875, senderUserId: "u_lina", status: "read" },
    ],
  },
  {
    id: "conv_brigitte", contactId: "c_brigitte", assignedUserId: "u_sara",
    status: "closed", unreadCount: 0,
    messages: [
      { dir: "in",  body: "Bonjour, my password reset email never arrived.", minutesAgo: 4400 },
      { dir: "out", body: "Hi Brigitte — I just triggered a fresh one, please check your spam folder too.", minutesAgo: 4390, senderUserId: "u_sara", status: "read" },
      { dir: "in",  body: "Found it, all set.", minutesAgo: 4380 },
    ],
  },
  {
    id: "conv_kwame", contactId: "c_kwame", assignedUserId: null,
    status: "pending", unreadCount: 0,
    messages: [
      { dir: "in",  body: "Hello — when will mobile push notifications be available?", minutesAgo: 6000 },
      { dir: "out", body: "Hey Kwame — likely in the next month or so. I'll loop you in once we have a date.", minutesAgo: 5990, senderUserId: "u_omar", status: "read" },
    ],
  },
  {
    id: "conv_olivia", contactId: "c_olivia", assignedUserId: "u_me",
    status: "open", unreadCount: 0,
    messages: [
      { dir: "in",  body: "Heads up — your status page shows a degradation but we're not seeing any issues here.", minutesAgo: 12 },
      { dir: "out", body: "Thanks Olivia, that's an old incident the page didn't auto-close. Fixing now.", minutesAgo: 4, senderUserId: "u_me", status: "delivered" },
    ],
  },
];

async function main() {
  console.log(`→ team ${TEAM.name}`);
  await db.team.upsert({
    where: { id: TEAM.id },
    create: { id: TEAM.id, name: TEAM.name },
    update: { name: TEAM.name },
  });

  console.log(`→ ${USERS.length} users (default password: "${DEV_PASSWORD}")`);
  for (const u of USERS) {
    await db.user.upsert({
      where: { id: u.id },
      create: {
        id: u.id, teamId: TEAM.id, role: u.role, name: u.name, email: u.email,
        passwordHash: DEV_PASSWORD_HASH,
      },
      update: {
        teamId: TEAM.id, role: u.role, name: u.name, email: u.email,
        // Reset password on every reseed so dev never gets locked out.
        passwordHash: DEV_PASSWORD_HASH,
        // Re-enable any previously deactivated seeded user.
        deactivatedAt: null,
      },
    });
    // Better Auth verifies signin against Account.password (providerId
    // "credential", accountId = email), NOT User.passwordHash. Without this
    // row the seeded user fails login with "Credential account not found".
    await db.account.upsert({
      where: { providerId_accountId: { providerId: "credential", accountId: u.email } },
      create: {
        userId: u.id,
        providerId: "credential",
        accountId: u.email,
        password: DEV_PASSWORD_HASH,
      },
      update: { password: DEV_PASSWORD_HASH, userId: u.id },
    });
  }

  console.log(`→ ${CONTACTS.length} contacts`);
  for (const c of CONTACTS) {
    await db.contact.upsert({
      where: { id: c.id },
      create: { id: c.id, teamId: TEAM.id, phoneNumber: c.phoneNumber, name: c.name },
      update: { phoneNumber: c.phoneNumber, name: c.name },
    });
  }

  console.log(`→ ${CONVERSATIONS.length} conversations + messages + notes`);
  for (const c of CONVERSATIONS) {
    const lastMsg = c.messages[c.messages.length - 1]!;
    const lastTs = ago(lastMsg.minutesAgo);
    await db.conversation.upsert({
      where: { id: c.id },
      create: {
        id: c.id, teamId: TEAM.id, contactId: c.contactId,
        assignedUserId: c.assignedUserId, status: c.status,
        unreadCount: c.unreadCount, lastMessageAt: lastTs,
        lastMessagePreview: lastMsg.body.slice(0, 200),
      },
      update: {
        assignedUserId: c.assignedUserId, status: c.status,
        unreadCount: c.unreadCount, lastMessageAt: lastTs,
        lastMessagePreview: lastMsg.body.slice(0, 200),
      },
    });

    for (const [idx, m] of c.messages.entries()) {
      const externalId = `seed_${c.id}_${idx}`;
      await db.message.upsert({
        where: {
          teamId_provider_externalId: {
            teamId: TEAM.id,
            provider: "meta_cloud",
            externalId,
          },
        },
        create: {
          teamId: TEAM.id, conversationId: c.id, externalId,
          senderUserId: m.dir === "out" ? m.senderUserId : null,
          body: m.body, direction: m.dir, provider: "meta_cloud",
          status: m.dir === "out" ? (m.status ?? "delivered") : "delivered",
          rawPayload: { seed: true } as Prisma.InputJsonValue,
          timestamp: ago(m.minutesAgo),
        },
        update: {
          body: m.body,
          status: m.dir === "out" ? (m.status ?? "delivered") : "delivered",
          timestamp: ago(m.minutesAgo),
        },
      });
    }

    for (const [idx, n] of (c.notes ?? []).entries()) {
      const id = `${c.id}_n_${idx}`;
      await db.internalNote.upsert({
        where: { id },
        create: {
          id, conversationId: c.id, authorUserId: n.authorUserId,
          body: n.body, timestamp: ago(n.minutesAgo),
        },
        update: { body: n.body, timestamp: ago(n.minutesAgo) },
      });
    }
  }
}

main()
  .then(async () => {
    console.log("✓ seed complete");
    await db.$disconnect();
  })
  .catch(async (err) => {
    console.error(err);
    await db.$disconnect();
    process.exit(1);
  });
