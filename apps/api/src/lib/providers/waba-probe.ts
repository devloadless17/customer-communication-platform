/**
 * Picking the connection to read a WABA WITH — one rule, five call sites.
 *
 * Several WABA-scoped reads (template catalog sync, template analytics, the
 * account-level analytics surfaces, the webhook-subscription health sweeper) all
 * need the same thing: a WABA row names a Graph object, but every Graph call needs
 * a TOKEN, and the token lives on a `ChannelConnection` (a phone number) under
 * that WABA. So each of them has to answer "which of this WABA's numbers do I
 * borrow credentials from?".
 *
 * Five implementations had drifted to five levels of rigor — some filtered
 * `isActive`, some ordered deterministically, only one asserted the join. The
 * failure modes are not symmetric:
 *
 *   - **No `orderBy`** ⇒ Postgres may hand back any row. If it picks a number whose
 *     token is dead, the WHOLE WABA reports unavailable while a healthy sibling
 *     sits beside it — and it does so non-deterministically, so it looks flaky
 *     rather than broken.
 *   - **No `isActive`** ⇒ a disconnected number can be chosen, which has no usable
 *     credentials at all.
 *   - **No join assertion** ⇒ if the connection→WABA FK and the resolved send
 *     config ever disagree, the read is authorized against a DIFFERENT WABA and
 *     the result is reported under this one's label. That breaks the §18 invariant
 *     that a WABA's data belongs to the WABA it came from or to nothing, and in
 *     `catalog-sync` it would prune one WABA's templates against another's
 *     catalog — silent, permanent data loss.
 *
 * Hence: the ordering lives here as one constant, and the two shapes callers
 * actually need are both provided. This module is deliberately tiny and holds no
 * business logic — it is a shared definition, not an abstraction layer.
 */

/**
 * Deterministic probe ordering for a Prisma query over a WABA's connections.
 *
 * Default number first — it is the one most likely to hold working credentials
 * and the one an operator would expect to be used — then oldest, so the choice is
 * stable across calls and across replicas. Pair it with `where: { isActive: true }`.
 */
// NOT `as const`: Prisma's generated `orderBy` input is a MUTABLE array type, so a
// readonly tuple is rejected at every call site.
export const WABA_PROBE_ORDER: Array<{ isDefault: "desc" } | { createdAt: "asc" }> = [
  { isDefault: "desc" },
  { createdAt: "asc" },
];

/** The minimum a caller must select for {@link pickWabaProbe} to order rows. */
export interface WabaProbeCandidate {
  isDefault: boolean;
  createdAt: Date;
}

/**
 * Same rule as {@link WABA_PROBE_ORDER}, for a caller that already holds the rows.
 *
 * The subscription-health sweeper fetches every connection once and groups them in
 * memory, so it cannot use a per-WABA `orderBy`. It used `find(isDefault) ?? [0]`,
 * which agrees with the DB rule on the default but falls back to an arbitrary row
 * when there is none — the same non-determinism, reached a different way.
 *
 * Returns `undefined` for an empty list: a WABA with no active numbers is a real,
 * documented state (Embedded Signup's `FINISH_ONLY_WABA`), and the caller decides
 * whether that is an error or just "nothing to read with".
 */
export function pickWabaProbe<T extends WabaProbeCandidate>(candidates: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const c of candidates) {
    if (!best) {
      best = c;
      continue;
    }
    if (c.isDefault !== best.isDefault) {
      if (c.isDefault) best = c;
      continue;
    }
    if (c.createdAt.getTime() < best.createdAt.getTime()) best = c;
  }
  return best;
}

/**
 * Does the credential bundle we resolved actually point at the WABA we are about
 * to read or write?
 *
 * `catalog-sync` has always asserted this before reconciling, with the reasoning
 * that pruning against the wrong catalog is silent permanent data loss. The same
 * risk applies to every WABA-scoped read that reports results under a WABA's
 * label — so the check is shared rather than re-derived.
 *
 * Returns null when the join is sound, or a human-readable reason when it is not.
 */
export function wabaProbeMismatch(
  config: { wabaAccountId?: string | null; wabaId?: string | null },
  expectedWabaAccountId: string,
): string | null {
  if (config.wabaAccountId === expectedWabaAccountId) return null;
  return `resolved credentials point at a different WABA (${config.wabaId ?? "none"})`;
}
