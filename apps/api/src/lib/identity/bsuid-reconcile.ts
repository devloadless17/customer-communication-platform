import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { findExistingCustomerIdByStrongKey } from "@/lib/identity/identity-service";
import { TtlCache } from "@/lib/providers/config-cache";
import { toContactWire } from "@/lib/queries/_shared";
import { workflowContactSnapshot } from "@/lib/workflows/events";
import { getCountryFromPhone } from "@ccp/shared/utils";
import type { Channel } from "@ccp/shared/types";

/**
 * BSUID identity repair — the sibling of `canonical-wa-id.ts` for Meta's 2026
 * business-scoped-user-id rollout.
 *
 * WHY THIS EXISTS. A BSUID is unique per (business PORTFOLIO, user), and Meta
 * omits `wa_id` for contacts not messaged in the last 30 days — so a returning
 * customer can arrive as a bare BSUID, ingest finds no contact under either
 * key, and the person forks into a second contact + second thread (the
 * duplicate-thread fork Meta's own docs warn about). The ONLY join opportunity
 * is a webhook carrying BOTH keys inside the 30-day overlap window. These
 * helpers spend that opportunity:
 *
 *   - {@link reconcileBsuidFork} — a dual-key webhook resolved by phone, but a
 *     DIFFERENT contact already holds the BSUID (the cold fork). Re-key the
 *     BSUID trio onto the phone-bearing contact and link both through one
 *     `Customer` — a BSUID is vendor-issued and exact, i.e. a legitimate
 *     deterministic strong key (§6). Threads are NEVER merged.
 *   - {@link backfillBsuidFromStatus} — `statuses[].recipient_user_id` arrives
 *     on EVERY delivery status once the rollout reaches the account, so every
 *     outbound teaches an active thread its BSUID BEFORE the 30-day window can
 *     close.
 *   - {@link applyContactRequestPhone} — the customer answered our
 *     REQUEST_CONTACT_INFO button with their own number, and Meta resolved it
 *     to a `wa_id`. Same trust level as the contact-share chip (self-asserted
 *     through an explicit consent flow), so it may fill a NULL phone and drive
 *     strong-key Customer adoption.
 *
 * All entry points are fail-soft by contract — callers fire and forget from
 * ingest, and an identity enrichment must never cost us a message or a
 * delivery receipt.
 */

/**
 * Which `WhatsappPortfolio` issued the BSUIDs a connection's webhooks carry:
 * connection → WABA → portfolio. Cached process-local like the provider config
 * loaders (the chain is effectively static; ingest asks on every BSUID write).
 * Null when any link is unknown — `Contact.bsuidPortfolioId` stays null rather
 * than guessing, and the send-side portfolio guard treats null as compatible.
 */
const portfolioCache = new TtlCache<string | null>(5 * 60_000);

export async function resolveConnectionPortfolioId(
  workspaceId: string,
  channelConnectionId: string,
): Promise<string | null> {
  const key = `${workspaceId}::${channelConnectionId}`;
  const hit = portfolioCache.get(key);
  if (hit !== undefined) return hit;
  const connection = await db.channelConnection.findFirst({
    where: { id: channelConnectionId, workspaceId },
    select: { wabaAccount: { select: { portfolioId: true } } },
  });
  const portfolioId = connection?.wabaAccount?.portfolioId ?? null;
  portfolioCache.set(key, portfolioId);
  return portfolioId;
}

/**
 * Link two contacts through one `Customer` — adopt whichever side already has
 * one, or mint one for both. Same branch ladder as `canonical-wa-id.ts`'s
 * linkToHolder: when both sides already belong to DIFFERENT customers, stand
 * down and log — folding two established profiles automatically is the exact
 * bug class two prior audits caught; that call belongs to a human via the
 * manual merge UI. Contacts and their threads are never mutated or merged.
 */
async function linkContactsViaCustomer(
  workspaceId: string,
  primary: { id: string; customerId: string | null; name: string },
  secondary: { id: string; customerId: string | null },
  reason: string,
): Promise<void> {
  if (primary.customerId && secondary.customerId) {
    if (primary.customerId !== secondary.customerId) {
      console.warn(
        `[identity] ${reason} maps contact=${primary.id} onto contact=${secondary.id}, but they belong to different customers — leaving for manual merge`,
      );
    }
    return;
  }
  if (secondary.customerId) {
    await db.contact.updateMany({
      where: { id: primary.id, workspaceId },
      data: { customerId: secondary.customerId, version: { increment: 1 } },
    });
  } else if (primary.customerId) {
    await db.contact.updateMany({
      where: { id: secondary.id, workspaceId },
      data: { customerId: primary.customerId, version: { increment: 1 } },
    });
  } else {
    const customer = await db.customer.create({
      data: { workspaceId, name: primary.name },
      select: { id: true },
    });
    await db.contact.updateMany({
      where: { id: { in: [primary.id, secondary.id] }, workspaceId },
      data: { customerId: customer.id, version: { increment: 1 } },
    });
  }
  console.warn(
    `[identity] linked contact=${primary.id} with contact=${secondary.id} via customer (${reason})`,
  );
}

/**
 * Heal the cold fork: a webhook carried BOTH phone and BSUID, the phone lookup
 * won (phone is the canonical key), but a DIFFERENT contact — created from a
 * bare-BSUID inbound outside the 30-day window — already holds that BSUID.
 *
 * What it does, cheapest-safe action first:
 *   - no other contact holds the BSUID → no-op (the overwhelmingly common
 *     case; tx1's fill-a-NULL backfill already stamped it on the resolved
 *     contact);
 *   - a fork exists → move the BSUID trio (bsuid, parentBsuid,
 *     bsuidPortfolioId) onto the phone-bearing contact — but ONLY when it
 *     holds no bsuid or already holds this one. A different stored bsuid is
 *     usually a sibling portfolio's id for the same person; overwriting it
 *     would discard a valid key, so we leave keys alone and still link;
 *   - null the trio on the fork so the next bsuid-keyed webhook resolves to
 *     the surviving key-holder, then link BOTH contacts through one Customer
 *     (BSUID = vendor-issued + exact ⇒ deterministic strong key, §6).
 *
 * Fail-soft by contract — the caller fires and forgets; a redelivery of any
 * dual-key webhook retries the whole reconcile idempotently.
 */
export async function reconcileBsuidFork(
  workspaceId: string,
  channel: Channel,
  contactId: string,
  evt: {
    bsuid: string;
    parentBsuid: string | null;
    /** The connection the webhook arrived on — the portfolio-stamp source. */
    channelConnectionId: string | null;
  },
): Promise<void> {
  const contact = await db.contact.findFirst({
    where: { id: contactId, workspaceId, identityChannel: channel, deletedAt: null },
    select: { id: true, name: true, bsuid: true, parentBsuid: true, customerId: true },
  });
  if (!contact) return;

  const fork = await db.contact.findFirst({
    where: {
      workspaceId,
      identityChannel: channel,
      bsuid: evt.bsuid,
      deletedAt: null,
      id: { not: contactId },
    },
    select: { id: true, customerId: true },
  });
  if (!fork) return; // no cold fork — the overwhelmingly common case

  // Stamp the winner BEFORE nulling the fork, so the BSUID stays resolvable
  // throughout (a crash between the writes leaves both holding it, which the
  // next dual-key webhook re-heals; a window where NOBODY holds it would let a
  // concurrent bare-BSUID inbound fork a THIRD contact).
  const winnerTakesKey = !contact.bsuid || contact.bsuid === evt.bsuid;
  if (winnerTakesKey) {
    const portfolioId = evt.channelConnectionId
      ? await resolveConnectionPortfolioId(workspaceId, evt.channelConnectionId)
      : null;
    await db.contact.updateMany({
      where: { id: contactId, workspaceId },
      data: {
        bsuid: evt.bsuid,
        ...(evt.parentBsuid && !contact.parentBsuid ? { parentBsuid: evt.parentBsuid } : {}),
        ...(portfolioId ? { bsuidPortfolioId: portfolioId } : {}),
        version: { increment: 1 },
      },
    });
    // Only now may the fork release the key — the winner holds it, so a
    // concurrent bare-BSUID inbound still resolves. When the winner kept a
    // DIFFERENT bsuid (a sibling portfolio's key), the fork stays the holder
    // of this one: nulling it would leave the id resolvable by NOBODY and a
    // later bare-BSUID inbound would mint a THIRD contact. The Customer link
    // below unifies the person either way.
    await db.contact.updateMany({
      where: { id: fork.id, workspaceId },
      data: {
        bsuid: null,
        parentBsuid: null,
        bsuidPortfolioId: null,
        version: { increment: 1 },
      },
    });
  }

  await linkContactsViaCustomer(
    workspaceId,
    { id: contact.id, customerId: contact.customerId, name: contact.name },
    fork,
    `bsuid ${evt.bsuid}`,
  );
}

/**
 * Apply the BSUID a delivery status reported (`statuses[].recipient_user_id`)
 * to the message's contact. The highest-value capture point: it fires on every
 * outbound to an active thread, so the contact learns its BSUID long before
 * the 30-day wa_id window can close.
 *
 * Ladder:
 *   - contact holds no bsuid → fill the trio (bsuid + fill-a-NULL parentBsuid
 *     + portfolio stamp from the SENDING connection — the account whose
 *     portfolio issued this id);
 *   - same bsuid → fill-a-NULL the satellites only (idempotent redelivery);
 *   - DIFFERENT stored bsuid → overwrite ONLY when the stored
 *     `bsuidPortfolioId` equals the sending connection's portfolio. Same
 *     portfolio + new id = Meta REGENERATED it (number change we missed);
 *     anything else — different portfolio, or either side unknown — is most
 *     likely a sibling portfolio's id for the same person, so store nothing
 *     rather than corrupt a valid key.
 */
export async function backfillBsuidFromStatus(
  workspaceId: string,
  contactId: string,
  evt: {
    bsuid: string;
    parentBsuid: string | null;
    /** The connection the send went OUT on (the message's stamp). */
    sendingConnectionId: string | null;
  },
): Promise<void> {
  const contact = await db.contact.findFirst({
    where: { id: contactId, workspaceId, deletedAt: null },
    select: { bsuid: true, parentBsuid: true, bsuidPortfolioId: true },
  });
  if (!contact) return;

  const portfolioId = evt.sendingConnectionId
    ? await resolveConnectionPortfolioId(workspaceId, evt.sendingConnectionId)
    : null;

  if (!contact.bsuid) {
    // Pin `bsuid: null` so a concurrent inbound's backfill can't be clobbered.
    await db.contact.updateMany({
      where: { id: contactId, workspaceId, bsuid: null },
      data: {
        bsuid: evt.bsuid,
        ...(evt.parentBsuid && !contact.parentBsuid ? { parentBsuid: evt.parentBsuid } : {}),
        ...(portfolioId ? { bsuidPortfolioId: portfolioId } : {}),
        version: { increment: 1 },
      },
    });
    return;
  }

  if (contact.bsuid === evt.bsuid) {
    const fill = {
      ...(evt.parentBsuid && !contact.parentBsuid ? { parentBsuid: evt.parentBsuid } : {}),
      ...(portfolioId && !contact.bsuidPortfolioId ? { bsuidPortfolioId: portfolioId } : {}),
    };
    if (Object.keys(fill).length === 0) return;
    await db.contact.updateMany({
      where: { id: contactId, workspaceId },
      data: { ...fill, version: { increment: 1 } },
    });
    return;
  }

  // Different stored bsuid — regeneration only when the portfolios PROVABLY
  // match; a null on either side is "unknown", not "same".
  if (portfolioId && contact.bsuidPortfolioId === portfolioId) {
    await db.contact.updateMany({
      // Pin the stored bsuid so we only replace the value we reasoned about.
      where: { id: contactId, workspaceId, bsuid: contact.bsuid },
      data: {
        bsuid: evt.bsuid,
        // The event's parent (when present) supersedes the stored one — a
        // regeneration means our stored pairing is stale.
        ...(evt.parentBsuid ? { parentBsuid: evt.parentBsuid } : {}),
        bsuidPortfolioId: portfolioId,
        version: { increment: 1 },
      },
    });
    console.warn(
      `[identity] contact=${contactId} bsuid regenerated within portfolio=${portfolioId} — replaced from delivery status`,
    );
  }
}

/**
 * The customer answered our REQUEST_CONTACT_INFO button by sharing THEIR OWN
 * number, and Meta resolved it to a wa_id (`contacts[].phones[].wa_id` with
 * card `origin: "contact_request"`). That resolution carries the same trust as
 * the contact-share chip's `user_email` autofill — Meta's own verification of
 * the person's identity — so it may become a strong key (§6). Forwarded vCards
 * (`origin: "other"`/absent) never reach here: someone ELSE's number is not
 * this contact's identity.
 *
 * Cheapest-safe action first, mirroring `canonical-wa-id.ts`:
 *   - contact already has a phone → no-op, NEVER overwrite (the stored phone
 *     is the vendor-verified channel identity; a shared card can't demote it);
 *   - another contact already holds the wa_id → do NOT fill (the partial
 *     unique would reject it anyway) — link the two through one Customer;
 *   - otherwise fill the NULL phone (+ derive the country — phone-derived
 *     always wins over a profile-asserted country) and run adopt-only
 *     strong-key Customer resolution, reaping the now-childless solo Customer
 *     exactly like `applyContactShareFromReply`.
 */
export async function applyContactRequestPhone(
  workspaceId: string,
  channel: Channel,
  contactId: string,
  rawWaId: string,
): Promise<void> {
  const waId = rawWaId.replace(/\D/g, "");
  // E.164's digit range — anything else is not a plausible identity.
  if (waId.length < 8 || waId.length > 15) return;

  const contact = await db.contact.findFirst({
    where: { id: contactId, workspaceId, identityChannel: channel, deletedAt: null },
    select: { id: true, name: true, phoneNumber: true, customerId: true },
  });
  if (!contact || contact.phoneNumber) return;

  // Re-queried (not passed in) so the P2002 fallback sees the row that just
  // won the race.
  const linkToHolder = async (): Promise<void> => {
    const holder = await db.contact.findFirst({
      where: {
        workspaceId,
        identityChannel: channel,
        phoneNumber: waId,
        deletedAt: null,
        id: { not: contactId },
      },
      select: { id: true, customerId: true },
    });
    if (!holder) return; // vanished (deleted mid-flight) — safe no-op
    await linkContactsViaCustomer(
      workspaceId,
      { id: contact.id, customerId: contact.customerId, name: contact.name },
      holder,
      `contact_request wa_id ${waId}`,
    );
  };

  const holderExists = await db.contact.findFirst({
    where: {
      workspaceId,
      identityChannel: channel,
      phoneNumber: waId,
      deletedAt: null,
      id: { not: contactId },
    },
    select: { id: true },
  });
  if (holderExists) {
    await linkToHolder();
    return;
  }

  try {
    const country = getCountryFromPhone(waId);
    const filled = await db.contact.updateMany({
      // Pin `phoneNumber: null` — a concurrent webhook (or agent edit) that
      // already landed a phone wins; this share must not overwrite it.
      where: { id: contactId, workspaceId, phoneNumber: null },
      data: {
        phoneNumber: waId,
        ...(country ? { countryCode: country } : {}),
        version: { increment: 1 },
      },
    });
    if (filled.count === 0) return;
  } catch (err) {
    // The duplicate-contact partial-unique backstop fired: a concurrent
    // inbound created the wa_id's contact between our check and write. That
    // row is exactly who we wanted to link to.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      await linkToHolder();
      return;
    }
    throw err;
  }

  // The contact just gained a strong key — adopt-only, exactly like
  // `applyContactShareFromReply`: move onto an EXISTING person only, never
  // churn onto a freshly-minted solo Customer (that tears a manual merge
  // apart). Reap the old solo Customer when it's now childless.
  const adoptedCustomerId = await findExistingCustomerIdByStrongKey(workspaceId, {
    id: contact.id,
    name: contact.name,
    phoneNumber: waId,
    email: null,
  });
  if (adoptedCustomerId && adoptedCustomerId !== contact.customerId) {
    await db.contact.updateMany({
      where: { id: contact.id, workspaceId },
      data: { customerId: adoptedCustomerId, version: { increment: 1 } },
    });
    if (contact.customerId) {
      await db.customer.deleteMany({
        where: { id: contact.customerId, workspaceId, contacts: { none: {} } },
      });
    }
  }

  // A phone landing on a phone-less contact changes the composer, the panel
  // and the directory (a BSUID-only contact just became a directory member) —
  // publish the same `contact.updated` the PATCH route does so the existing
  // socket fanout + webhook subscriber pick it up. Best-effort: this runs
  // post-commit inside inbound ingest, where a publish failure must never
  // cost the customer's message.
  try {
    const fresh = await db.contact.findUnique({
      where: { id: contact.id },
      include: { tags: { select: { id: true } } },
    });
    if (fresh) {
      await publish({
        type: "contact.updated",
        workspaceId,
        contact: toContactWire(fresh),
        previousStageId: fresh.stageId,
        fieldChanges: [],
        changedByUserId: null,
        workflowContact: workflowContactSnapshot(fresh),
      });
    }
  } catch (err) {
    console.error(
      `[identity] publish(contact.updated) failed after contact_request fill for team=${workspaceId} contact=${contact.id}:`,
      err,
    );
  }

  console.info(
    JSON.stringify({
      event: "identity.contact_request_phone_applied",
      channel,
      contactId: contact.id,
    }),
  );
}
