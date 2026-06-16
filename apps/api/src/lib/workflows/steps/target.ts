// Note: no `server-only` import — boots from the BullMQ worker outside the
// Next.js bundler context, same as the other step helpers.

import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { normalizePhoneE164 } from "@ccp/shared/utils/phone";

import type { WorkflowEventEnvelope } from "@/lib/workflows/events";

import {
  StepConfigError,
  envelopeContact,
  envelopeConversation,
} from "./types";

/**
 * What contact / conversation does this step act on?
 *
 *   trigger_contact — the contact (and conversation, if any) the trigger
 *                     fired for. Existing behavior — default.
 *   phone           — an arbitrary phone number. Auto-creates the Contact
 *                     if it doesn't exist yet; for `send_message`, also
 *                     auto-creates an `open` Conversation.
 *
 * `kind: "contact"` (pick an existing contact by id) is intentionally NOT
 * here yet — would need a typeahead picker in the UI, which is a bigger
 * piece. Adding it later is a non-breaking extension.
 */
export type StepTarget =
  | { kind: "trigger_contact" }
  | { kind: "phone"; phoneNumber: string };

/**
 * Parser shared across step parseConfig functions. Returns undefined when
 * `raw` is missing (the default — trigger_contact). Throws StepConfigError
 * on a malformed payload so the validator surfaces a useful message to
 * the workflow author.
 */
export function parseStepTarget(raw: unknown): StepTarget | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") {
    throw new StepConfigError("target must be an object");
  }
  const t = raw as Record<string, unknown>;
  if (t.kind === "trigger_contact") return { kind: "trigger_contact" };
  if (t.kind === "phone") {
    if (typeof t.phoneNumber !== "string" || !t.phoneNumber.trim()) {
      throw new StepConfigError("target.phoneNumber is required when target.kind is 'phone'");
    }
    const normalized = normalizePhoneE164(t.phoneNumber);
    if (!normalized) {
      throw new StepConfigError(
        "target.phoneNumber must be a valid international number (e.g. +1 555 555 0100)",
      );
    }
    return { kind: "phone", phoneNumber: normalized };
  }
  throw new StepConfigError(`target.kind must be 'trigger_contact' or 'phone'`);
}

export interface ResolvedTarget {
  contactId: string;
  /** Null when the target is a contact with no conversation yet AND the
   *  caller hasn't asked us to create one (passed `createConversation: false`). */
  conversationId: string | null;
  /** Normalized E.164 number on the resolved contact, when we know it. */
  phoneNumber: string | null;
  /** Whether the contact / conversation was created during this resolve.
   *  Currently only informational — useful for logging in tests. */
  contactCreated: boolean;
  conversationCreated: boolean;
}

/**
 * Resolve a step target at run time. Side effects:
 *
 *   - phone target with unknown number → INSERTs a Contact (source=manual,
 *     name=phoneNumber). We use `manual` because the existing ContactSource
 *     enum doesn't have a `workflow` value — adding one is a one-line
 *     migration we deferred for now. "manual" semantically means "we added
 *     them on our end" which fits a workflow auto-create.
 *
 *   - phone target with no open conversation AND `createConversation` true
 *     → INSERTs a Conversation in 'open' status. Skipped when the caller
 *     only needs to mutate the Contact (update_lifecycle / tags / fields).
 *
 * The find-or-create is single-trip Prisma upserts under a unique key
 * (teamId, phoneNumber), so concurrent workflow runs for the same target
 * phone collapse to one Contact row. Race-safe.
 */
export async function resolveStepTarget(
  target: StepTarget | undefined,
  envelope: WorkflowEventEnvelope,
  teamId: string,
  opts: { createConversation: boolean },
): Promise<ResolvedTarget> {
  // Default: trigger contact + conversation from the envelope (existing
  // behavior). Returns the snapshot ids verbatim; the caller is
  // responsible for surfacing "no conversation" via advanceWithError when
  // the trigger doesn't carry one.
  if (!target || target.kind === "trigger_contact") {
    const c = envelopeContact(envelope);
    const conv = envelopeConversation(envelope);
    if (!c) {
      throw new StepConfigError(
        "step targets the trigger contact but the envelope has none",
      );
    }
    return {
      contactId: c.id,
      conversationId: conv?.id ?? null,
      phoneNumber: c.phoneNumber ?? null,
      contactCreated: false,
      conversationCreated: false,
    };
  }

  // Phone target — find or create the Contact, then the Conversation.
  const phone = target.phoneNumber; // already normalized in parseStepTarget
  // `deletedAt: null` so we never target a SOFT-DELETED ghost (the user removed
  // them on purpose) — identity-model-added-1. A soft-deleted contact still
  // holds the (teamId, phoneNumber) unique slot, so the create below will P2002
  // and the revive branch handles it.
  const existingContact = await db.contact.findFirst({
    where: { teamId, phoneNumber: phone, deletedAt: null },
    select: { id: true },
  });
  let contactId: string;
  let contactCreated = false;
  if (existingContact) {
    contactId = existingContact.id;
  } else {
    try {
      const created = await db.contact.create({
        data: {
          teamId,
          // Workflow target with a phone number = WhatsApp by definition
          // today. Stamped explicitly because identityChannel is NOT NULL.
          identityChannel: "whatsapp",
          phoneNumber: phone,
          // Use the phone number as the placeholder name. The contact owner
          // can rename later via the contact panel. Better than "Unknown"
          // because it gives the agent something identifying in the inbox
          // list before any real name is captured.
          name: phone,
          source: "manual",
        },
        select: { id: true },
      });
      contactId = created.id;
      contactCreated = true;
    } catch (err) {
      // Lost the (teamId, phoneNumber) unique — either a CONCURRENT workflow
      // run created the contact, or the slot is held by a SOFT-DELETED ghost.
      // Re-find including deleted; revive a ghost (mirrors inbound ingest) so
      // the workflow targets a live contact instead of throwing (CTI-1).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const slotHolder = await db.contact.findFirstOrThrow({
          where: { teamId, phoneNumber: phone },
          select: { id: true, deletedAt: true },
        });
        if (slotHolder.deletedAt) {
          await db.contact.update({
            where: { id: slotHolder.id },
            data: { deletedAt: null, source: "manual" },
          });
          // A revived ghost is a fresh directory appearance for downstream.
          contactCreated = true;
        }
        contactId = slotHolder.id;
      } else throw err;
    }
  }

  if (!opts.createConversation) {
    return {
      contactId,
      conversationId: null,
      phoneNumber: phone,
      contactCreated,
      conversationCreated: false,
    };
  }

  // Find the most recent conversation (open OR closed) and reopen it if
  // closed — mirrors what the inbound webhook ingest does. Multiple
  // workflows hitting the same phone in parallel collapse onto the same
  // row because `(teamId, contactId)` reads return the same id.
  const existingConv = await db.conversation.findFirst({
    where: { teamId, contactId },
    // One conversation per (teamId, contactId), so this returns the single row;
    // order by lastMessageAt to match the codebase convention (ingest, list,
    // /v1) rather than createdAt (CTI-4).
    orderBy: { lastMessageAt: "desc" },
    select: { id: true },
  });
  if (existingConv) {
    return {
      contactId,
      conversationId: existingConv.id,
      phoneNumber: phone,
      contactCreated,
      conversationCreated: false,
    };
  }
  let newConv: { id: string };
  try {
    newConv = await db.conversation.create({
      data: { teamId, contactId, status: "open" },
      select: { id: true },
    });
  } catch (err) {
    // Lost the race for this contact's single conversation (unique
    // [teamId, contactId]) to a concurrent path — reuse the winner.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      newConv = await db.conversation.findFirstOrThrow({
        where: { teamId, contactId },
        orderBy: { lastMessageAt: "desc" },
        select: { id: true },
      });
    } else throw err;
  }
  return {
    contactId,
    conversationId: newConv.id,
    phoneNumber: phone,
    contactCreated,
    conversationCreated: true,
  };
}
