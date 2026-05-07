/**
 * Seed the development database with the same fake data that powered Phase 0.
 *
 * Idempotent — every write goes through `upsert`, keyed on stable string IDs.
 * Run any number of times safely:
 *
 *   npm run db:seed
 *
 * Source of truth is still lib/fake-data.ts so screenshots stay reproducible.
 */

import { Prisma, PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

import {
  fakeContacts,
  fakeConversations,
  fakeMessages,
  fakeNotes,
  fakeTeam,
  fakeUsers,
} from "../lib/fake-data";

const db = new PrismaClient();

// Default password for every seeded user — change after first login. Hashing
// once here (not per-user) is fine for dev and keeps `db:seed` instant.
const DEV_PASSWORD = "loadless";
const DEV_PASSWORD_HASH = bcrypt.hashSync(DEV_PASSWORD, 10);

async function main() {
  console.log(`→ team ${fakeTeam.name}`);
  await db.team.upsert({
    where: { id: fakeTeam.id },
    create: { id: fakeTeam.id, name: fakeTeam.name },
    update: { name: fakeTeam.name },
  });

  console.log(`→ ${fakeUsers.length} users (default password: "${DEV_PASSWORD}")`);
  for (const u of fakeUsers) {
    await db.user.upsert({
      where: { id: u.id },
      create: {
        id: u.id,
        teamId: u.teamId,
        role: u.role,
        name: u.name,
        email: u.email,
        passwordHash: DEV_PASSWORD_HASH,
      },
      update: {
        teamId: u.teamId,
        role: u.role,
        name: u.name,
        email: u.email,
        // Reset password on every reseed so dev never gets locked out.
        passwordHash: DEV_PASSWORD_HASH,
        // Re-enable any previously deactivated seeded user.
        deactivatedAt: null,
      },
    });
  }

  console.log(`→ ${fakeContacts.length} contacts`);
  for (const c of fakeContacts) {
    await db.contact.upsert({
      where: { id: c.id },
      create: {
        id: c.id,
        teamId: c.teamId,
        phoneNumber: c.phoneNumber,
        name: c.name,
      },
      update: { phoneNumber: c.phoneNumber, name: c.name },
    });
  }

  console.log(`→ ${fakeConversations.length} conversations`);
  for (const c of fakeConversations) {
    await db.conversation.upsert({
      where: { id: c.id },
      create: {
        id: c.id,
        teamId: c.teamId,
        contactId: c.contactId,
        assignedUserId: c.assignedUserId,
        status: c.status,
        unreadCount: c.unreadCount,
        lastMessageAt: new Date(c.lastMessageAt),
        lastMessagePreview: c.lastMessagePreview,
      },
      update: {
        assignedUserId: c.assignedUserId,
        status: c.status,
        unreadCount: c.unreadCount,
        lastMessageAt: new Date(c.lastMessageAt),
        lastMessagePreview: c.lastMessagePreview,
      },
    });
  }

  console.log(`→ ${fakeMessages.length} messages`);
  for (const m of fakeMessages) {
    await db.message.upsert({
      where: { externalId: m.externalId },
      create: {
        id: m.id,
        teamId: m.teamId,
        conversationId: m.conversationId,
        externalId: m.externalId,
        senderUserId: m.senderUserId,
        body: m.body,
        direction: m.direction,
        provider: m.provider,
        status: m.status,
        rawPayload: m.rawPayload as Prisma.InputJsonValue,
        timestamp: new Date(m.timestamp),
      },
      update: {
        body: m.body,
        status: m.status,
        timestamp: new Date(m.timestamp),
      },
    });
  }

  console.log(`→ ${fakeNotes.length} internal notes`);
  for (const n of fakeNotes) {
    await db.internalNote.upsert({
      where: { id: n.id },
      create: {
        id: n.id,
        conversationId: n.conversationId,
        authorUserId: n.authorUserId,
        body: n.body,
        timestamp: new Date(n.timestamp),
      },
      update: { body: n.body, timestamp: new Date(n.timestamp) },
    });
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
