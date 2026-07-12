import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";

import { DbService } from "../db/db.service";

/** A channel-contact under a customer, shaped for the profile's channel switcher. */
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
 * docs/identity.md). A Customer is a person; linking joins a channel-contact to
 * that person, unlinking splits it back to its own person. Message histories are
 * never touched — only `Contact.customerId` moves. Tenant-scoped throughout.
 */
@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);
  constructor(private readonly db: DbService) {}

  private async loadProfile(teamId: string, customerId: string): Promise<CustomerProfile> {
    const customer = await this.db.customer.findFirst({
      where: { id: customerId, teamId },
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
              select: {
                id: true,
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
      return {
        id: c.id,
        name: c.name,
        identityChannel: c.identityChannel,
        phoneNumber: c.phoneNumber,
        externalContactId: c.externalContactId,
        avatarUrl: c.avatarUrl,
        lastInboundAt: c.lastInboundAt?.toISOString() ?? null,
        conversationId: convo?.id ?? null,
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
    return {
      id: customer.id,
      name: customer.name,
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
    teamId: string,
    customerId: string,
    name: string,
  ): Promise<CustomerProfile> {
    const trimmed = name.trim();
    const res = await this.db.customer.updateMany({
      where: { id: customerId, teamId },
      data: { name: trimmed.length > 0 ? trimmed : null },
    });
    if (res.count === 0) throw new NotFoundException({ error: "customer_not_found" });
    return this.loadProfile(teamId, customerId);
  }

  getProfile(teamId: string, customerId: string): Promise<CustomerProfile> {
    return this.loadProfile(teamId, customerId);
  }

  /**
   * The unified profile for whichever customer a contact belongs to — the
   * contact panel calls this with the contact id it already holds. Returns null
   * for a not-yet-linked contact (the UI then treats it as its own person until
   * the customer-link sweeper links it, moments later).
   */
  async getProfileByContact(
    teamId: string,
    contactId: string,
  ): Promise<CustomerProfile | null> {
    const contact = await this.db.contact.findFirst({
      where: { id: contactId, teamId, deletedAt: null },
      select: { customerId: true },
    });
    if (!contact) throw new NotFoundException({ error: "contact_not_found" });
    if (!contact.customerId) return null;
    return this.loadProfile(teamId, contact.customerId);
  }

  /**
   * Join `contactId` to this customer (they're the same person). Re-points the
   * contact's `customerId`; if its previous customer is left with no contacts,
   * that empty customer is dropped. Reversible via `unlink`.
   */
  async linkContact(
    teamId: string,
    customerId: string,
    contactId: string,
    actorUserId: string | null = null,
  ): Promise<CustomerProfile> {
    await this.db.$transaction(async (tx) => {
      const [customer, contact] = await Promise.all([
        tx.customer.findFirst({ where: { id: customerId, teamId }, select: { id: true } }),
        tx.contact.findFirst({
          where: { id: contactId, teamId, deletedAt: null },
          select: { id: true, customerId: true },
        }),
      ]);
      if (!customer) throw new NotFoundException({ error: "customer_not_found" });
      if (!contact) throw new NotFoundException({ error: "contact_not_found" });
      if (contact.customerId === customerId) return; // already linked — no-op

      const previousCustomerId = contact.customerId;
      // Capture the source person's name BEFORE the reap below deletes its row.
      // Persisting it makes the merge non-destructive (a deliberate rename
      // survives in the audit trail) and lets `unlink` restore it.
      const previousCustomer = previousCustomerId
        ? await tx.customer.findFirst({
            where: { id: previousCustomerId, teamId },
            select: { name: true },
          })
        : null;
      await tx.contact.update({ where: { id: contactId }, data: { customerId } });

      // Persisted audit (§6): who merged this contact into which customer, and
      // from where. Co-committed so it can't drift from the actual re-point.
      await tx.customerIdentityEvent.create({
        data: {
          teamId,
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
        const remaining = await tx.contact.count({
          where: { customerId: previousCustomerId },
        });
        if (remaining === 0) {
          await tx.customer.deleteMany({ where: { id: previousCustomerId, teamId } });
        }
      }
    });
    this.logger.log(`link contact ${contactId} → customer ${customerId} (team ${teamId})`);
    return this.loadProfile(teamId, customerId);
  }

  /**
   * Split `contactId` off its current customer into a fresh one (they're NOT the
   * same person after all). The old customer is dropped if now empty. Returns
   * the new customer's profile. Reversible via `link`.
   */
  async unlinkContact(
    teamId: string,
    fromCustomerId: string,
    contactId: string,
    actorUserId: string | null = null,
  ): Promise<{ customerId: string }> {
    const newCustomerId = await this.db.$transaction(async (tx) => {
      const contact = await tx.contact.findFirst({
        where: { id: contactId, teamId, deletedAt: null },
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
        where: { teamId, contactId, action: "link", toCustomerId: previousCustomerId ?? undefined },
        orderBy: { createdAt: "desc" },
        select: { fromCustomerName: true },
      });
      const restoredName = lastLink?.fromCustomerName?.trim() || contact.name;

      const fresh = await tx.customer.create({
        data: { teamId, name: restoredName },
        select: { id: true },
      });
      await tx.contact.update({ where: { id: contactId }, data: { customerId: fresh.id } });

      // Persisted audit (§6): the split back to a distinct person.
      await tx.customerIdentityEvent.create({
        data: {
          teamId,
          contactId,
          action: "unlink",
          fromCustomerId: previousCustomerId,
          toCustomerId: fresh.id,
          actorUserId,
        },
      });

      if (previousCustomerId && previousCustomerId !== fresh.id) {
        const remaining = await tx.contact.count({ where: { customerId: previousCustomerId } });
        if (remaining === 0) {
          await tx.customer.deleteMany({ where: { id: previousCustomerId, teamId } });
        }
      }
      return fresh.id;
    });
    this.logger.log(`unlink contact ${contactId} → new customer ${newCustomerId} (team ${teamId})`);
    return { customerId: newCustomerId };
  }
}
