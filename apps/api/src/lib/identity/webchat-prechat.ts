import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { findExistingCustomerIdByStrongKey } from "@/lib/identity/identity-service";
import { toContactWire } from "@/lib/queries/_shared";
import { workflowContactSnapshot } from "@/lib/workflows/events";
import { normalizePhoneE164 } from "@ccp/shared/utils/phone";
import type { Channel } from "@ccp/shared/types";

/**
 * Apply a website-widget pre-chat form submission to the visitor's contact.
 *
 * The pre-chat form is the widget's analogue of the social "share your phone /
 * email" consent chip (see `applyContactShareFromReply`): a visitor VOLUNTARILY
 * typed these values about themselves, so an email/phone is SELF-ASSERTED and may
 * auto-merge the visitor into an existing unified `Customer` (exact phone, or
 * exact email under `trustEmailAsStrongKey`). Name is display-only — never a key
 * (no fuzzy matching, ever — docs/identity.md).
 *
 * Best-effort, called AFTER the first inbound message has committed: a failure
 * here must never cost us the message. The customer-link drift sweeper is the
 * backstop for the `customerId` half.
 */
export async function applyWebchatPreChatIdentity(
  teamId: string,
  channel: Channel,
  contactId: string,
  fields: { name?: string | null; email?: string | null; phone?: string | null },
): Promise<void> {
  const name = fields.name?.trim() || null;
  const email = fields.email?.trim().toLowerCase() || null;
  // Store phone digits-only like every other channel (partial unique on
  // (teamId, phoneNumber) is whatsapp-scoped, so stamping it on a widget contact
  // can't collide — it's exactly the pair we want resolveCustomerId to fuse).
  const phone = fields.phone ? normalizePhoneE164(fields.phone) : null;
  if (!name && !email && !phone) return;

  const contact = await db.contact.findFirst({
    where: { id: contactId, teamId, deletedAt: null },
    select: { id: true, name: true, phoneNumber: true, email: true, customerId: true },
  });
  if (!contact) return;

  const next = {
    name: name ?? contact.name,
    phoneNumber: phone ?? contact.phoneNumber,
    email: email ?? contact.email,
  };
  // Idempotent: a re-submitted form (or a redelivered first message) must not
  // churn the row or re-run the merge.
  if (
    next.name === contact.name &&
    next.phoneNumber === contact.phoneNumber &&
    next.email === contact.email
  ) {
    return;
  }
  await db.contact.update({ where: { id: contact.id }, data: next });

  // A strong key may now adopt an EXISTING person. Use the non-minting resolver
  // (findExisting…, NOT resolveCustomerId) so a brand-new phone/email the business
  // didn't already hold doesn't mint a fresh customer and tear this contact out of
  // its own profile — the exact silent-un-merge bug documented in contact-share.ts.
  const hasStrongKey = Boolean(next.phoneNumber || next.email);
  if (hasStrongKey) {
    const adoptedCustomerId = await findExistingCustomerIdByStrongKey(
      teamId,
      { id: contact.id, name: next.name, phoneNumber: next.phoneNumber, email: next.email },
      undefined,
      { trustEmailAsStrongKey: true },
    );
    if (adoptedCustomerId && adoptedCustomerId !== contact.customerId) {
      await db.contact.update({
        where: { id: contact.id },
        data: { customerId: adoptedCustomerId },
      });
      if (contact.customerId) {
        await db.customer.deleteMany({
          where: { id: contact.customerId, teamId, contacts: { none: {} } },
        });
      }
    }
  }

  // Announce the change so the contact panel / linked-channels switcher / partner
  // webhooks refresh — same publish the PATCH route + contact-share path use.
  try {
    const fresh = await db.contact.findUnique({
      where: { id: contact.id },
      include: { tags: { select: { id: true } } },
    });
    if (fresh) {
      await publish({
        type: "contact.updated",
        teamId,
        contact: toContactWire(fresh),
        previousStageId: fresh.stageId,
        fieldChanges: [],
        changedByUserId: null,
        workflowContact: workflowContactSnapshot(fresh),
      });
    }
  } catch (err) {
    console.error(
      `[webchat-prechat] publish(contact.updated) failed for team=${teamId} contact=${contact.id}:`,
      err,
    );
  }

  console.info(
    JSON.stringify({
      event: "identity.webchat_prechat_applied",
      channel,
      contactId: contact.id,
      gotEmail: Boolean(email),
      gotPhone: Boolean(phone),
    }),
  );
}
