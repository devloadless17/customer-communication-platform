import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { findExistingCustomerIdByStrongKey } from "@/lib/identity/identity-service";
import { toContactWire } from "@/lib/queries/_shared";
import { workflowContactSnapshot } from "@/lib/workflows/events";
import { resolveContactShare } from "@ccp/shared/utils/contact-share";
import type { Channel } from "@ccp/shared/types";
import type { ContactShareField, InteractiveReply } from "@ccp/shared/providers/types";

/**
 * A social contact tapped a "share your phone / email" consent chip.
 *
 * This is the ONLY moment a Messenger/Instagram contact can acquire a strong
 * identity key. Until it happens they are unmergeable: `resolveCustomerId` only
 * auto-merges on exact phone/email (lib/identity/identity-service.ts — no fuzzy/name matching,
 * ever), and Meta exposes neither for social profiles. So this path is what
 * turns "an Instagram handle" into "the same person as this WhatsApp thread".
 *
 * Meta's inbound frame for a tapped chip is indistinguishable from a normal text
 * quick-reply (no `content_type` echo; the value sits in both `text` and
 * `quick_reply.payload`). We therefore never infer from the value alone — we
 * correlate against what the preceding outbound message actually offered. See
 * `resolveContactShare` for both guards.
 */

interface OfferedChips {
  contactShare: ContactShareField[];
  optionIds: string[];
}

/**
 * What the conversation's most recent OUTBOUND message offered. Only the newest
 * one counts: Meta dismisses quick replies as soon as another message arrives,
 * so an older offer can't be what the customer just tapped.
 */
async function lastOfferedChips(
  workspaceId: string,
  conversationId: string,
): Promise<OfferedChips | null> {
  const last = await db.message.findFirst({
    where: { workspaceId, conversationId, direction: "out" },
    orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    select: { rawPayload: true },
  });
  const interactive = (last?.rawPayload as { interactive?: unknown } | null)?.interactive as
    | { contactShare?: unknown; options?: Array<{ id?: unknown }> }
    | undefined;
  if (!interactive) return null;
  const contactShare = Array.isArray(interactive.contactShare)
    ? interactive.contactShare.filter(
        (f): f is ContactShareField => f === "phone" || f === "email",
      )
    : [];
  if (contactShare.length === 0) return null;
  const optionIds = Array.isArray(interactive.options)
    ? interactive.options
        .map((o) => o?.id)
        .filter((id): id is string => typeof id === "string")
    : [];
  return { contactShare, optionIds };
}

/**
 * Write a shared phone/email onto the contact and re-run identity resolution, so
 * the contact immediately folds into the right unified `Customer`.
 *
 * Returns the field written, or null when this reply wasn't a consent share (by
 * far the common case — every ordinary button tap lands here too).
 *
 * Best-effort by contract: the caller invokes this AFTER the inbound message has
 * committed, and swallows failures. Losing an identity enrichment must never
 * cost us the message itself, and the customer-link drift sweeper is the backstop
 * for the `customerId` half.
 */
export async function applyContactShareFromReply(
  workspaceId: string,
  channel: Channel,
  conversationId: string,
  contactId: string,
  reply: InteractiveReply,
): Promise<ContactShareField | null> {
  const offered = await lastOfferedChips(workspaceId, conversationId);
  if (!offered) return null;

  const share = resolveContactShare(reply.id, offered.contactShare, offered.optionIds);
  if (!share) return null;

  const contact = await db.contact.findFirst({
    where: { id: contactId, workspaceId, deletedAt: null },
    select: { id: true, name: true, phoneNumber: true, email: true, customerId: true },
  });
  if (!contact) return null;

  const next = {
    phoneNumber: share.field === "phone" ? share.value : contact.phoneNumber,
    email: share.field === "email" ? share.value : contact.email,
  };
  // Idempotent: a re-delivered webhook (or the customer tapping twice) must not
  // churn the row or re-run the merge.
  if (next.phoneNumber === contact.phoneNumber && next.email === contact.email) {
    return null;
  }

  // NOTE on uniqueness: the partial unique on (workspaceId, phoneNumber) is scoped to
  // `identityChannel = 'whatsapp'`, so stamping a phone on a messenger/instagram
  // contact can't collide with the WhatsApp contact for the same person — which
  // is precisely the pair we want `resolveCustomerId` to fuse below.
  await db.contact.update({ where: { id: contact.id }, data: next });

  // The contact just gained a strong key, so it may now belong to an EXISTING
  // person. This contact ALREADY has its own Customer, so we only want to MOVE it
  // when the new key genuinely adopts a DIFFERENT, pre-existing person — never
  // when resolution would merely mint a fresh solo Customer. Using the
  // mint-on-no-match `resolveCustomerId` here was a real bug: a shared phone/email
  // the business didn't already hold matches no sibling, mints a new customer,
  // and the `!==` check then re-points the contact onto it — tearing a
  // manually-merged contact out of its unified profile (silent un-merge) or
  // churning a solo contact's id and discarding a person-level rename. So ask the
  // "did we adopt someone?" question directly and act ONLY on a real match.
  //
  // `trustEmailAsStrongKey` is set here and ONLY here: the address arrived
  // because the customer tapped Meta's `user_email` autofill on their own
  // account, so it identifies them. An agent-typed or CSV-imported email carries
  // no such assertion and must never auto-merge two people.
  const adoptedCustomerId = await findExistingCustomerIdByStrongKey(
    workspaceId,
    {
      id: contact.id,
      name: contact.name,
      ...next,
    },
    undefined,
    { trustEmailAsStrongKey: true },
  );
  if (adoptedCustomerId && adoptedCustomerId !== contact.customerId) {
    await db.contact.update({
      where: { id: contact.id },
      data: { customerId: adoptedCustomerId },
    });
    // The customer it used to sit alone under is now childless — reap it. The
    // `contacts: none` guard makes this safe when the old customer still owns
    // other channel contacts (a real merge target), in which case we leave it.
    if (contact.customerId) {
      await db.customer.deleteMany({
        where: { id: contact.customerId, workspaceId, contacts: { none: {} } },
      });
    }
  }

  // The row just changed (a phone/email landed, possibly a cross-channel merge)
  // but nothing announced it — so an open contact panel, the linked-channels
  // switcher, the contacts list and every subscribed partner all kept showing
  // the pre-share contact until something else happened to refresh them. Publish
  // the same `contact.updated` the PATCH route does, so the existing socket
  // fanout + outbound-webhook subscriber pick it up with no new wiring.
  //
  // Best-effort: this runs inside inbound ingest, where the contract is that a
  // publish failure must never cost us the customer's message.
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
      `[contact-share] publish(contact.updated) failed for team=${workspaceId} contact=${contact.id}:`,
      err,
    );
  }

  console.info(
    JSON.stringify({
      event: "identity.contact_share_applied",
      channel,
      contactId: contact.id,
      field: share.field,
      merged: Boolean(adoptedCustomerId && adoptedCustomerId !== contact.customerId),
    }),
  );
  return share.field;
}
