/**
 * One-shot cleanup for the phone-format bug fixed in lib/phone.ts.
 *
 * Pre-fix state: manual-create + CSV import stored phones as `+digits` while
 * the webhook stored Meta's `digits` (no +). The same person hitting both
 * paths produced two contact rows with two parallel conversations.
 *
 *   npm run db:fix:phones
 *
 * What it does:
 *   1) For each (teamId, digits-only-phone) pair where >1 contact exists:
 *      - Pick the OLDEST as the survivor.
 *      - Union the orphans' tags into the survivor.
 *      - Reparent every Conversation, BroadcastRecipient row off the orphans.
 *      - Backfill the survivor's name / email / location / customFields
 *        from the orphan whenever the survivor was missing the value.
 *      - Delete the orphan contact.
 *   2) Strip `+` from every remaining contact's phoneNumber so future
 *      writes (which now use digits-only) collide and dedupe cleanly.
 *   3) For every contact that ends up with multiple non-closed conversations
 *      (typical post-merge outcome), merge them: move all messages and
 *      internal notes into the oldest one, delete the rest. Closed threads
 *      stay untouched — they're historical.
 *
 * Idempotent: re-running on a clean DB is a no-op.
 */

import { Prisma, PrismaClient } from "@prisma/client";

const db = new PrismaClient();

function stripPlus(s: string): string {
  return s.startsWith("+") ? s.slice(1) : s;
}

async function main() {
  let mergedContacts = 0;
  let mergedConversations = 0;
  let strippedPlus = 0;
  let movedRecipients = 0;
  let deletedConflictRecipients = 0;

  // -------------------------------------------------------------------------
  // Phase 1: dedupe contacts that match on (teamId, digits-only-phone).
  // -------------------------------------------------------------------------
  const allContacts = await db.contact.findMany({
    select: {
      id: true,
      teamId: true,
      phoneNumber: true,
      name: true,
      email: true,
      location: true,
      customFields: true,
      source: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const groups = new Map<string, typeof allContacts>();
  for (const c of allContacts) {
    const digits = c.phoneNumber.replace(/\D/g, "");
    if (!digits) continue;
    const key = `${c.teamId}|${digits}`;
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }

  for (const [, dupGroup] of groups) {
    if (dupGroup.length === 1) continue;

    // Oldest wins. Sort already happened via the findMany orderBy.
    const survivor = dupGroup[0]!;
    const orphans = dupGroup.slice(1);

    for (const orphan of orphans) {
      // Tag union: connect every orphan tag to the survivor.
      const orphanWithTags = await db.contact.findUnique({
        where: { id: orphan.id },
        select: { tags: { select: { id: true } } },
      });
      if (orphanWithTags && orphanWithTags.tags.length > 0) {
        await db.contact.update({
          where: { id: survivor.id },
          data: { tags: { connect: orphanWithTags.tags } },
        });
      }

      // Reparent conversations.
      await db.conversation.updateMany({
        where: { contactId: orphan.id },
        data: { contactId: survivor.id },
      });

      // Reparent broadcast recipients — handle the (broadcastId, contactId)
      // unique constraint: if survivor was ALSO a recipient of the same
      // broadcast, the orphan's row would conflict. Drop it; the survivor's
      // row already represents that recipient.
      const orphanRecipients = await db.broadcastRecipient.findMany({
        where: { contactId: orphan.id },
        select: { id: true, broadcastId: true },
      });
      if (orphanRecipients.length > 0) {
        const broadcastIds = orphanRecipients.map((r) => r.broadcastId);
        const existing = await db.broadcastRecipient.findMany({
          where: {
            contactId: survivor.id,
            broadcastId: { in: broadcastIds },
          },
          select: { broadcastId: true },
        });
        const survivorBroadcastIds = new Set(existing.map((r) => r.broadcastId));

        for (const r of orphanRecipients) {
          if (survivorBroadcastIds.has(r.broadcastId)) {
            await db.broadcastRecipient.delete({ where: { id: r.id } });
            deletedConflictRecipients++;
          } else {
            await db.broadcastRecipient.update({
              where: { id: r.id },
              data: { contactId: survivor.id },
            });
            movedRecipients++;
          }
        }
      }

      // Backfill survivor fields when blank — orphan may have intentional
      // user-entered name/email even if it's a newer row.
      const survivorRow = await db.contact.findUnique({ where: { id: survivor.id } });
      if (!survivorRow) continue;
      const patch: Prisma.ContactUpdateInput = {};
      const survivorNameLooksLikePhone =
        survivorRow.name.replace(/\D/g, "") === survivorRow.phoneNumber.replace(/\D/g, "");
      const orphanNameLooksLikePhone =
        orphan.name.replace(/\D/g, "") === orphan.phoneNumber.replace(/\D/g, "");
      if (survivorNameLooksLikePhone && !orphanNameLooksLikePhone) {
        patch.name = orphan.name;
      }
      if (!survivorRow.email && orphan.email) patch.email = orphan.email;
      if (!survivorRow.location && orphan.location) patch.location = orphan.location;
      // Merge customFields — survivor wins on key collision.
      const sf = (survivorRow.customFields as Record<string, string> | null) ?? {};
      const of = (orphan.customFields as Record<string, string> | null) ?? {};
      const mergedFields = { ...of, ...sf };
      if (Object.keys(mergedFields).length !== Object.keys(sf).length) {
        patch.customFields = mergedFields as Prisma.InputJsonValue;
      }
      if (Object.keys(patch).length > 0) {
        await db.contact.update({ where: { id: survivor.id }, data: patch });
      }

      await db.contact.delete({ where: { id: orphan.id } });
      mergedContacts++;
      console.log(
        `  merged ${orphan.id} (${orphan.phoneNumber}) → ${survivor.id} (${survivor.phoneNumber})`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Phase 2: strip `+` from every remaining contact.
  // -------------------------------------------------------------------------
  const survivingWithPlus = await db.contact.findMany({
    where: { phoneNumber: { startsWith: "+" } },
    select: { id: true, phoneNumber: true, teamId: true },
  });
  for (const c of survivingWithPlus) {
    const digits = stripPlus(c.phoneNumber);
    // Defensive: if a digits-only row already exists for the same team
    // (shouldn't, since phase 1 deduped) skip rather than crash on the unique.
    const collision = await db.contact.findFirst({
      where: { teamId: c.teamId, phoneNumber: digits, NOT: { id: c.id } },
      select: { id: true },
    });
    if (collision) {
      console.warn(
        `  skipping ${c.id}: digits-only ${digits} already taken by ${collision.id}`,
      );
      continue;
    }
    await db.contact.update({
      where: { id: c.id },
      data: { phoneNumber: digits },
    });
    strippedPlus++;
  }

  // -------------------------------------------------------------------------
  // Phase 3: collapse multiple non-closed conversations per contact.
  // After phase 1 a survivor often inherits the orphan's conversation, so
  // they end up with two open threads for the same person. Merge into the
  // oldest one so the UI shows a single thread.
  // -------------------------------------------------------------------------
  const contactsWithMultipleOpens = await db.contact.findMany({
    select: {
      id: true,
      conversations: {
        where: { status: { not: "closed" } },
        orderBy: { createdAt: "asc" },
        select: { id: true, assignedUserId: true, unreadCount: true },
      },
    },
  });

  for (const c of contactsWithMultipleOpens) {
    if (c.conversations.length < 2) continue;
    const target = c.conversations[0]!;
    const toMerge = c.conversations.slice(1);

    let unreadDelta = 0;

    for (const conv of toMerge) {
      // Move messages.
      await db.message.updateMany({
        where: { conversationId: conv.id },
        data: { conversationId: target.id },
      });
      // Move internal notes.
      await db.internalNote.updateMany({
        where: { conversationId: conv.id },
        data: { conversationId: target.id },
      });
      // Move broadcast recipient pointers (purely cosmetic — keeps the
      // "Open chat" link on the broadcast detail page working).
      await db.broadcastRecipient.updateMany({
        where: { conversationId: conv.id },
        data: { conversationId: target.id },
      });
      // If the orphan conv had an assigned user and target didn't, take it.
      if (!c.conversations[0]?.assignedUserId && conv.assignedUserId) {
        await db.conversation.update({
          where: { id: target.id },
          data: { assignedUserId: conv.assignedUserId },
        });
      }
      unreadDelta += conv.unreadCount;
      await db.conversation.delete({ where: { id: conv.id } });
      mergedConversations++;
    }

    // Recompute target's last-message summary + unread total.
    const latest = await db.message.findFirst({
      where: { conversationId: target.id },
      orderBy: { timestamp: "desc" },
      select: { timestamp: true, body: true },
    });
    await db.conversation.update({
      where: { id: target.id },
      data: {
        ...(latest
          ? {
              lastMessageAt: latest.timestamp,
              lastMessagePreview: latest.body.slice(0, 200),
            }
          : {}),
        unreadCount: { increment: unreadDelta },
      },
    });
  }

  console.log("\n✓ done.");
  console.log(`  merged contacts:         ${mergedContacts}`);
  console.log(`  stripped + from:         ${strippedPlus}`);
  console.log(`  merged conversations:    ${mergedConversations}`);
  console.log(`  moved broadcast rcpts:   ${movedRecipients}`);
  console.log(`  deleted conflict rcpts:  ${deletedConflictRecipients}`);
}

main()
  .then(async () => {
    await db.$disconnect();
  })
  .catch(async (err) => {
    console.error(err);
    await db.$disconnect();
    process.exit(1);
  });
