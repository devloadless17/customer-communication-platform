// Note: no `server-only` import — boots from the BullMQ worker outside the
// Next.js bundler context, same as the other step helpers.

import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { resolveOutboundAccountId } from "@/lib/conversations/account";
import { normalizePhoneE164 } from "@ccp/shared/utils/phone";
import { bestChannelForCustomer } from "@/lib/identity/best-channel";
import { teamConnectedChannels } from "@/lib/providers";
import { isPhoneChannel } from "@ccp/shared/providers/capabilities";

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
 *   customer        — the unified PERSON (a `Customer` id). Resolves to that
 *                     person's BEST channel (`bestChannelForCustomer`: in-window
 *                     first, then most-recently-active) so an omnichannel
 *                     automation reaches them on whatever channel is live —
 *                     WhatsApp, Messenger, or Instagram — instead of being
 *                     hardcoded to one. For `send_message`, reopens/creates the
 *                     conversation ON THAT CHANNEL.
 *
 *   trigger_customer — the DYNAMIC omnichannel target: the PERSON behind the
 *                     TRIGGER contact, reached on their best live channel. Same
 *                     resolution as `customer` but the customerId comes from the
 *                     trigger contact at run time (no id to configure) — so an
 *                     automation "reach this person, best channel" needs no
 *                     picker. A trigger contact with no linked person (solo)
 *                     falls back to `trigger_contact` (their own channel).
 *
 * `kind: "contact"` (pick an existing contact by id) is intentionally NOT
 * here yet — would need a typeahead picker in the UI, which is a bigger
 * piece. Adding it later is a non-breaking extension.
 */
export type StepTarget =
  | { kind: "trigger_contact" }
  | { kind: "phone"; phoneNumber: string }
  | { kind: "customer"; customerId: string }
  | { kind: "trigger_customer" };

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
  if (t.kind === "trigger_customer") return { kind: "trigger_customer" };
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
  if (t.kind === "customer") {
    if (typeof t.customerId !== "string" || !t.customerId.trim()) {
      throw new StepConfigError("target.customerId is required when target.kind is 'customer'");
    }
    return { kind: "customer", customerId: t.customerId.trim() };
  }
  throw new StepConfigError(
    `target.kind must be 'trigger_contact', 'trigger_customer', 'phone', or 'customer'`,
  );
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
 * (workspaceId, phoneNumber), so concurrent workflow runs for the same target
 * phone collapse to one Contact row. Race-safe.
 */
/**
 * Resolve a PERSON (`Customer`) to their best live channel + that channel's
 * conversation. Shared by the `customer` (static id) and `trigger_customer`
 * (dynamic, from the trigger) targets. No contact auto-create — the person's
 * contacts already exist; a person with no reachable channel throws a clean
 * config error the run records and advances past.
 */
async function resolveCustomerBestChannel(
  workspaceId: string,
  customerId: string,
  opts: {
    createConversation: boolean;
    /**
     * Which account a NEWLY created conversation binds to.
     *
     * A workflow-opened thread is outbound-first: there is no webhook to learn
     * the account from, so without this it always took the channel DEFAULT.
     * That is a sensible fallback but a poor rule — an automation that greets
     * new leads from the Support number, because Support happens to be the
     * default, is not what anyone configured. Undefined keeps the old
     * behaviour exactly.
     */
    accountId?: string | null;
  },
): Promise<ResolvedTarget> {
  // Rank only over the channels the team can actually send on right now — else a
  // person reachable on a connected channel could be picked onto an unconnected
  // one (deleted connection / expired token) and then dropped at send, reaching
  // nobody. Mirrors the broadcast customer-mode path.
  const connected = await teamConnectedChannels(workspaceId);
  const best = await bestChannelForCustomer(workspaceId, customerId, Date.now(), connected);
  if (!best) {
    throw new StepConfigError(
      "target customer has no reachable channel (no live contact to message)",
    );
  }
  const contactId = best.contactId;
  const phoneNumber = isPhoneChannel(best.channel) ? best.to : null;
  if (!opts.createConversation) {
    return {
      contactId,
      conversationId: null,
      phoneNumber,
      contactCreated: false,
      conversationCreated: false,
    };
  }
  const existingConv = await db.conversation.findFirst({
    where: { workspaceId, contactId },
    orderBy: { lastMessageAt: "desc" },
    select: { id: true },
  });
  if (existingConv) {
    return {
      contactId,
      conversationId: existingConv.id,
      phoneNumber,
      contactCreated: false,
      conversationCreated: false,
    };
  }
  // Create ON THE BEST CHANNEL — Conversation.channel defaults to whatsapp, so
  // a social best-channel MUST set it explicitly or the thread would be
  // mis-stamped. Race-safe on the (workspaceId, contactId) unique.
  let conv: { id: string };
  try {
    conv = await db.conversation.create({
      data: {
        workspaceId,
        contactId,
        channel: best.channel,
        // Bind the account too — a workflow-opened thread is outbound-first, so
        // there is no webhook to learn it from, and an unbound thread cannot
        // send at all in a multi-account workspace.
        channelConnectionId: (
          await resolveOutboundAccountId(db, workspaceId, best.channel, opts.accountId ?? undefined)
        ).accountId,
        status: "open",
      },
      select: { id: true },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      conv = await db.conversation.findFirstOrThrow({
        where: { workspaceId, contactId },
        orderBy: { lastMessageAt: "desc" },
        select: { id: true },
      });
    } else throw err;
  }
  return {
    contactId,
    conversationId: conv.id,
    phoneNumber,
    contactCreated: false,
    conversationCreated: true,
  };
}

export async function resolveStepTarget(
  target: StepTarget | undefined,
  envelope: WorkflowEventEnvelope,
  workspaceId: string,
  opts: {
    createConversation: boolean;
    /** Which account a NEWLY created conversation binds to — see the private
     *  helper below for why a workflow-opened thread needs to be told. */
    accountId?: string | null;
  },
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

  // Customer target — the person's BEST live channel (static id).
  if (target.kind === "customer") {
    return resolveCustomerBestChannel(workspaceId, target.customerId, opts);
  }

  // trigger_customer — the DYNAMIC omnichannel target: reach the PERSON behind
  // the trigger contact on their best channel. Resolve the trigger contact's
  // Customer id at run time; a solo (unlinked) trigger contact IS its own
  // person, so fall back to trigger_contact behavior (their own channel).
  if (target.kind === "trigger_customer") {
    const c = envelopeContact(envelope);
    if (!c) {
      throw new StepConfigError(
        "step targets the trigger person but the envelope has no contact",
      );
    }
    const row = await db.contact.findFirst({
      where: { workspaceId, id: c.id },
      select: { customerId: true },
    });
    if (row?.customerId) {
      return resolveCustomerBestChannel(workspaceId, row.customerId, opts);
    }
    // Solo person → their single channel (the trigger's own contact/conversation).
    const conv = envelopeConversation(envelope);
    return {
      contactId: c.id,
      conversationId: conv?.id ?? null,
      phoneNumber: c.phoneNumber ?? null,
      contactCreated: false,
      conversationCreated: false,
    };
  }

  // Phone target — find or create the Contact, then the Conversation.
  //
  // DELIBERATELY EVENT-LESS creates (audit 2026-08-10): the creates below are
  // bare Prisma writes that publish no `contact.created`/`conversation.created`
  // — unlike ingest-created rows. This is a conscious tradeoff, not an
  // omission: a workflow step publishing creation events is a re-trigger
  // surface ("On contact created" workflows firing from inside another
  // workflow's run), which is exactly the loop class every other step avoids
  // by publishing `silent: true` mutations. The cost is bounded and
  // self-healing — the row becomes visible on the next refetch, the
  // subsequent `message.sent` lights up the inbox live, and the 60s
  // customer-link sweeper reconciles `Contact.customerId`. If live directory
  // views ever need these rows immediately, publish WITH `silent: true` and
  // wire the fanout — never a bare publish.
  const phone = target.phoneNumber; // already normalized in parseStepTarget
  // `deletedAt: null` so we never target a SOFT-DELETED ghost (the user removed
  // them on purpose) — identity-model-added-1. A soft-deleted contact still
  // holds the (workspaceId, phoneNumber) unique slot, so the create below will P2002
  // and the revive branch handles it.
  // CHANNEL-SCOPED, like the import runner's identical hazard (see
  // import-runner.ts "borrowed phone"): contact-share and widget pre-chat
  // legitimately stamp a phone onto messenger/instagram/webchat contacts, so
  // an unscoped find could resolve a SOCIAL or WIDGET sibling — including a
  // stranger who typed a customer's number into the public pre-chat box — and
  // deliver the automation into the wrong (unverified) thread. A workflow
  // phone target means the WhatsApp identity, full stop (audit 2026-08-10).
  const existingContact = await db.contact.findFirst({
    where: { workspaceId, phoneNumber: phone, identityChannel: "whatsapp", deletedAt: null },
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
          workspaceId,
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
      // Lost the (workspaceId, phoneNumber) unique — either a CONCURRENT workflow
      // run created the contact, or the slot is held by a SOFT-DELETED ghost.
      // Re-find including deleted; revive a ghost (mirrors inbound ingest) so
      // the workflow targets a live contact instead of throwing (CTI-1).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const slotHolder = await db.contact.findFirstOrThrow({
          // Same channel scope as the find above — the (workspaceId, phone)
          // partial unique is whatsapp-scoped, so the slot holder IS the
          // WhatsApp identity; without the pin this could grab a social
          // sibling that borrowed the phone.
          where: { workspaceId, phoneNumber: phone, identityChannel: "whatsapp" },
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
  // row because `(workspaceId, contactId)` reads return the same id.
  const existingConv = await db.conversation.findFirst({
    where: { workspaceId, contactId },
    // One conversation per (workspaceId, contactId), so this returns the single row;
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
      data: {
        workspaceId,
        contactId,
        // This path targets by PHONE, so the schema's `whatsapp` default is
        // the right channel — named explicitly here only so the account
        // resolved beside it is provably for the same channel.
        channel: "whatsapp",
        channelConnectionId: (
          await resolveOutboundAccountId(db, workspaceId, "whatsapp", opts.accountId ?? undefined)
        ).accountId,
        status: "open",
      },
      select: { id: true },
    });
  } catch (err) {
    // Lost the race for this contact's single conversation (unique
    // [workspaceId, contactId]) to a concurrent path — reuse the winner.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      newConv = await db.conversation.findFirstOrThrow({
        where: { workspaceId, contactId },
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
