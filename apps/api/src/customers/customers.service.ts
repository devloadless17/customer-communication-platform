import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  ephemeralVisitorLabel,
  isEphemeralChannel,
  isSocialContactPlaceholder,
  socialContactPlaceholder,
} from "@ccp/shared/providers/capabilities";
import type { Channel } from "@ccp/shared/types";

import { toContactWire } from "@/lib/queries/_shared";
import { workflowContactSnapshot } from "@/lib/workflows/events";

import { EventBus } from "../events/event-bus.module";
import {
  visibilityWhere,
  type ConversationViewer,
} from "@/lib/conversations/visibility";
import { DbService } from "../db/db.service";

/**
 * A brand-new social contact carries its opaque PSID/IGSID as `name` until the
 * async Graph enrichment pass fills the real display name. Never surface that raw
 * id: show the channel placeholder ("Instagram user") for a channel-contact, and
 * — for the PERSON header — prefer a linked channel's already-enriched real name
 * over the id the Customer row was stamped with at creation time (the
 * "1932759190769573" leak). Mirrors `contactDisplayIdentity` in queries/_shared.
 */
function isRealContactName(
  name: string | null | undefined,
  externalContactId: string | null,
): boolean {
  const n = name?.trim();
  return (
    !!n && n !== externalContactId && !isSocialContactPlaceholder(n)
  );
}

/** A channel-contact under a customer, shaped for the profile's channel switcher. */
/** A possible same-person match for an agent to confirm. Never auto-applied. */
export interface LinkSuggestion {
  contactId: string;
  customerId: string | null;
  name: string;
  identityChannel: string;
  matchedOn: "phone" | "email";
  matchedValue: string | null;
  /** False when either side is a self-asserted (website widget) value. */
  verified: boolean;
  lastInboundAt: string | null;
}

export interface CustomerContactView {
  id: string;
  name: string;
  identityChannel: string;
  phoneNumber: string | null;
  externalContactId: string | null;
  avatarUrl: string | null;
  lastInboundAt: string | null;
  /** The contact's conversation (one per contact) — for switching threads. */
  conversationId: string | null;
  /**
   * WHICH of the workspace's accounts that thread is on.
   *
   * The person hub exists to answer "where has this person reached us", and
   * with two numbers on one channel the channel badge alone cannot: someone who
   * messaged both Sales and Support looked like one undifferentiated WhatsApp
   * contact.
   */
  channelConnectionId: string | null;
  /** Denormalized thread activity, so the switcher shows each channel like a
   *  mini conversation-list row (last message + time + unread + status). */
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  conversationStatus: string | null;
}

export interface CustomerProfile {
  id: string;
  name: string | null;
  contacts: CustomerContactView[];
  /** Person-level unread = sum across the person's channel threads. */
  unreadTotal: number;
  /** Identity fields lifted + de-duped across all the person's channel-contacts
   *  — so the profile shows the whole person, not one channel's slice. */
  details: {
    phones: string[];
    emails: string[];
    /** Instagram @usernames (no leading @). */
    usernames: string[];
  };
}

/**
 * Unified customer profile + manual, reversible merge/split (§6 /
 * lib/identity/identity-service.ts). A Customer is a person; linking joins a channel-contact to
 * that person, unlinking splits it back to its own person. Message histories are
 * never touched — only `Contact.customerId` moves. Tenant-scoped throughout.
 */
@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);
  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

  /**
   * Announce a manual merge/split re-point. link/unlink move `Contact.customerId`
   * but nothing on the bus said so — so other agents' open contact panels, the
   * group-by-person rollup, and identity-syncing partner webhooks kept the
   * pre-merge view until a manual reload. Publish the same `contact.updated` the
   * contact-share re-point does (lib/identity/identity-service.ts) so the existing socket
   * fanout + outbound-webhook subscriber converge with no new wiring.
   * Best-effort: a publish failure must never undo a committed merge.
   */
  private async publishContactUpdated(
    workspaceId: string,
    contactId: string,
    actorUserId: string | null,
  ): Promise<void> {
    try {
      const fresh = await this.db.contact.findFirst({
        where: { id: contactId, workspaceId },
        include: { tags: { select: { id: true } } },
      });
      if (!fresh) return;
      await this.bus.publish({
        type: "contact.updated",
        workspaceId,
        contact: toContactWire(fresh, { tagIds: fresh.tags.map((t) => t.id) }),
        previousStageId: fresh.stageId,
        fieldChanges: [],
        changedByUserId: actorUserId,
        workflowContact: workflowContactSnapshot(fresh),
      });
    } catch (err) {
      this.logger.error(
        `publish(contact.updated) failed for contact ${contactId} (team ${workspaceId})`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  private async loadProfile(
    workspaceId: string,
    customerId: string,
    /**
     * The agent asking. A RESTRICTED viewer must not learn anything about a
     * thread they can't open — and this method returns
     * `lastMessagePreview`, `unreadCount` and `conversationId` for EVERY
     * contact linked to the person.
     *
     * That made it the one hole in an otherwise complete boundary: the
     * conversation list, in-thread search, global search and the contacts
     * list all apply the visibility clause (and the contacts list
     * deliberately returns no preview at all). A restricted agent could list
     * contacts — which is workspace-wide by design — and then read the last
     * message of every thread in the workspace, one `by-contact` call at a
     * time.
     */
    viewer?: ConversationViewer,
  ): Promise<CustomerProfile> {
    const customer = await this.db.customer.findFirst({
      where: { id: customerId, workspaceId },
      select: {
        id: true,
        name: true,
        contacts: {
          where: { deletedAt: null },
          select: {
            id: true,
            name: true,
            identityChannel: true,
            phoneNumber: true,
            externalContactId: true,
            avatarUrl: true,
            // Person-level identity fields — aggregated (distinct) across the
            // person's channel-contacts into `details` below, so the profile
            // shows the FULL picture (a phone from WhatsApp + an email an agent
            // added on another channel + the IG @handle) in one place.
            email: true,
            username: true,
            lastInboundAt: true,
            conversations: {
              // Restricted agents see only their own threads here. An
              // unrestricted viewer (and an internal caller passing none)
              // gets `{}`, i.e. no change.
              ...(viewer ? { where: visibilityWhere(viewer) } : {}),
              select: {
                id: true,
                channelConnectionId: true,
                lastMessagePreview: true,
                lastMessageAt: true,
                unreadCount: true,
                status: true,
              },
              take: 1,
            },
          },
        },
      },
    });
    if (!customer) throw new NotFoundException({ error: "customer_not_found" });
    const contacts: CustomerContactView[] = customer.contacts.map((c) => {
      const convo = c.conversations[0] ?? null;
      // Substitute the friendly placeholder for a still-un-enriched contact whose
      // name is its raw id — so the switcher never shows "1932759190769573".
      // Same fallback chain as the contact wire mapper (queries/_shared.ts):
      // real name → self-asserted email/phone → per-visitor label for an ephemeral
      // channel → channel placeholder. Kept in step so the switcher and the inbox
      // never disagree about what to call the same person.
      const contactName = isRealContactName(c.name, c.externalContactId)
        ? c.name
        : isEphemeralChannel(c.identityChannel as Channel)
          ? c.email || c.phoneNumber || ephemeralVisitorLabel(c.externalContactId)
          : socialContactPlaceholder(c.identityChannel as Channel | null);
      return {
        id: c.id,
        name: contactName,
        identityChannel: c.identityChannel,
        phoneNumber: c.phoneNumber,
        externalContactId: c.externalContactId,
        avatarUrl: c.avatarUrl,
        lastInboundAt: c.lastInboundAt?.toISOString() ?? null,
        conversationId: convo?.id ?? null,
        channelConnectionId: convo?.channelConnectionId ?? null,
        lastMessagePreview: convo?.lastMessagePreview ?? null,
        lastMessageAt: convo?.lastMessageAt?.toISOString() ?? null,
        unreadCount: convo?.unreadCount ?? 0,
        conversationStatus: convo?.status ?? null,
      };
    });
    // Most-active channel first (recent thread activity), falling back to last
    // inbound, then create order — so the switcher leads with the live channel.
    contacts.sort((a, b) => {
      const at = a.lastMessageAt ?? a.lastInboundAt ?? "";
      const bt = b.lastMessageAt ?? b.lastInboundAt ?? "";
      return bt.localeCompare(at);
    });
    // Lift person-level identity fields: distinct phones / emails / @usernames
    // across every channel-contact, so the profile shows who this person is
    // regardless of which channel each fact came in on. Order-stable (first
    // seen wins), trimmed, de-duped case-insensitively for emails.
    const distinct = (values: Array<string | null | undefined>, lower = false) => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const raw of values) {
        const v = raw?.trim();
        if (!v) continue;
        const key = lower ? v.toLowerCase() : v;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(v);
      }
      return out;
    };
    // Person display name. The Customer row is stamped with the contact's name at
    // creation — for a fresh social contact that's the raw PSID/IGSID, and it
    // never got refreshed once the contact enriched to a real name. So only keep
    // `customer.name` when it's a REAL name (not a raw id, not a placeholder);
    // otherwise fall back to the best linked channel's already-enriched name
    // (contacts are sorted most-active first), else null → "Unnamed person".
    const externalIds = customer.contacts
      .map((c) => c.externalContactId)
      .filter((x): x is string => !!x);
    const customerNameIsReal =
      !!customer.name?.trim() &&
      !externalIds.includes(customer.name.trim()) &&
      !isSocialContactPlaceholder(customer.name.trim());
    // `contacts` is sorted most-active-first and already carries the placeholder
    // for un-enriched names, so the first that reads as a real name is the best.
    const bestContactName = contacts.find((c) =>
      isRealContactName(c.name, c.externalContactId),
    )?.name;
    const personName = customerNameIsReal
      ? customer.name
      : bestContactName ?? null;
    return {
      id: customer.id,
      name: personName,
      contacts,
      unreadTotal: contacts.reduce((sum, c) => sum + c.unreadCount, 0),
      details: {
        phones: distinct(customer.contacts.map((c) => c.phoneNumber)),
        emails: distinct(customer.contacts.map((c) => c.email), true),
        usernames: distinct(customer.contacts.map((c) => c.username)),
      },
    };
  }

  /**
   * Rename the PERSON (Customer). Distinct from renaming a channel-contact —
   * this is the identity that spans channels. Tenant-scoped; 409-safe via the
   * P2025 filter (no such customer). Returns the refreshed profile.
   */
  async rename(
    workspaceId: string,
    customerId: string,
    name: string,
    /** The agent asking — the profile it returns is viewer-filtered, and an
     *  edit is no reason to hand back more than a read would. */
    viewer?: ConversationViewer,
  ): Promise<CustomerProfile> {
    const trimmed = name.trim();
    const res = await this.db.customer.updateMany({
      where: { id: customerId, workspaceId },
      data: { name: trimmed.length > 0 ? trimmed : null },
    });
    if (res.count === 0) throw new NotFoundException({ error: "customer_not_found" });
    return this.loadProfile(workspaceId, customerId, viewer);
  }

  getProfile(
    workspaceId: string,
    customerId: string,
    viewer?: ConversationViewer,
  ): Promise<CustomerProfile> {
    return this.loadProfile(workspaceId, customerId, viewer);
  }

  /**
   * The unified profile for whichever customer a contact belongs to — the
   * contact panel calls this with the contact id it already holds. Returns null
   * for a not-yet-linked contact (the UI then treats it as its own person until
   * the customer-link sweeper links it, moments later).
   */
  async getProfileByContact(
    workspaceId: string,
    contactId: string,
    viewer?: ConversationViewer,
  ): Promise<CustomerProfile | null> {
    const contact = await this.db.contact.findFirst({
      where: { id: contactId, workspaceId, deletedAt: null },
      select: { customerId: true },
    });
    if (!contact) throw new NotFoundException({ error: "contact_not_found" });
    if (!contact.customerId) return null;
    return this.loadProfile(workspaceId, contact.customerId, viewer);
  }

  /**
   * Join `contactId` to this customer (they're the same person). Re-points the
   * contact's `customerId`; if its previous customer is left with no contacts,
   * that empty customer is dropped. Reversible via `unlink`.
   */
  /**
   * Other contacts that look like the SAME PERSON as `contactId`, for an agent to
   * confirm — never applied automatically.
   *
   * Two situations produce this, and they're the same query:
   *   - The same visitor chats from three browsers and types their phone each time.
   *     Each browser is its own `vis_<uuid>`, so each is its own Contact; without a
   *     hint the agent sees three unrelated people with one phone number.
   *   - A widget visitor claims a phone/email belonging to an existing customer.
   *
   * `verified` is the load-bearing field. A value typed into the widget's public
   * pre-chat box proves nothing — anyone can type anyone's number — so a match that
   * involves an ephemeral channel on EITHER side is reported as unverified, and the
   * UI says so. This is deliberately a suggestion and not an auto-merge: auto-merging
   * on an unverified key is the impersonation hole that `webchat-prechat.ts` and the
   * `findExistingCustomerIdByStrongKey` candidate filter both exist to prevent.
   * Confirming calls the ordinary, reversible `linkContact`.
   */
  async suggestLinks(workspaceId: string, contactId: string): Promise<LinkSuggestion[]> {
    const me = await this.db.contact.findFirst({
      where: { id: contactId, workspaceId, deletedAt: null },
      select: { id: true, phoneNumber: true, email: true, customerId: true, identityChannel: true },
    });
    if (!me) return [];
    const keys: Prisma.ContactWhereInput[] = [];
    if (me.phoneNumber) keys.push({ phoneNumber: me.phoneNumber });
    if (me.email) keys.push({ email: me.email });
    if (keys.length === 0) return [];

    const others = await this.db.contact.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        id: { not: me.id },
        // Already the same person — nothing to suggest.
        ...(me.customerId ? { customerId: { not: me.customerId } } : {}),
        OR: keys,
      },
      select: {
        id: true, name: true, identityChannel: true, phoneNumber: true, email: true,
        externalContactId: true, customerId: true, lastInboundAt: true,
      },
      orderBy: { lastInboundAt: "desc" },
      take: 10,
    });

    const mineEphemeral = isEphemeralChannel(me.identityChannel as Channel);
    return others.map((o) => {
      const matchedOn: "phone" | "email" =
        me.phoneNumber && o.phoneNumber === me.phoneNumber ? "phone" : "email";
      const otherEphemeral = isEphemeralChannel(o.identityChannel as Channel);
      return {
        contactId: o.id,
        customerId: o.customerId,
        name: isRealContactName(o.name, o.externalContactId)
          ? o.name
          : otherEphemeral
            ? o.email || o.phoneNumber || ephemeralVisitorLabel(o.externalContactId)
            : socialContactPlaceholder(o.identityChannel as Channel | null),
        identityChannel: o.identityChannel,
        matchedOn,
        matchedValue: matchedOn === "phone" ? o.phoneNumber : o.email,
        // Self-asserted on either side ⇒ the agent must not treat it as proof.
        verified: !mineEphemeral && !otherEphemeral,
        lastInboundAt: o.lastInboundAt?.toISOString() ?? null,
      };
    });
  }

  async linkContact(
    workspaceId: string,
    customerId: string,
    contactId: string,
    actorUserId: string | null = null,
    /** The agent asking — see `rename`. */
    viewer?: ConversationViewer,
  ): Promise<CustomerProfile> {
    const moved = await this.db.$transaction(async (tx) => {
      const [customer, contact] = await Promise.all([
        tx.customer.findFirst({ where: { id: customerId, workspaceId }, select: { id: true } }),
        tx.contact.findFirst({
          where: { id: contactId, workspaceId, deletedAt: null },
          select: { id: true, customerId: true },
        }),
      ]);
      if (!customer) throw new NotFoundException({ error: "customer_not_found" });
      if (!contact) throw new NotFoundException({ error: "contact_not_found" });
      if (contact.customerId === customerId) return false; // already linked — no-op

      const previousCustomerId = contact.customerId;
      // Capture the source person's name BEFORE the reap below deletes its row.
      // Persisting it makes the merge non-destructive (a deliberate rename
      // survives in the audit trail) and lets `unlink` restore it.
      const previousCustomer = previousCustomerId
        ? await tx.customer.findFirst({
            where: { id: previousCustomerId, workspaceId },
            select: { name: true },
          })
        : null;
      await tx.contact.update({ where: { id: contactId }, data: { customerId } });

      // Persisted audit (§6): who merged this contact into which customer, and
      // from where. Co-committed so it can't drift from the actual re-point.
      await tx.customerIdentityEvent.create({
        data: {
          workspaceId,
          contactId,
          action: "link",
          fromCustomerId: previousCustomerId,
          fromCustomerName: previousCustomer?.name ?? null,
          toCustomerId: customerId,
          actorUserId,
        },
      });

      // Drop the previous customer if it's now empty (the contact was its only
      // member). Guarded so we never delete a customer that still has contacts.
      if (previousCustomerId && previousCustomerId !== customerId) {
          // `deletedAt: null` — a TOMBSTONED contact keeps its `customerId`, so
          // counting it left an emptied Customer alive forever: `loadProfile`
          // filters tombstones, so it rendered as a person with zero contacts,
          // and the rows accumulate unbounded. `workspaceId` for the §18 letter
          // (a cuid implies the workspace, but the sibling deleteMany on the
          // next line carries it and these should not disagree).
        const remaining = await tx.contact.count({
          where: { customerId: previousCustomerId, workspaceId, deletedAt: null },
        });
        if (remaining === 0) {
          await tx.customer.deleteMany({ where: { id: previousCustomerId, workspaceId } });
        }
      }
      return true;
    });
    this.logger.log(`link contact ${contactId} → customer ${customerId} (team ${workspaceId})`);
    // Only after the re-point commits, and only when it actually moved (never a
    // speculative/unchanged frame for a no-op re-link).
    if (moved) await this.publishContactUpdated(workspaceId, contactId, actorUserId);
    return this.loadProfile(workspaceId, customerId, viewer);
  }

  /**
   * Split `contactId` off its current customer into a fresh one (they're NOT the
   * same person after all). The old customer is dropped if now empty. Returns
   * the new customer's profile. Reversible via `link`.
   */
  async unlinkContact(
    workspaceId: string,
    fromCustomerId: string,
    contactId: string,
    actorUserId: string | null = null,
  ): Promise<{ customerId: string }> {
    const newCustomerId = await this.db.$transaction(async (tx) => {
      const contact = await tx.contact.findFirst({
        where: { id: contactId, workspaceId, deletedAt: null },
        select: { id: true, name: true, customerId: true },
      });
      if (!contact) throw new NotFoundException({ error: "contact_not_found" });
      if (fromCustomerId && contact.customerId !== fromCustomerId) {
        throw new BadRequestException({ error: "contact_not_in_customer" });
      }
      const previousCustomerId = contact.customerId;

      // Restore the pre-merge person name when this contact was previously linked
      // into its current customer (reversing that merge). The latest `link` event
      // for this contact recorded the source customer's name before it was reaped;
      // prefer it over the channel-contact name so a deliberate rename survives a
      // merge→unlink round-trip. Falls back to the contact's own name otherwise.
      const lastLink = await tx.customerIdentityEvent.findFirst({
        where: { workspaceId, contactId, action: "link", toCustomerId: previousCustomerId ?? undefined },
        orderBy: { createdAt: "desc" },
        select: { fromCustomerName: true },
      });
      const restoredName = lastLink?.fromCustomerName?.trim() || contact.name;

      const fresh = await tx.customer.create({
        data: { workspaceId, name: restoredName },
        select: { id: true },
      });
      await tx.contact.update({ where: { id: contactId }, data: { customerId: fresh.id } });

      // Persisted audit (§6): the split back to a distinct person.
      await tx.customerIdentityEvent.create({
        data: {
          workspaceId,
          contactId,
          action: "unlink",
          fromCustomerId: previousCustomerId,
          toCustomerId: fresh.id,
          actorUserId,
        },
      });

      if (previousCustomerId && previousCustomerId !== fresh.id) {
        // Same rule as the link path above: tombstones don't keep a Customer
        // alive, and the count carries workspaceId like its sibling delete.
        const remaining = await tx.contact.count({
          where: { customerId: previousCustomerId, workspaceId, deletedAt: null },
        });
        if (remaining === 0) {
          await tx.customer.deleteMany({ where: { id: previousCustomerId, workspaceId } });
        }
      }
      return fresh.id;
    });
    this.logger.log(`unlink contact ${contactId} → new customer ${newCustomerId} (team ${workspaceId})`);
    // The split re-pointed the contact to a fresh customer — announce it so
    // panels/rollup/webhooks converge (see publishContactUpdated).
    await this.publishContactUpdated(workspaceId, contactId, actorUserId);
    return { customerId: newCustomerId };
  }
}
