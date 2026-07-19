import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { toContactWire } from "@/lib/queries/_shared";
import { workflowContactSnapshot } from "@/lib/workflows/events";
import { normalizePhoneE164 } from "@ccp/shared/utils/phone";
import type { Channel } from "@ccp/shared/types";

/**
 * Apply a website-widget pre-chat form submission to the visitor's contact.
 *
 * The pre-chat form LOOKS like the social "share your phone / email" consent chip
 * (see `applyContactShareFromReply`), but it is NOT equivalent and must not be
 * treated as one: the social chip rides on a vendor-verified account, while this is
 * an unauthenticated text box on a public website. The values are STORED on the
 * contact (the agent can see and act on them) but NEVER act as a merge key in
 * either direction — see the NO-AUTO-MERGE block below, and the matching candidate
 * exclusion in `findExistingCustomerIdByStrongKey`. Name is display-only — never a
 * key (no fuzzy matching, ever — docs/identity.md).
 *
 * Landing a phone or email here DOES promote the visitor out of ephemeral status
 * into the contacts directory (`directoryContactWhere`) — that is visibility, not
 * identity, and it mints no link to any other person.
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

  // NO AUTO-MERGE from this surface — deliberately.
  //
  // §6 allows auto-merge on a strong key only when it is SELF-ASSERTED, and on
  // WhatsApp/Messenger/Instagram that means something: the vendor already verified
  // the channel identity, so the person asserting the email provably controls that
  // account. A webchat visitor is ANONYMOUS and has proven nothing — the pre-chat
  // form is an unauthenticated public text box on the client's website. Trusting it
  // as a strong key let anyone type a known customer's email or phone and have
  // their throwaway session adopted into that person's unified Customer, after
  // which the contact panel and linked-channels switcher present the stranger as
  // the verified customer. That is an impersonation vector against a surface agents
  // trust, so the values are stored on the Contact (the agent can see and act on
  // them) and merging is left to the MANUAL, reversible path — exactly the posture
  // §6 prescribes for everything that isn't a deterministic verified key.
  //
  // Re-enabling this requires verifying the address/number first (emailed or SMS'd
  // code), not loosening the check here.

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
