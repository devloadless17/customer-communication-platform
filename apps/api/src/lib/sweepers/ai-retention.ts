import { blobStorage } from "@/lib/blob-storage";
import { db } from "@/lib/db";
import { isPoolClosedError, withSweeperMutex } from "@/lib/sweepers/_mutex";

/**
 * Retention + orphan reclaim for the native AI Assistant subsystem.
 *
 * Every AI table cascades from Workspace, but its `conversationId` /
 * `messageId` is a PLAIN column with no FK — deliberately, so the subsystem can
 * be dropped without altering Conversation/Message/Customer (schema, "Native AI
 * Assistant subsystem"). The price of that seam is that NOTHING reclaimed these
 * rows when the conversation or message they describe went away, and nothing
 * aged out the append-only logs: they grew for the life of the tenant, and the
 * voice-draft objects with them (`ai-voice-draft/` is PREFIX-EXCLUDED in
 * blob-orphan, so that sweeper cannot be the backstop).
 *
 * WHAT IT DELETES — nothing else:
 *  1. `AiReplySuggestion` past `expiresAt` that is already RESOLVED (accepted /
 *     edited / rejected / superseded / expired), plus a PENDING draft whose
 *     expiry is older than the retention window. An expired draft is never
 *     offered (`unexpiredPendingWhere`) and cannot be sent (the accept CAS
 *     carries the expiry); a whole window past its 24h TTL, the one affordance
 *     left (an agent clearing a stale panel) is gone too. Its `audioR2Key`
 *     object is deleted FIRST — see BLOB ORDER below.
 *  2. `AiAssistantInteraction` older than the retention window, and
 *     `ConversationAutomationClaim` older than CLAIM_RETENTION_MS. Both are
 *     append-only bookkeeping written once per inbound message: the interaction
 *     log is observability/cost history, while a claim only arbitrates the
 *     seconds in which one inbound is answered — plus the redelivery window it
 *     dedupes (Meta retries within hours, BullMQ retries are bounded), which is
 *     why its window is days rather than the full retention horizon.
 *  3. Rows whose CONVERSATION no longer exists (`AiConversationState`,
 *     `ConversationSessionSummary`, `AiReplySuggestion`) and rows whose MESSAGE
 *     no longer exists (`AiMessageMetadata`, `AiMessageTranscription`). This is
 *     the orphan case the missing FK creates. Existence is answered by an id
 *     batch per page — never a correlated subquery, which would scan the whole
 *     table on every tick.
 *
 * WHAT IT NEVER DELETES:
 *  · anything whose conversation/message still exists and is inside the
 *    retention window. Age alone reaps only (2).
 *  · `AiMessageTranscription` / `AiMessageMetadata` by AGE. A transcript is the
 *    only readable form of a voice message that is STILL in the thread (nothing
 *    deletes Message rows), and the metadata row carries the `aiGenerated` loop
 *    guard plus the hallucination score the panel averages. Their lifecycle is
 *    their message's, so they go only when it does.
 *  · `ConversationSessionSummary` by age — the panel reads the most recent row
 *    per conversation, and on a dormant thread "most recent" is old by
 *    definition.
 *  · `AiCustomerMemory` — person-level, owned by the Customer (reaped with it in
 *    webchat-visitor-retention), never by a conversation's age.
 *  · `AiAssistantConfig` / `AiContextDocument` / `AiContextChunk` — configuration
 *    and knowledge; they have no age at all.
 *
 * BLOB ORDER. A voice draft's object is deleted BEFORE its row, and rows are
 * deleted only for keys we actually attempted: the opposite order strands the
 * object with nothing pointing at it, and because `ai-voice-draft/` is
 * prefix-excluded in blob-orphan nothing would ever reclaim it. That exclusion
 * SHOULD STAY — this sweeper owning the category is exactly why
 * `contact-exports/` is excluded there too. The alternative (teaching
 * blob-orphan to cross-check `audioR2Key`) buys a marginal leak path at the
 * price of the destructive direction: a wrong column name there deletes live
 * drafts on the next weekly tick.
 *
 * Cadence: daily, batched, bounded, quiet when nothing matches. Window tunable
 * via AI_RETENTION_DAYS (default 90). Boot slot 55min — 12/30/35/40/45/50 are
 * taken by the other daily sweepers.
 */

const SWEEP_INTERVAL_MS = 24 * 60 * 60_000;
const INITIAL_DELAY_MS = 55 * 60_000;
const DEFAULT_RETENTION_DAYS = 90;
/**
 * Claim rows age out far faster than the rest: one is written per INBOUND
 * MESSAGE (the fastest-growing AI table) and it is dead the moment its message
 * is answered. 14 days is well past every redelivery path it guards — Meta
 * retries a webhook for hours, BullMQ retries are bounded, and the outbox
 * drainer runs continuously.
 */
const CLAIM_RETENTION_MS = 14 * 24 * 60 * 60_000;
const MAX_PER_SWEEP = 5_000;
const MAX_BATCHES = 4;
/** Rows examined per orphan page, and pages per table per tick. */
const ORPHAN_PAGE = 1_000;
const ORPHAN_PAGES_PER_TICK = 4;

function retentionMs(): number {
  const raw = Number.parseInt(process.env.AI_RETENTION_DAYS ?? "", 10);
  const days = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RETENTION_DAYS;
  return days * 24 * 60 * 60_000;
}

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let inFlight = false;

/**
 * Per-table id cursor carried ACROSS ticks, the same reason blob-orphan and
 * contact-transfer-artifacts carry one: without it every tick re-reads the same
 * first `ORPHAN_PAGE` ids (almost always live rows) and an orphan sorting after
 * them is never reclaimed. Cleared when a page comes back short — the scan
 * wraps to the start of the table.
 */
const orphanCursors = new Map<string, string | undefined>();

interface OrphanScan {
  label: string;
  /** Which parent row's existence decides whether this row is an orphan. */
  parent: "conversation" | "message";
  page: (after: string | undefined) => Promise<Array<{ id: string; refId: string }>>;
  remove: (ids: string[]) => Promise<number>;
}

/**
 * Delete drafts and their pre-rendered voice preview, object first.
 *
 * `blobStorage.delete` is non-throwing by contract (r2.ts swallows provider
 * errors), so the try/catch is the belt on the braces: whatever the provider
 * does, a row is only removed once its object delete was attempted. Leaving a
 * blob leaked would be acceptable; leaving a row pointing at a live object we
 * never revisit would not be.
 */
async function deleteSuggestions(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db.aiReplySuggestion.findMany({
    where: { id: { in: ids } },
    select: { id: true, audioR2Key: true },
  });
  if (rows.length === 0) return 0;
  const keys = rows.map((r) => r.audioR2Key).filter((k): k is string => Boolean(k));
  if (keys.length > 0) {
    try {
      await blobStorage.delete(keys);
    } catch (err) {
      // Rows survive; the next tick retries the whole batch.
      console.error("[sweeper.ai-retention] voice-draft delete failed", err);
      return 0;
    }
  }
  const { count } = await db.aiReplySuggestion.deleteMany({
    where: { id: { in: rows.map((r) => r.id) } },
  });
  return count;
}

/**
 * A row must be at least this old before a missed parent lookup counts as an
 * orphan. The parent is always committed before the AI row that names it, so a
 * miss should mean deletion — but "should" is doing load-bearing work in a
 * sweeper whose failure mode is destroying a live row, and the cost of being
 * wrong is asymmetric: waiting a day to reclaim a row is free, deleting a row
 * whose parent was mid-write is not. `blob-orphan` keeps the same 24h floor for
 * the same reason.
 */
const ORPHAN_MIN_AGE_MS = 24 * 60 * 60_000;

/** Rows younger than the grace floor are not orphan candidates. */
function orphanAgeFloor(): Date {
  return new Date(Date.now() - ORPHAN_MIN_AGE_MS);
}

const ORPHAN_SCANS: OrphanScan[] = [
  {
    label: "ai-conversation-state",
    parent: "conversation",
    page: async (after) =>
      (
        await db.aiConversationState.findMany({
          where: {
            // `AiConversationState` has no `createdAt` — `updatedAt` is its only age
            // signal, and it is the right one anyway: the row is rewritten on every
            // state change, so "untouched for a day" is what the floor means here.
            updatedAt: { lt: orphanAgeFloor() },
            ...(after ? { id: { gt: after } } : {}),
          },
          select: { id: true, conversationId: true },
          orderBy: { id: "asc" },
          take: ORPHAN_PAGE,
        })
      ).map((r) => ({ id: r.id, refId: r.conversationId })),
    remove: async (ids) =>
      (await db.aiConversationState.deleteMany({ where: { id: { in: ids } } })).count,
  },
  {
    label: "conversation-session-summary",
    parent: "conversation",
    page: async (after) =>
      (
        await db.conversationSessionSummary.findMany({
          where: {
            createdAt: { lt: orphanAgeFloor() },
            ...(after ? { id: { gt: after } } : {}),
          },
          select: { id: true, conversationId: true },
          orderBy: { id: "asc" },
          take: ORPHAN_PAGE,
        })
      ).map((r) => ({ id: r.id, refId: r.conversationId })),
    remove: async (ids) =>
      (await db.conversationSessionSummary.deleteMany({ where: { id: { in: ids } } })).count,
  },
  {
    label: "ai-reply-suggestion",
    parent: "conversation",
    page: async (after) =>
      (
        await db.aiReplySuggestion.findMany({
          where: {
            createdAt: { lt: orphanAgeFloor() },
            ...(after ? { id: { gt: after } } : {}),
          },
          select: { id: true, conversationId: true },
          orderBy: { id: "asc" },
          take: ORPHAN_PAGE,
        })
      ).map((r) => ({ id: r.id, refId: r.conversationId })),
    // Voice preview goes with the row — same object-first path as the expiry pass.
    remove: deleteSuggestions,
  },
  {
    label: "ai-message-metadata",
    parent: "message",
    page: async (after) =>
      (
        await db.aiMessageMetadata.findMany({
          where: {
            createdAt: { lt: orphanAgeFloor() },
            ...(after ? { id: { gt: after } } : {}),
          },
          select: { id: true, messageId: true },
          orderBy: { id: "asc" },
          take: ORPHAN_PAGE,
        })
      ).map((r) => ({ id: r.id, refId: r.messageId })),
    remove: async (ids) =>
      (await db.aiMessageMetadata.deleteMany({ where: { id: { in: ids } } })).count,
  },
  {
    label: "ai-message-transcription",
    parent: "message",
    page: async (after) =>
      (
        await db.aiMessageTranscription.findMany({
          where: {
            createdAt: { lt: orphanAgeFloor() },
            ...(after ? { id: { gt: after } } : {}),
          },
          select: { id: true, messageId: true },
          orderBy: { id: "asc" },
          take: ORPHAN_PAGE,
        })
      ).map((r) => ({ id: r.id, refId: r.messageId })),
    remove: async (ids) =>
      (await db.aiMessageTranscription.deleteMany({ where: { id: { in: ids } } })).count,
  },
];

/**
 * Rows whose parent is gone. The parent lookup is by PRIMARY KEY on an id the
 * AI row itself recorded — ids are globally-unique cuids, so no tenancy
 * question arises and a missing id can only mean the parent was deleted (the
 * conversation/message is always written before the AI row that names it).
 */
async function sweepOrphans(scan: OrphanScan): Promise<number> {
  let removed = 0;
  for (let i = 0; i < ORPHAN_PAGES_PER_TICK; i++) {
    const rows = await scan.page(orphanCursors.get(scan.label));
    if (rows.length === 0) {
      orphanCursors.set(scan.label, undefined); // listing exhausted — wrap
      break;
    }
    orphanCursors.set(scan.label, rows[rows.length - 1]!.id);

    const refIds = [...new Set(rows.map((r) => r.refId))];
    const alive = new Set(
      (scan.parent === "conversation"
        ? await db.conversation.findMany({ where: { id: { in: refIds } }, select: { id: true } })
        : await db.message.findMany({ where: { id: { in: refIds } }, select: { id: true } })
      ).map((r) => r.id),
    );
    const dead = rows.filter((r) => !alive.has(r.refId)).map((r) => r.id);
    if (dead.length > 0) removed += await scan.remove(dead);

    if (rows.length < ORPHAN_PAGE) {
      orphanCursors.set(scan.label, undefined);
      break;
    }
  }
  return removed;
}

/** Batched delete-by-age, the shape every sibling retention sweeper uses. */
async function sweepAged(
  find: (take: number) => Promise<Array<{ id: string }>>,
  remove: (ids: string[]) => Promise<number>,
): Promise<number> {
  let removed = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const rows = await find(MAX_PER_SWEEP);
    if (rows.length === 0) break;
    const count = await remove(rows.map((r) => r.id));
    removed += count;
    if (count === 0 || rows.length < MAX_PER_SWEEP) break;
  }
  return removed;
}

async function sweepExpiredSuggestions(cutoff: Date): Promise<number> {
  const now = new Date();
  return sweepAged(
    (take) =>
      db.aiReplySuggestion.findMany({
        where: {
          OR: [
            { state: { not: "pending" }, expiresAt: { lt: now } },
            // A pending draft that lapsed longer ago than the whole retention
            // window: not offerable, not sendable, and the last affordance it
            // had (an agent clearing a stale panel) is months gone.
            { state: "pending", expiresAt: { lt: cutoff } },
          ],
        },
        select: { id: true },
        take,
      }),
    deleteSuggestions,
  );
}

/** Exported for tests, matching the sibling sweepers' convention. */
export async function sweepAiRetentionOnce(): Promise<void> {
  const cutoff = new Date(Date.now() - retentionMs());

  const suggestions = await sweepExpiredSuggestions(cutoff);
  const interactions = await sweepAged(
    (take) =>
      db.aiAssistantInteraction.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { id: true },
        take,
      }),
    async (ids) =>
      (await db.aiAssistantInteraction.deleteMany({ where: { id: { in: ids } } })).count,
  );
  const claimCutoff = new Date(Date.now() - CLAIM_RETENTION_MS);
  const claims = await sweepAged(
    (take) =>
      db.conversationAutomationClaim.findMany({
        where: { claimedAt: { lt: claimCutoff } },
        select: { id: true },
        take,
      }),
    async (ids) =>
      (await db.conversationAutomationClaim.deleteMany({ where: { id: { in: ids } } })).count,
  );

  let orphans = 0;
  for (const scan of ORPHAN_SCANS) orphans += await sweepOrphans(scan);

  const total = suggestions + interactions + claims + orphans;
  if (total > 0) {
    console.log(
      `[sweeper.ai-retention] removed ${total} row(s): ${suggestions} draft(s), ` +
        `${interactions} interaction(s), ${claims} claim(s), ${orphans} orphan(s) ` +
        `(window ${retentionMs() / 86_400_000}d)`,
    );
  }
}

async function runTick(label: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await withSweeperMutex("ai-retention", sweepAiRetentionOnce);
  } catch (err) {
    // Pool already ended (dev hot-reload / shutdown) — the work is over.
    if (isPoolClosedError(err)) {
      stopAiRetentionSweeper();
      return;
    }
    console.error(`[sweeper.ai-retention] ${label} failed`, err);
  } finally {
    inFlight = false;
  }
}

export function startAiRetentionSweeper(): void {
  if (timer || initialTimer) return;
  initialTimer = setTimeout(() => {
    initialTimer = null;
    void runTick("initial sweep");
    timer = setInterval(() => {
      void runTick("sweep");
    }, SWEEP_INTERVAL_MS);
    timer.unref?.();
  }, INITIAL_DELAY_MS);
  initialTimer.unref?.();
}

export function stopAiRetentionSweeper(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
