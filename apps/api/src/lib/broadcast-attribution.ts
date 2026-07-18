/**
 * Post-commit enrichment for an inbound customer message: credit it to a recent
 * campaign (reply / button click) and honour an opt-out keyword.
 *
 * Runs AFTER the inbound transaction, fire-and-forget, mirroring
 * `applyContactShareFromReply`. The inbound tx already carries the message
 * insert, unread bump, conversation summary, workflow snapshot and awaiting-
 * reply consumption — it is the hottest transaction in the product, and a
 * reporting field must never lengthen it or be able to fail it.
 */

import { db } from "@/lib/db";

/**
 * How long after a campaign message an inbound still counts as a reply to it.
 *
 * 72h by default: marketing broadcasts land at all hours and people read
 * WhatsApp in bursts, so a 24h window badly under-counts a Friday-evening send,
 * while a week starts crediting genuinely organic inbound to the campaign.
 *
 * Env-tunable but deliberately NOT per-campaign — a per-campaign window makes
 * reply rates incomparable between campaigns, which destroys the main use of the
 * number. Changing it does not rewrite history: attribution is stamped when it
 * happens, so past rows keep the window they were judged under.
 */
function attributionWindowMs(): number {
  const raw = Number.parseInt(process.env.BROADCAST_REPLY_ATTRIBUTION_HOURS ?? "72", 10);
  const hours = Number.isFinite(raw) && raw >= 1 && raw <= 168 ? raw : 72;
  return hours * 60 * 60 * 1000;
}

/**
 * Opt-out keywords, matched against the WHOLE normalized message body only.
 *
 * NEVER substring-match this list. "Please stop sending the wrong size" and
 * "I'll stop by tomorrow" must not unsubscribe anyone — a false positive here
 * silently destroys a marketing list and is unrecoverable without a backup.
 * That risk is why this is a module constant rather than an env var: a typo in
 * an env var is a list-destroying event.
 *
 * Arabic variants included because the deployment is Arabic-speaking.
 */
const STOP_KEYWORDS = new Set([
  "stop",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
  "الغاء",
  "إلغاء",
  "توقف",
  "ايقاف",
  "إيقاف",
]);

/** True only when the entire message is an opt-out keyword. */
export function isOptOutKeyword(body: string | null | undefined): boolean {
  if (!body) return false;
  const normalized = body
    .trim()
    .toLowerCase()
    // Trailing punctuation only — "STOP." and "stop!" are still opt-outs.
    .replace(/[.!،,]+$/u, "")
    .trim();
  if (normalized.length === 0) return false;
  return STOP_KEYWORDS.has(normalized);
}

interface InboundContext {
  teamId: string;
  contactId: string;
  messageId: string;
  body: string | null;
  timestamp: Date;
  /** Our message the customer explicitly quoted, if any. */
  replyToMessageId?: string | null;
  /** Structured button/list tap, when the inbound was a template button. */
  interactiveOptionId?: string | null;
}

/**
 * Credit an inbound message to a campaign and apply an opt-out if the body is
 * an unsubscribe keyword. Safe to call for every inbound: it costs one indexed
 * probe and returns immediately when the contact isn't in a recent campaign.
 */
export async function attributeInboundToBroadcast(ctx: InboundContext): Promise<void> {
  // Opt-out first — it must apply even when the contact was never in a campaign.
  if (isOptOutKeyword(ctx.body)) {
    await applyOptOut(ctx.teamId, ctx.contactId, "stop_keyword", ctx.timestamp);
  }

  const recipientId = await resolveAttributedRecipient(ctx);
  if (!recipientId) return;

  // CAS on `repliedAt: null` → FIRST reply wins. This counts unique recipients
  // who replied, not messages; the report labels it "recipients who replied" so
  // the denominator is honest.
  await db.broadcastRecipient.updateMany({
    where: { id: recipientId, repliedAt: null },
    data: {
      repliedAt: ctx.timestamp,
      repliedMessageId: ctx.messageId,
      repliedAttribution: ctx.replyToMessageId ? "direct" : "window",
      ...(ctx.interactiveOptionId
        ? { clickedAt: ctx.timestamp, clickedOptionId: ctx.interactiveOptionId }
        : {}),
      ...(isOptOutKeyword(ctx.body) ? { optedOutAt: ctx.timestamp } : {}),
    },
  });
}

/**
 * Which campaign gets the credit.
 *
 *  1. DIRECT — the customer used WhatsApp's quote-reply on our campaign
 *     message. Exact, unambiguous, and always wins.
 *  2. WINDOW — otherwise the most recent campaign this contact was SENT inside
 *     the attribution window that hasn't already been credited a reply.
 *     Last-touch: explainable in one sentence, deterministic, and it never
 *     double-credits. We deliberately do NOT try to disambiguate by matching
 *     message content — the codebase holds the same line for identity ("no
 *     fuzzy matching, ever") and a wrong guess here is worse than an honest
 *     "attributed by time window" label on the report.
 */
async function resolveAttributedRecipient(ctx: InboundContext): Promise<string | null> {
  if (ctx.replyToMessageId) {
    const quoted = await db.message.findUnique({
      where: { id: ctx.replyToMessageId },
      select: { broadcastId: true },
    });
    if (quoted?.broadcastId) {
      const direct = await db.broadcastRecipient.findUnique({
        where: {
          broadcastId_contactId: { broadcastId: quoted.broadcastId, contactId: ctx.contactId },
        },
        select: { id: true },
      });
      if (direct) return direct.id;
    }
  }

  // Note the absence of a teamId filter: BroadcastRecipient has no teamId of its
  // own (it is scoped through Broadcast), and `contactId` here came from a row
  // this team's own ingest path just committed — so tenancy holds transitively,
  // the same way every other recipient query in the codebase works.
  const cutoff = new Date(ctx.timestamp.getTime() - attributionWindowMs());
  const recent = await db.broadcastRecipient.findFirst({
    where: {
      contactId: ctx.contactId,
      sentAt: { gte: cutoff, lte: ctx.timestamp },
      repliedAt: null,
      // Only a message that actually reached Meta can earn a reply.
      deliveryState: { in: ["sent", "delivered", "read"] },
    },
    orderBy: { sentAt: "desc" },
    select: { id: true },
  });
  return recent?.id ?? null;
}

/**
 * Record a marketing opt-out. Idempotent: the first opt-out timestamp is kept,
 * so a customer sending STOP twice doesn't churn the row or move the date the
 * report groups by.
 */
export async function applyOptOut(
  teamId: string,
  contactId: string,
  source: "stop_keyword" | "meta_preferences" | "agent" | "api",
  at: Date,
): Promise<void> {
  await db.contact.updateMany({
    where: { id: contactId, teamId, marketingOptOutAt: null },
    data: { marketingOptOutAt: at, marketingOptOutSource: source },
  });
}

/**
 * Clear a marketing opt-out. ONLY Meta's `user_preferences` webhook may do this
 * (its `resume` value) — an inbound keyword can opt a customer OUT but must
 * never opt them back IN, because consent has to be affirmative.
 */
export async function clearOptOut(teamId: string, contactId: string): Promise<void> {
  await db.contact.updateMany({
    where: { id: contactId, teamId },
    data: { marketingOptOutAt: null, marketingOptOutSource: null },
  });
}
