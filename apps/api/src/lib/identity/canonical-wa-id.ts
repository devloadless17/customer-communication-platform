import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";

/**
 * Reconcile a contact's stored phone with the CANONICAL wa_id Meta reported
 * on a delivery status (`statuses[].recipient_id`).
 *
 * WHY THIS EXISTS. Meta normalizes some regions' numbers — Brazil's mobile
 * "9", Mexico's legacy "1" — so a CSV-imported or agent-typed number can send
 * fine (Meta maps it) while the customer's REPLY arrives from a DIFFERENT
 * wa_id. Inbound keys contacts on the wa_id, so without this the reply forks
 * a second contact + second thread, the outbound history strands on the
 * first, and phone-based auto-merge never fuses them (the digits differ —
 * that's the whole problem). The service-messages doc calls the send-side
 * mapping out explicitly ("the extra added prefix … may be modified by the
 * Cloud API"); the reply-side fork is the part that hurts.
 *
 * WHAT IT DOES — vendor-verified evidence only (§6: deterministic strong
 * keys), cheapest-safe action first:
 *   - stored digits already equal the wa_id → no-op (the overwhelmingly
 *     common case; the caller's mismatch gate means we rarely get here);
 *   - no other contact holds the wa_id → RE-KEY this contact's phoneNumber to
 *     it. The thread, messages and campaign history all hang off the contact
 *     id, so nothing else moves; the WhatsApp duplicate-contact partial-unique
 *     backstop turns a lost race into a P2002, which falls through to linking;
 *   - another contact already holds the wa_id (the person messaged in
 *     organically before the import was reconciled) → LINK the two through
 *     `Customer` — adopt whichever side already has one, or mint one for both.
 *     Contacts and their threads are never mutated or merged (§6: merge never
 *     deletes; threads stay per-contact);
 *   - both sides already belong to DIFFERENT customers → log and stand down.
 *     Folding two established profiles automatically is the exact bug class
 *     two prior audits caught (silent un-merge / identity fold) — that call
 *     belongs to a human via the manual merge UI.
 *
 * Phone is deliberately re-keyed WITHOUT publishing `contact.updated`: that
 * event feeds workflow triggers and outbound webhooks, and this is an
 * identity-layer normalization, not a user edit (the edit API holds
 * phoneNumber immutable). Fail-soft by contract — the caller fires and
 * forgets; an error here must never cost a delivery receipt.
 */
export async function reconcileCanonicalWaId(
  workspaceId: string,
  contactId: string,
  rawWaId: string,
): Promise<void> {
  const waId = rawWaId.replace(/\D/g, "");
  // E.164's digit range — anything else is not a plausible identity.
  if (waId.length < 8 || waId.length > 15) return;

  const contact = await db.contact.findFirst({
    where: { id: contactId, workspaceId, identityChannel: "whatsapp", deletedAt: null },
    select: { id: true, phoneNumber: true, customerId: true, name: true },
  });
  if (!contact || !contact.phoneNumber || contact.phoneNumber === waId) return;

  // Link this contact and the wa_id's existing holder through one Customer.
  // Re-queried (not passed in) so the P2002 fallback sees the row that just
  // won the race.
  const linkToHolder = async (): Promise<void> => {
    const holder = await db.contact.findFirst({
      where: {
        workspaceId,
        identityChannel: "whatsapp",
        phoneNumber: waId,
        deletedAt: null,
        id: { not: contactId },
      },
      select: { id: true, customerId: true },
    });
    if (!holder) return; // vanished (deleted mid-flight) — the next status retries

    if (contact.customerId && holder.customerId) {
      if (contact.customerId !== holder.customerId) {
        console.warn(
          `[identity] wa_id ${waId} maps contact=${contactId} onto contact=${holder.id}, but they belong to different customers — leaving for manual merge`,
        );
      }
      return;
    }
    if (holder.customerId) {
      await db.contact.updateMany({
        where: { id: contactId, workspaceId },
        data: { customerId: holder.customerId, version: { increment: 1 } },
      });
    } else if (contact.customerId) {
      await db.contact.updateMany({
        where: { id: holder.id, workspaceId },
        data: { customerId: contact.customerId, version: { increment: 1 } },
      });
    } else {
      const customer = await db.customer.create({
        data: { workspaceId, name: contact.name },
        select: { id: true },
      });
      await db.contact.updateMany({
        where: { id: { in: [contactId, holder.id] }, workspaceId },
        data: { customerId: customer.id, version: { increment: 1 } },
      });
    }
    console.warn(
      `[identity] linked contact=${contactId} (dialed ${contact.phoneNumber}) with wa_id holder contact=${holder.id} via customer`,
    );
  };

  const holderExists = await db.contact.findFirst({
    where: {
      workspaceId,
      identityChannel: "whatsapp",
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
    await db.contact.updateMany({
      where: { id: contactId, workspaceId },
      data: { phoneNumber: waId, version: { increment: 1 } },
    });
    console.warn(
      `[identity] re-keyed contact=${contactId} phone ${contact.phoneNumber} → wa_id ${waId} (Meta-normalized recipient)`,
    );
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
}
