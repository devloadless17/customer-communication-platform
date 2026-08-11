import type { PrismaClient } from "@prisma/client";

type Db = Pick<PrismaClient, "aiCustomerMemory">;

/**
 * Carry a reaped Customer's PERSON-level AI memories to the person who
 * absorbed them — or delete them when nobody did.
 *
 * `AiCustomerMemory.customerId` is a soft pointer (no FK, by design), and
 * every empty-Customer reap (manual link, contact-share adopt, ingest
 * cold→warm adopt, BSUID reconcile, the link-drift sweeper, visitor
 * retention) used to hard-delete the Customer row and leave the memories
 * dangling forever: the panel and the reply prompts load by the contact's
 * CURRENT customerId, so a routine sanctioned merge silently erased what the
 * schema calls "permanent, PERSON-level memory" — and the rows themselves
 * accumulated unbounded, cleaned by no sweeper (audit 2026-08-10).
 *
 * Call INSIDE the same transaction as the reap. Within that transaction the
 * order is delete-first on purpose: the reap's `deleteMany` count is the only
 * race-safe answer to "was the Customer actually childless", and adopting
 * memories off a customer who was NOT reaped would strip a still-live person.
 * Atomicity is the requirement — never call this on the bare client after a
 * bare delete (a crash between the two strands the memories forever).
 * Dedup-aware: `@@unique([workspaceId, customerId, kind, value])` means a
 * blind updateMany P2002s when the adoptee already learned the same fact, so
 * duplicates are dropped rather than moved. `toCustomerId: null` = the person
 * is being purged (visitor retention) — the memories go with them.
 */
export async function adoptCustomerMemories(
  db: Db,
  workspaceId: string,
  fromCustomerId: string,
  toCustomerId: string | null,
): Promise<void> {
  if (!toCustomerId) {
    await db.aiCustomerMemory.deleteMany({ where: { workspaceId, customerId: fromCustomerId } });
    return;
  }
  const existing = await db.aiCustomerMemory.findMany({
    where: { workspaceId, customerId: toCustomerId },
    select: { kind: true, value: true },
  });
  const already = new Set(existing.map((m) => `${m.kind}\u0000${m.value}`));
  const moving = await db.aiCustomerMemory.findMany({
    where: { workspaceId, customerId: fromCustomerId },
    select: { id: true, kind: true, value: true },
  });
  const dupIds = moving.filter((m) => already.has(`${m.kind}\u0000${m.value}`)).map((m) => m.id);
  if (dupIds.length > 0) {
    await db.aiCustomerMemory.deleteMany({ where: { id: { in: dupIds }, workspaceId } });
  }
  await db.aiCustomerMemory.updateMany({
    where: { workspaceId, customerId: fromCustomerId },
    data: { customerId: toCustomerId },
  });
}
