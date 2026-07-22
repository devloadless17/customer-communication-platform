import type { PrismaClient } from "@prisma/client";

import type {
  BroadcastAssignmentLeftover,
  BroadcastAssignmentMode,
  BroadcastAssignmentSplitEntry,
} from "@ccp/shared/assignment/types";

import { buildPolicyPool } from "./pool";

/**
 * Campaign assignment planning.
 *
 * A broadcast asks a very different question from an inbound conversation.
 * Inbound is "who should take THIS one, given who's online right now". A
 * campaign is "divide these 10,000 replies among my team the way I said" —
 * decided once, up front, for the whole audience.
 *
 * So the draw happens at MATERIALIZE time (when BroadcastRecipient rows are
 * built) and is stored on the row. Three properties fall out of that, and all
 * three are why it isn't done per-send:
 *
 *   EXACT. "First 50 to Ali, next 10 to Sara" means exactly 50 and exactly 10.
 *   A per-send draw against live capacity could never promise that.
 *
 *   IDEMPOTENT. A resumed, retried or partially-failed campaign reuses the
 *   draw already on the row instead of redistributing — so a Redis blip can't
 *   silently re-weight a campaign mid-flight.
 *
 *   CHEAP. One policy read for the whole campaign instead of 10,000. At the
 *   100k ceiling a per-recipient `resolveAssignee` would be 100k groupBy
 *   queries; this is one.
 *
 * WHEN the draw is applied is a separate decision (`Broadcast.assignmentTrigger`):
 * by default on the customer's FIRST REPLY (`lib/assignment/campaign-reply.ts`),
 * because a campaign is mostly one-way and assigning all 10,000 recipients would
 * bury agents in conversations nobody will answer while poisoning the
 * open-conversation counts that capacity limits and least-busy routing read.
 * `on_send` applies it in the runner right after a successful send. Either way
 * it goes through the shared `assignConversation` mutation, so a campaign that
 * fails to deliver never assigns anyone work that doesn't exist.
 */

type Db = Pick<PrismaClient, "user" | "conversation" | "assignmentPolicy" | "assignmentPolicyMember">;

export interface BroadcastAssignmentConfig {
  mode: BroadcastAssignmentMode;
  assignmentUserId: string | null;
  assignmentPolicyId: string | null;
  assignmentSplit: unknown;
  assignmentLeftover: string;
}

/** Narrow the `assignmentSplit` JSON column. Malformed entries are dropped
 *  rather than throwing — a campaign must still send if its split is corrupt;
 *  it just won't assign. */
export function parseSplit(raw: unknown): BroadcastAssignmentSplitEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: BroadcastAssignmentSplitEntry[] = [];
  for (const r of raw) {
    if (r && typeof r === "object" && !Array.isArray(r)) {
      const o = r as { userId?: unknown; value?: unknown };
      if (typeof o.userId === "string" && o.userId && typeof o.value === "number") {
        const value = Math.floor(o.value);
        if (Number.isFinite(value) && value > 0) out.push({ userId: o.userId, value });
      }
    }
  }
  return out;
}

/**
 * Largest-remainder apportionment: split `total` across `weights` so the parts
 * sum to EXACTLY `total`.
 *
 * Naive rounding is what makes percentage splits embarrassing — 3 people at
 * 33.3% of 10 rounds to 3+3+3 and silently drops a recipient. Largest remainder
 * hands the leftovers to whoever was rounded down hardest, ties by index so the
 * result is deterministic and reproducible in a test.
 */
export function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || sum <= 0) return weights.map(() => 0);

  const exact = weights.map((w) => (total * w) / sum);
  const base = exact.map((x) => Math.floor(x));
  let remaining = total - base.reduce((a, b) => a + b, 0);

  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  for (let k = 0; remaining > 0 && k < order.length; k++, remaining--) {
    base[order[k]!.i] = base[order[k]!.i]! + 1;
  }
  return base;
}

/**
 * Interleave a per-user allocation into a per-recipient list, spreading each
 * user's share evenly across the whole audience rather than in one block.
 *
 * This matters for a campaign that gets canceled or paused halfway: with block
 * allocation the first agent would have taken everything and the last would
 * have taken nothing. Interleaved, any prefix of the audience is already
 * proportional. Uses the same deficit rule as the weighted live strategy, so
 * "50/20" means the same thing in both places.
 */
function interleave(counts: { userId: string; count: number }[], total: number): (string | null)[] {
  const out: (string | null)[] = [];
  const state = counts
    .filter((c) => c.count > 0)
    .map((c) => ({ userId: c.userId, remaining: c.count, served: 0, share: c.count }));
  const totalShare = state.reduce((s, c) => s + c.share, 0);
  if (totalShare === 0) return new Array<string | null>(total).fill(null);

  for (let i = 0; i < total; i++) {
    let best: (typeof state)[number] | null = null;
    let bestRatio = Number.POSITIVE_INFINITY;
    for (const s of state) {
      if (s.remaining <= 0) continue;
      const ratio = s.served / s.share;
      if (ratio < bestRatio) {
        bestRatio = ratio;
        best = s;
      }
    }
    if (!best) {
      // Allocations exhausted before the audience — the remainder is unassigned
      // (exact-count splits reach here by design).
      out.push(null);
      continue;
    }
    best.remaining -= 1;
    best.served += 1;
    out.push(best.userId);
  }
  return out;
}

export interface BroadcastAssignmentPlan {
  /** `assignedUserId` for recipient N, in the order recipients were resolved. */
  perRecipient: (string | null)[];
  /** For the campaign summary UI / logs: how many each member drew. */
  totals: { userId: string; count: number }[];
}

/**
 * Build the plan. `total` is the recipient count; the returned array is
 * positionally aligned with the caller's recipient list.
 *
 * Every mode validates its target users against the team's ACTIVE roster
 * first — a campaign configured last month naming someone who has since left
 * quietly drops to "unassigned" for that share rather than writing an
 * unusable id onto thousands of rows.
 */
export async function buildBroadcastAssignmentPlan(args: {
  db: Db;
  workspaceId: string;
  total: number;
  config: BroadcastAssignmentConfig;
}): Promise<BroadcastAssignmentPlan> {
  const { db, workspaceId, total, config } = args;
  const empty: BroadcastAssignmentPlan = {
    perRecipient: new Array<string | null>(Math.max(0, total)).fill(null),
    totals: [],
  };
  if (total <= 0 || config.mode === "none") return empty;

  const activeIds = new Set(
    (
      await db.user.findMany({
        where: { workspaceMemberships: { some: { workspaceId } }, deactivatedAt: null },
        select: { id: true },
      })
    ).map((u) => u.id),
  );

  // ---- fixed -------------------------------------------------------------
  if (config.mode === "fixed") {
    const userId = config.assignmentUserId;
    if (!userId || !activeIds.has(userId)) return empty;
    return {
      perRecipient: new Array<string | null>(total).fill(userId),
      totals: [{ userId, count: total }],
    };
  }

  // ---- policy ------------------------------------------------------------
  // Resolve the policy's candidate pool ONCE and apportion the audience across
  // it, rather than running the live picker per recipient. The strategy still
  // decides the shape: `weighted` splits by weight, everything else splits
  // evenly (which is what round-robin/least-busy converge to over a whole
  // campaign anyway — capacity is meaningless for work that hasn't arrived yet).
  if (config.mode === "policy") {
    const pool = await buildPolicyPool({
      db,
      workspaceId,
      policyId: config.assignmentPolicyId,
    });
    if (pool.length === 0) return empty;
    const weights = pool.map((m) => (m.weighted ? Math.max(0, m.weight) : 1));
    const counts = apportion(total, weights).map((count, i) => ({
      userId: pool[i]!.userId,
      count,
    }));
    return { perRecipient: interleave(counts, total), totals: counts.filter((c) => c.count > 0) };
  }

  // ---- splits ------------------------------------------------------------
  const entries = parseSplit(config.assignmentSplit).filter((e) => activeIds.has(e.userId));
  if (entries.length === 0) return empty;

  if (config.mode === "split_percent") {
    const counts = apportion(
      total,
      entries.map((e) => e.value),
    ).map((count, i) => ({ userId: entries[i]!.userId, count }));
    return { perRecipient: interleave(counts, total), totals: counts.filter((c) => c.count > 0) };
  }

  // split_counts — literal caps, in the admin's stated order. "First 50 to
  // Ali" is exactly that, and an over-subscribed split (the counts exceed the
  // audience) is truncated in order rather than scaled, because the admin's
  // first entries are the ones they meant most.
  let remaining = total;
  const counts = entries.map((e) => {
    const count = Math.min(e.value, remaining);
    remaining -= count;
    return { userId: e.userId, count };
  });

  const perRecipient = interleave(counts, total);

  // Leftover handling: recipients past the last count. `policy` runs the team's
  // routing over the remainder so nothing is silently ownerless on a campaign
  // whose split under-covers the audience.
  const leftover = config.assignmentLeftover as BroadcastAssignmentLeftover;
  if (remaining > 0 && leftover === "policy") {
    const pool = await buildPolicyPool({ db, workspaceId, policyId: config.assignmentPolicyId });
    if (pool.length > 0) {
      const weights = pool.map((m) => (m.weighted ? Math.max(0, m.weight) : 1));
      const extra = apportion(remaining, weights).map((count, i) => ({
        userId: pool[i]!.userId,
        count,
      }));
      const fill = interleave(extra, remaining);
      let f = 0;
      for (let i = 0; i < perRecipient.length && f < fill.length; i++) {
        if (perRecipient[i] === null) perRecipient[i] = fill[f++]!;
      }
      for (const e of extra) {
        const found = counts.find((c) => c.userId === e.userId);
        if (found) found.count += e.count;
        else counts.push(e);
      }
    }
  }

  return { perRecipient, totals: counts.filter((c) => c.count > 0) };
}
