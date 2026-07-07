import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";

/**
 * Unified customer identity resolution (§6 / docs/identity.md).
 *
 * Resolves which `Customer` a contact belongs to, then RETURNS the id (the
 * caller sets it via a CAS update). Auto-merge is DELIBERATELY conservative —
 * only deterministic STRONG keys link two contacts into one person:
 *
 *   - exact `phoneNumber` match, or
 *   - exact `email` match
 *
 * NEVER name/fuzzy matching (the top source of wrong-person data leaks). Any
 * softer link is a manual, reversible merge (see the merge/split API). Tenant-
 * scoped: identity never crosses `teamId`. If nothing matches, the contact is a
 * distinct person and gets a fresh Customer.
 *
 * Runs in exactly one place conceptually — this service — called from the
 * customer-link sweeper (and reusable by any create path that wants inline
 * linking).
 */
export async function resolveCustomerId(
  teamId: string,
  contact: {
    id: string;
    phoneNumber: string | null;
    email: string | null;
    name: string;
  },
): Promise<string> {
  // Build the strong-key OR arms for whichever verified identifiers exist.
  const strongKeys: Prisma.ContactWhereInput[] = [];
  if (contact.phoneNumber) strongKeys.push({ phoneNumber: contact.phoneNumber });
  if (contact.email) strongKeys.push({ email: contact.email });

  if (strongKeys.length > 0) {
    // Another ALREADY-LINKED contact in the team sharing a strong key is the
    // same person — adopt its customer. Oldest wins so the canonical customer
    // is stable regardless of sweep order.
    const match = await db.contact.findFirst({
      where: {
        teamId,
        id: { not: contact.id },
        customerId: { not: null },
        deletedAt: null,
        OR: strongKeys,
      },
      select: { customerId: true },
      orderBy: { createdAt: "asc" },
    });
    if (match?.customerId) return match.customerId;
  }

  // Distinct person → fresh Customer, seeded with the contact's display name.
  const customer = await db.customer.create({
    data: { teamId, name: contact.name },
    select: { id: true },
  });
  return customer.id;
}
