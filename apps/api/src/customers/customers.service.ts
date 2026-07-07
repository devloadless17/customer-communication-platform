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
}

export interface CustomerProfile {
  id: string;
  name: string | null;
  contacts: CustomerContactView[];
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
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            name: true,
            identityChannel: true,
            phoneNumber: true,
            externalContactId: true,
            avatarUrl: true,
            lastInboundAt: true,
            conversations: { select: { id: true }, take: 1 },
          },
        },
      },
    });
    if (!customer) throw new NotFoundException({ error: "customer_not_found" });
    return {
      id: customer.id,
      name: customer.name,
      contacts: customer.contacts.map((c) => ({
        id: c.id,
        name: c.name,
        identityChannel: c.identityChannel,
        phoneNumber: c.phoneNumber,
        externalContactId: c.externalContactId,
        avatarUrl: c.avatarUrl,
        lastInboundAt: c.lastInboundAt?.toISOString() ?? null,
        conversationId: c.conversations[0]?.id ?? null,
      })),
    };
  }

  getProfile(teamId: string, customerId: string): Promise<CustomerProfile> {
    return this.loadProfile(teamId, customerId);
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
      await tx.contact.update({ where: { id: contactId }, data: { customerId } });

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

      const fresh = await tx.customer.create({
        data: { teamId, name: contact.name },
        select: { id: true },
      });
      await tx.contact.update({ where: { id: contactId }, data: { customerId: fresh.id } });

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
