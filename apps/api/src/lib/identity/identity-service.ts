import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { EPHEMERAL_CONTACT_CHANNELS } from "@ccp/shared/providers/capabilities";

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

interface ResolveContactInput {
  id?: string;
  phoneNumber: string | null;
  email: string | null;
  name: string;
}

interface ResolveOpts {
  /**
   * Set ONLY when the email was asserted by the person themselves (today: the
   * contact-share autofill flow). Defaults off — see the header note.
   */
  trustEmailAsStrongKey?: boolean;
}

/**
 * Find an EXISTING already-linked person that shares a deterministic strong key
 * with this contact, or null if none. **Never creates a Customer** — this is the
 * "did we adopt someone?" question, split out from {@link resolveCustomerId} so a
 * caller that already owns a Customer (contact-share) can tell a real adoption
 * apart from "no match". Re-pointing a contact onto a freshly-minted solo
 * Customer would silently tear it out of a manually-merged profile or churn its
 * id and discard a person-level rename — so that decision needs this signal.
 */
export async function findExistingCustomerIdByStrongKey(
  teamId: string,
  contact: ResolveContactInput,
  client: IdentityClient = db,
  { trustEmailAsStrongKey = false }: ResolveOpts = {},
): Promise<string | null> {
  const strongKeys: Prisma.ContactWhereInput[] = [];
  if (contact.phoneNumber) strongKeys.push({ phoneNumber: contact.phoneNumber });
  if (contact.email && trustEmailAsStrongKey) strongKeys.push({ email: contact.email });
  if (strongKeys.length === 0) return null;

  // Another ALREADY-LINKED contact in the team sharing a strong key is the same
  // person — adopt its customer. Oldest wins so the canonical customer is stable
  // regardless of sweep order. `id` is optional: at ingest the contact row
  // doesn't exist yet, so there's nothing to exclude.
  //
  // EPHEMERAL channels are excluded from the CANDIDATE set — a strong key is only
  // strong when the vendor verified the identity behind it, and a website-widget
  // visitor is anonymous (`webchat-prechat.ts` refuses to merge FROM this data for
  // exactly that reason). Without this exclusion the same merge happens from the
  // far side: a stranger types a known customer's number into the public pre-chat
  // box, it lands on their widget contact, and the real owner's next WhatsApp
  // inbound resolves that number, finds the widget contact, and adopts ITS
  // customer — folding the stranger's live thread into the real person's profile
  // and linked-channels switcher. The value is still STORED on the contact (the
  // agent can see and act on it); it just never acts as a key. Re-enabling
  // requires verifying the number/address first (SMS/email code) — see §6.
  const match = await client.contact.findFirst({
    where: {
      teamId,
      ...(contact.id ? { id: { not: contact.id } } : {}),
      customerId: { not: null },
      deletedAt: null,
      identityChannel: { notIn: [...EPHEMERAL_CONTACT_CHANNELS] },
      OR: strongKeys,
    },
    select: { customerId: true },
    orderBy: { createdAt: "asc" },
  });
  return match?.customerId ?? null;
}

export async function resolveCustomerId(
  teamId: string,
  contact: ResolveContactInput,
  client: IdentityClient = db,
  opts: ResolveOpts = {},
): Promise<string> {
  const existing = await findExistingCustomerIdByStrongKey(teamId, contact, client, opts);
  if (existing) return existing;

  // Distinct person → fresh Customer, seeded with the contact's display name.
  const customer = await client.customer.create({
    data: { teamId, name: contact.name },
    select: { id: true },
  });
  return customer.id;
}
