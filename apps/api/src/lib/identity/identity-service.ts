import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";

/**
 * Unified customer identity resolution (§6 / docs/identity.md).
 *
 * Resolves which `Customer` a contact belongs to, then RETURNS the id (the
 * caller sets it via a CAS update). Auto-merge is DELIBERATELY conservative —
 * only deterministic STRONG keys link two contacts into one person:
 *
 *   - exact `phoneNumber` match — always. On a phone channel the number IS the
 *     channel identity, verified by the provider as the actual sender.
 *   - exact `email` match — ONLY when `trustEmailAsStrongKey` is set.
 *
 * The email carve-out is load-bearing. An email is a strong key only when the
 * PERSON asserted it: the contact-share flow has the customer tap Meta's
 * autofill quick reply, so the address comes from their own Meta account. An
 * email an agent typed or a CSV imported asserts nothing — shared inboxes
 * (`info@acme.com`, a family address) are common, and auto-merging on one fuses
 * two different humans into one Customer. That exposes one person's thread under
 * the other's unified profile and misroutes a `targetMode:"customer"` broadcast
 * to the wrong channel. Under-merging is recoverable (the manual merge API);
 * over-merging silently leaks data. So callers that cannot vouch for the address
 * leave the flag off and let a human decide.
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
/**
 * Prisma client accepted by `resolveCustomerId` — the global `db` (sweeper) or a
 * transaction client (ingest, so the Customer create rolls back with the
 * contact if the surrounding tx aborts). Both expose the `contact`/`customer`
 * delegates this uses.
 */
type IdentityClient = Pick<typeof db, "contact" | "customer">;

export async function resolveCustomerId(
  teamId: string,
  contact: {
    id?: string;
    phoneNumber: string | null;
    email: string | null;
    name: string;
  },
  client: IdentityClient = db,
  {
    /**
     * Set ONLY when the email was asserted by the person themselves (today: the
     * contact-share autofill flow). Defaults off — see the header note.
     */
    trustEmailAsStrongKey = false,
  }: { trustEmailAsStrongKey?: boolean } = {},
): Promise<string> {
  // Build the strong-key OR arms for whichever verified identifiers exist.
  const strongKeys: Prisma.ContactWhereInput[] = [];
  if (contact.phoneNumber) strongKeys.push({ phoneNumber: contact.phoneNumber });
  if (contact.email && trustEmailAsStrongKey) strongKeys.push({ email: contact.email });

  if (strongKeys.length > 0) {
    // Another ALREADY-LINKED contact in the team sharing a strong key is the
    // same person — adopt its customer. Oldest wins so the canonical customer
    // is stable regardless of sweep order. `id` is optional: at ingest the
    // contact row doesn't exist yet, so there's nothing to exclude.
    const match = await client.contact.findFirst({
      where: {
        teamId,
        ...(contact.id ? { id: { not: contact.id } } : {}),
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
  const customer = await client.customer.create({
    data: { teamId, name: contact.name },
    select: { id: true },
  });
  return customer.id;
}
