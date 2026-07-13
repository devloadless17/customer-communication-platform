/**
 * Meta reaction lifecycle — Messenger + Instagram, end to end through the REAL
 * pipeline (HMAC verify → parseWebhook → ingestReaction → DB). A customer reacts
 * to one of OUR outbound messages; we set the emoji, and — the bug this locks in
 * — a REMOVE clears it. Instagram is the tricky one: it reports an un-react as
 * the same emoji tapped again (or a leftover type name) rather than an explicit
 * empty payload, so we verify BOTH the explicit-unreact and the tap-again-to-
 * remove (toggle) paths clear the pill. WhatsApp's identical-emoji re-arrival is
 * a no-op (redelivery-safe), so the toggle is social-only.
 */

import { test, expect } from "@playwright/test";

import { db } from "../_helpers/db";
import {
  seedMetaTestTeam,
  seedSocialConversation,
  postMetaWebhook,
  META_TEST_TEAM_ID,
  MSGR_PAGE_ID,
  IG_ID,
} from "../_helpers/meta";

test.describe.configure({ mode: "serial" });

// Convention (see receive-enhancements.spec.ts): seed in beforeAll but DON'T
// wipe — `wipeMetaTestTeam` mid-run stales the 60s provider-config cache and
// breaks every following spec. External ids below are unique across the suite,
// so the final spec's wipe cleans up our rows harmlessly.
test.beforeAll(async () => {
  await seedMetaTestTeam();
});

type SocialObject = "page" | "instagram";

/** A `message_reactions` webhook: the customer (un)reacted to our outbound msg. */
function reactionWebhook(o: {
  object: SocialObject;
  accountId: string;
  senderId: string;
  mid: string;
  action: "react" | "unreact";
  emoji?: string;
  reaction?: string;
}): unknown {
  const reaction: Record<string, unknown> = { mid: o.mid, action: o.action };
  if (o.emoji != null) reaction.emoji = o.emoji;
  if (o.reaction != null) reaction.reaction = o.reaction;
  return {
    object: o.object,
    entry: [
      {
        id: o.accountId,
        time: Date.now(),
        messaging: [
          {
            sender: { id: o.senderId },
            recipient: { id: o.accountId },
            timestamp: Date.now(),
            reaction,
          },
        ],
      },
    ],
  };
}

/** Seed an OUTBOUND message (what the customer reacts to) and return its mid. */
async function seedOutbound(o: {
  channel: "messenger" | "instagram";
  externalContactId: string;
  mid: string;
}): Promise<void> {
  // Idempotent: this spec follows the suite convention of NOT wiping the team in
  // afterAll (a mid-run wipe stales the provider-config cache), so its rows
  // persist until the final spec cleans up. Clear just OUR own contact (+ its
  // cascade) first so a re-run — or an isolated run that left residue — never
  // collides on the unique (team, channel, externalContactId).
  const existing = await db().contact.findFirst({
    where: { teamId: META_TEST_TEAM_ID, identityChannel: o.channel, externalContactId: o.externalContactId },
    select: { id: true },
  });
  if (existing) {
    await db().message.deleteMany({ where: { teamId: META_TEST_TEAM_ID, conversation: { contactId: existing.id } } });
    await db().conversation.deleteMany({ where: { teamId: META_TEST_TEAM_ID, contactId: existing.id } });
    await db().contact.delete({ where: { id: existing.id } });
  }
  const { conversationId } = await seedSocialConversation({
    teamId: META_TEST_TEAM_ID,
    channel: o.channel,
    externalContactId: o.externalContactId,
    name: "Reaction Tester",
  });
  await db().message.create({
    data: {
      teamId: META_TEST_TEAM_ID,
      conversationId,
      channel: o.channel,
      externalId: o.mid,
      body: "our outbound message",
      direction: "out",
    },
  });
}

function reactionOf(channel: "messenger" | "instagram", mid: string) {
  return db()
    .message.findUnique({
      where: { teamId_channel_externalId: { teamId: META_TEST_TEAM_ID, channel, externalId: mid } },
      select: { reaction: true },
    })
    .then((m) => m?.reaction ?? null);
}

test("Instagram: react sets the emoji, explicit unreact clears it", async () => {
  const igsid = "1784rxn0000001";
  const mid = "ig.rxn.1";
  await seedOutbound({ channel: "instagram", externalContactId: igsid, mid });

  // React ❤️ (bare heart, as Meta often sends — no VS16).
  let res = await postMetaWebhook(
    META_TEST_TEAM_ID,
    reactionWebhook({ object: "instagram", accountId: IG_ID, senderId: igsid, mid, action: "react", reaction: "love", emoji: "❤" }),
  );
  expect(res.status, res.text).toBe(200);
  expect(await reactionOf("instagram", mid)).toBe("❤"); // stored canonicalized (no VS16)

  // Explicit unreact → cleared.
  res = await postMetaWebhook(
    META_TEST_TEAM_ID,
    reactionWebhook({ object: "instagram", accountId: IG_ID, senderId: igsid, mid, action: "unreact" }),
  );
  expect(res.status, res.text).toBe(200);
  expect(await reactionOf("instagram", mid)).toBeNull();
});

test("Instagram: tap-again-to-remove (same emoji, no unreact action) clears it", async () => {
  const igsid = "1784rxn0000002";
  const mid = "ig.rxn.2";
  await seedOutbound({ channel: "instagram", externalContactId: igsid, mid });

  // React ❤️.
  await postMetaWebhook(
    META_TEST_TEAM_ID,
    reactionWebhook({ object: "instagram", accountId: IG_ID, senderId: igsid, mid, action: "react", emoji: "❤️" }),
  );
  expect(await reactionOf("instagram", mid)).toBe("❤");

  // Re-tap the SAME emoji with action still "react" (IG's remove shape) → toggle off.
  await postMetaWebhook(
    META_TEST_TEAM_ID,
    reactionWebhook({ object: "instagram", accountId: IG_ID, senderId: igsid, mid, action: "react", reaction: "love", emoji: "❤️" }),
  );
  expect(await reactionOf("instagram", mid)).toBeNull();
});

test("Instagram: leftover type name with no glyph is treated as a remove, not the word", async () => {
  const igsid = "1784rxn0000003";
  const mid = "ig.rxn.3";
  await seedOutbound({ channel: "instagram", externalContactId: igsid, mid });

  await postMetaWebhook(
    META_TEST_TEAM_ID,
    reactionWebhook({ object: "instagram", accountId: IG_ID, senderId: igsid, mid, action: "react", emoji: "❤️" }),
  );
  expect(await reactionOf("instagram", mid)).toBe("❤");

  // Unreact reported as a bare type name, no glyph, no explicit unreact action.
  await postMetaWebhook(
    META_TEST_TEAM_ID,
    reactionWebhook({ object: "instagram", accountId: IG_ID, senderId: igsid, mid, action: "react", reaction: "love" }),
  );
  // Must clear — never store the word "love".
  expect(await reactionOf("instagram", mid)).toBeNull();
});

test("Messenger: react sets, unreact clears", async () => {
  const psid = "6009rxn000001";
  const mid = "m.rxn.1";
  await seedOutbound({ channel: "messenger", externalContactId: psid, mid });

  await postMetaWebhook(
    META_TEST_TEAM_ID,
    reactionWebhook({ object: "page", accountId: MSGR_PAGE_ID, senderId: psid, mid, action: "react", reaction: "love", emoji: "❤️" }),
  );
  expect(await reactionOf("messenger", mid)).toBe("❤");

  await postMetaWebhook(
    META_TEST_TEAM_ID,
    reactionWebhook({ object: "page", accountId: MSGR_PAGE_ID, senderId: psid, mid, action: "unreact" }),
  );
  expect(await reactionOf("messenger", mid)).toBeNull();
});
