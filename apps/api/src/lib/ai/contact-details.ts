import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { toContactWire } from "@/lib/queries/_shared";
import { workflowContactSnapshot } from "@/lib/workflows/events";

/**
 * Filling in the contact details the assistant is missing — today, the email
 * address.
 *
 * The flow is: we notice we have no email → the prompt tells the model to ask
 * for one, once → the customer answers → we validate and store it on the
 * Contact. Each half is deliberately separate from the other, because they fail
 * differently: the ASK is a judgement call the model makes ("is this a natural
 * moment?"), while the CAPTURE must not be, so nothing the model reports is
 * trusted without re-validation here.
 *
 * What this is NOT: an identity signal. A self-typed address is stored as a
 * contact detail and never reaches IdentityService — a typo or a shared family
 * address would silently merge two people, and merges are only ever made on
 * vendor-verified keys (see docs/identity.md).
 */

/**
 * Deliberately strict, and stricter than RFC 5322 allows. This validates a
 * value a MODEL handed us, so the job is to reject anything that merely looks
 * email-shaped rather than to accept every address that could legally exist —
 * a wrong address written into the customer's profile is worse than a missed
 * one, which the next conversation picks up anyway.
 */
const EMAIL = /^[^\s@,;:<>()[\]\\"]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export interface ContactDetails {
  /** The email we already hold for this contact, if any. */
  email: string | null;
  /** Whether the assistant has already asked this thread for one. */
  emailRequested: boolean;
}

/**
 * What the prompt needs to know about this customer's details. Reads the
 * CONTACT (the channel identity that owns the conversation), not the Customer —
 * `Contact.email` is where the inbox's right-rail panel shows it.
 */
export async function loadContactDetails(
  workspaceId: string,
  conversationId: string,
): Promise<ContactDetails> {
  const conv = await db.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: { contact: { select: { email: true } } },
  });
  const state = await db.aiConversationState.findFirst({
    where: { conversationId, workspaceId },
    select: { emailRequestedAt: true },
  });
  return {
    email: conv?.contact?.email?.trim() || null,
    emailRequested: !!state?.emailRequestedAt,
  };
}

/**
 * Persist an email the customer just gave us.
 *
 * Only fills a BLANK — an address an agent typed, a CSV import set, or the
 * customer gave earlier always wins over a fresh model extraction. `updateMany`
 * with `email: null` in the where clause makes that a single conditional write
 * rather than a read-then-write that two concurrent replies could interleave.
 *
 * Returns the stored address, or null when nothing was written (no valid
 * address in the message, or the contact already had one).
 */
export async function captureCustomerEmail(
  workspaceId: string,
  conversationId: string,
  raw: string,
): Promise<string | null> {
  const email = raw.trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL.test(email)) return null;

  const conv = await db.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: { contactId: true },
  });
  if (!conv) return null;

  const res = await db.contact.updateMany({
    where: { id: conv.contactId, workspaceId, email: null },
    data: { email },
  });
  if (res.count === 0) return null;

  // Announce the change — same publish the PATCH route, the contact-share chip
  // and the webchat pre-chat form use, so the contact panel, the contacts list
  // and every subscribed partner see the address without a refetch.
  //
  // Best-effort: this runs after the assistant's reply has committed, and a
  // publish failure must never cost us the captured address.
  try {
    const fresh = await db.contact.findUnique({
      where: { id: conv.contactId },
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
      `[ai/contact-details] publish(contact.updated) failed for team=${workspaceId} contact=${conv.contactId}:`,
      err,
    );
  }
  return email;
}

/**
 * Record that the assistant asked for an email on this thread, so it never asks
 * twice. Best-effort: the reply has already been sent by the time this runs, and
 * failing to write the marker is worth at most one repeated question.
 */
export async function markEmailRequested(
  workspaceId: string,
  conversationId: string,
): Promise<void> {
  await db.aiConversationState
    .updateMany({
      where: { conversationId, workspaceId, emailRequestedAt: null },
      data: { emailRequestedAt: new Date() },
    })
    .catch(() => {});
}
