import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { createOutboundMessageIdempotent } from "@/lib/messages/idempotent-create";
import { getProviderBinding } from "@/lib/providers";
import { ProviderNotConfiguredError } from "@/lib/providers/config";
import {
  countTemplatePlaceholders,
  MetaSendError,
  normalizeMetaSendError,
  renderTemplateBody,
} from "@/lib/providers/meta";
import type { MessagingProvider } from "@ccp/shared/providers/types";
import type { Channel } from "@ccp/shared/types";

/**
 * Broadcasts send pre-approved WhatsApp templates, so they're bound to the
 * Meta channel by definition — templates are a Meta capability and the
 * recipient destination is a phone number. A future "broadcast over Telegram"
 * would be its own feature (different message shape, no template catalog), not
 * a per-recipient channel resolution here. Routed through the registry so the
 * provider/config indirection is uniform with the per-contact send paths.
 */
const BROADCAST_CHANNEL: Channel = "whatsapp";
import {
  parseVariableBindings,
  resolveBinding,
  type VariableBindings,
} from "@ccp/shared/template-bindings";
import { resolveFieldTokens } from "@ccp/shared/field-tokens";
import type { Message } from "@ccp/shared/types";

/**
 * Every emit in this file goes through the bus (`publish(...)`). Four event
 * types are involved:
 *
 *   1. `broadcast.status_changed` + `broadcast.progress` — lifecycle /
 *      progress ticks. socket-fanout handles the wire emit; outbound-webhooks
 *      will subscribe here once shipped.
 *
 *   2. `broadcast.recipient_message_sent` + `broadcast.conversation_reopened` —
 *      per-recipient `message:new` and per-recipient closed-thread reopen.
 *      Modeled as DEDICATED event types instead of reusing `message.sent` /
 *      `conversation.status_changed` so the analytics + audit subscribers
 *      stay out: a 1k-recipient broadcast must not bump outgoing-message
 *      counters or write 1k timeline rows. Only socket-fanout subscribes to
 *      these two types — suppression is structural, not a runtime flag.
 */

/**
 * Broadcast iteration runner.
 *
 *   1) Atomically claim the broadcast (`queued` → `running`) — bails if some
 *      other runner already won, so two concurrent POSTs / a retry can't
 *      double-send.
 *   2) For each recipient (status=queued), in order:
 *        a) Resolve / create the contact's most recent non-closed conversation.
 *        b) Call provider.sendTemplate. If this throws, the recipient is
 *           marked `failed` and we move on. If it SUCCEEDS, we immediately
 *           CAS-flip the recipient to `sent` so a later DB hiccup can never
 *           re-send (Meta has already charged us).
 *        c) Best-effort: insert the Message row + bump the conversation +
 *           emit `message:new`. Failures here are LOGGED, not propagated —
 *           the recipient is already `sent`, the message went out.
 *   3) Stamp `completed` / `failed`, emit `broadcast:status`.
 *
 * Fire-and-forget: callers POST to `/api/broadcasts` which kicks this off via
 * `setImmediate` so the HTTP response returns immediately with the new id.
 *
 * Tradeoff: this runs in-process in the NestJS api. A boot reconciler flips
 * orphaned `running` rows to `failed` so a restart mid-broadcast doesn't
 * leave them dangling — but in-flight Meta sends from the dead process are
 * not retried (we don't know if they landed).
 *
 * Rate: SEND_CONCURRENCY workers, each leaving a 200ms gap between its
 * own sends → ~25 msg/sec aggregate, well under Meta's 80 msg/sec hard cap.
 * Earlier versions were single-threaded at ~5/sec, which made a 1k-recipient
 * broadcast take ~3 minutes; concurrency cuts that to under a minute without
 * risking rate-limit responses.
 */

const SEND_GAP_MS = 200;
const SEND_CONCURRENCY = 5;
/**
 * Hard cap on recipients processed in-process. CLAUDE.md notes the
 * scaling cliff at ~10k: the recipients list is loaded into memory once at
 * the top of `runBroadcast`, and the worker pool holds per-task closures.
 * Past this size, move to a separate worker / BullMQ. Enforce here so a
 * config drift (audience-group blow-up, accidental "send to all") can't
 * OOM the Next.js server.
 */
export const MAX_RECIPIENTS_IN_PROCESS = 10_000;

/**
 * Per-broadcast 429 streak tracking. Keyed by broadcast id; bumped on
 * each rate_limited send; the 30s window decays it, and it's reset after
 * the pause fires and at run end. The map is bounded — both this and
 * PAUSE_429 are deleted when the broadcast completes / fails (the
 * `reset429Streak` + `PAUSE_429.delete` pair after the lane loop drains).
 * Worst case: an aborted process leaves stale entries; the
 * orphan reconciler at boot doesn't touch this in-memory map, but it
 * grows-bounded with one entry per concurrent broadcast (at MAX_RECIPIENTS
 * = 10k and one running broadcast at a time, the map holds 1 entry).
 */
const STREAK_429: Map<string, { count: number; firstAt: number }> = new Map();
const STREAK_429_WINDOW_MS = 30_000;
function track429Hit(broadcastId: string): void {
  const now = Date.now();
  const cur = STREAK_429.get(broadcastId);
  if (!cur || now - cur.firstAt > STREAK_429_WINDOW_MS) {
    STREAK_429.set(broadcastId, { count: 1, firstAt: now });
    return;
  }
  cur.count += 1;
}
function rate429Streak(broadcastId: string): number {
  return STREAK_429.get(broadcastId)?.count ?? 0;
}
function reset429Streak(broadcastId: string): void {
  STREAK_429.delete(broadcastId);
}

/**
 * Cross-lane 429 backoff. When one lane sees the streak cross the threshold it
 * stamps a deadline here; EVERY lane checks it at the top of its loop and sleeps
 * out the remainder before pulling the next recipient. Without this the pause
 * only stopped the single lane that observed the streak while the other lanes
 * kept sending into the rate limit (draining the number's quality rating).
 */
const PAUSE_429_MS = 60_000;
const PAUSE_429: Map<string, number> = new Map();
function pauseAllLanes(broadcastId: string, ms: number): void {
  PAUSE_429.set(broadcastId, Date.now() + ms);
}
function lanePauseRemaining(broadcastId: string): number {
  const until = PAUSE_429.get(broadcastId);
  if (until === undefined) return 0;
  const remaining = until - Date.now();
  if (remaining <= 0) {
    PAUSE_429.delete(broadcastId);
    return 0;
  }
  return remaining;
}

interface BroadcastVariables {
  body: string[];
  header?: string;
}

/**
 * Process-wide shutdown coordination for in-flight broadcasts.
 *
 * The runner can't use NestJS lifecycle hooks directly (this is a
 * framework-agnostic lib module), so the NestJS wrapper
 * (`BroadcastsService.onModuleDestroy`) calls into these helpers.
 *
 * Mechanism:
 *   1. `shuttingDown` flag — each running lane checks it between recipients
 *      and exits the loop cleanly (without marking the row as `failed`).
 *   2. `inFlightRuns` — tracks the top-level `runBroadcast(id)` promises so
 *      the wrapper can `Promise.allSettled` them before the api process
 *      exits. Critical: returning from this means every lane has finished
 *      its current recipient (Meta call + DB write), so the next process
 *      restart can resume from the next `queued` row safely.
 */
let shuttingDown = false;
const inFlightRuns = new Map<string, Promise<void>>();

/**
 * Per-team concurrent-broadcast cap — the broadcast-runner's analogue of the
 * workflow worker's per-team gate (lib/workflows/worker.ts). Each running
 * broadcast spins up its OWN pool of SEND_CONCURRENCY lanes, so without a
 * ceiling one team firing several broadcasts at once (API + scheduled-send
 * worker + boot resume can all kick off concurrently) would multiply lanes,
 * blow past Meta's per-number rate budget, and let one team's burst crowd out
 * every other team's sends. With the gate, a team already at cap leaves the
 * extra broadcast in `queued` — the scheduled-broadcast worker + the
 * deferred-retry below re-pick it once a slot frees, so nothing is dropped.
 *
 * Tunable via BROADCAST_PER_TEAM_CONCURRENCY (default 2). Single-process only;
 * cross-process fairness would need Redis counters (deferred — pilot is one
 * process). Keyed by teamId; the entry is dropped when the team goes idle so
 * the Map stays bounded.
 */
function perTeamBroadcastConcurrency(): number {
  const raw = Number.parseInt(
    process.env.BROADCAST_PER_TEAM_CONCURRENCY ?? "2",
    10,
  );
  return Number.isFinite(raw) && raw > 0 && raw <= 50 ? raw : 2;
}

/** Delay before a team-at-cap broadcast retries its slot claim. */
const BROADCAST_TEAM_BUSY_DEFER_MS = 5_000;

const broadcastTeamSlots = new Map<string, { active: number }>();

function tryAcquireBroadcastTeamSlot(teamId: string): boolean {
  const cap = perTeamBroadcastConcurrency();
  let entry = broadcastTeamSlots.get(teamId);
  if (!entry) {
    entry = { active: 0 };
    broadcastTeamSlots.set(teamId, entry);
  }
  if (entry.active >= cap) return false;
  entry.active += 1;
  return true;
}

function releaseBroadcastTeamSlot(teamId: string): void {
  const entry = broadcastTeamSlots.get(teamId);
  if (!entry) return;
  entry.active = Math.max(0, entry.active - 1);
  if (entry.active === 0) broadcastTeamSlots.delete(teamId);
}

export function signalShutdown(): void {
  shuttingDown = true;
}

/**
 * Snapshot of in-flight runs at call time, for the wrapper to await. Returned
 * as an array of Promises so caller can race them against a timeout budget.
 */
export function getInFlightRunPromises(): Promise<void>[] {
  return Array.from(inFlightRuns.values());
}

/**
 * Test/restart helper — clear the in-process shutdown flag so subsequent
 * `startBroadcast()` calls actually run. Called by the boot reconciler so
 * a worker that signaled shutdown and is now starting fresh can accept
 * resumes.
 */
export function resetShutdownFlag(): void {
  shuttingDown = false;
}

export async function startBroadcast(broadcastId: string): Promise<void> {
  // If we're mid-shutdown, refuse to start fresh runners — the caller (REST
  // controller) will surface a 503 to the user and the broadcast stays in
  // `queued` until the next boot reconciler picks it up.
  if (shuttingDown) {
    console.warn(
      `[broadcast ${broadcastId}] refused to start: process is shutting down`,
    );
    return;
  }

  // Already running in this process (e.g. a duplicate kick from API + the
  // scheduled worker) — don't double-claim a team slot or spawn a second
  // lane pool. The CAS claim in runBroadcast also guards this, but bailing
  // here avoids the wasted teamId lookup + slot churn.
  if (inFlightRuns.has(broadcastId)) return;

  // Per-team concurrency gate. Resolve the owning team cheaply (PK lookup,
  // teamId only) so we can cap concurrent broadcasts per team.
  const owner = await db.broadcast.findUnique({
    where: { id: broadcastId },
    select: { teamId: true, status: true },
  });
  if (!owner) {
    console.warn(`[broadcast ${broadcastId}] not found at start`);
    return;
  }
  // Only `queued` rows are runnable; anything else is already claimed /
  // terminal and runBroadcast would bail anyway.
  if (owner.status !== "queued") return;

  if (!tryAcquireBroadcastTeamSlot(owner.teamId)) {
    // Team at its concurrent-broadcast cap. Leave the row `queued` and
    // re-attempt shortly — the slot frees when one of the team's running
    // broadcasts finishes. (The scheduled-broadcast worker is a second
    // safety net for `queued` rows.) unref so this timer can't hold the
    // process open during shutdown.
    setTimeout(() => {
      if (!shuttingDown) void startBroadcast(broadcastId);
    }, BROADCAST_TEAM_BUSY_DEFER_MS).unref();
    return;
  }

  // Fire-and-forget — the caller doesn't await this; we explicitly catch so
  // the unhandled rejection doesn't crash the server.
  const run = runBroadcast(broadcastId)
    .catch((err) => {
      console.error(`[broadcast ${broadcastId}] runner crashed`, err);
    })
    .finally(() => {
      inFlightRuns.delete(broadcastId);
      releaseBroadcastTeamSlot(owner.teamId);
    });
  inFlightRuns.set(broadcastId, run);
}

async function runBroadcast(broadcastId: string): Promise<void> {
  // Read the broadcast metadata WITHOUT loading recipients — for a 10k
  // broadcast the include + contact + customFields JSONB used to land
  // ~20MB on the heap before the cap check even ran. Recipients are
  // page-loaded below via cursor instead.
  const broadcast = await db.broadcast.findUnique({
    where: { id: broadcastId },
  });

  if (!broadcast) {
    console.warn(`[broadcast ${broadcastId}] not found at start`);
    return;
  }
  if (broadcast.status !== "queued") {
    // Already claimed by another runner / completed / explicitly failed —
    // never restart it from here. The reconciler on boot is the only thing
    // that revives `running` rows (by failing them).
    return;
  }

  // Cap-check via count — bound the broadcast's blast radius before any
  // recipient row is loaded. count() is cheap (index scan).
  const queuedCount = await db.broadcastRecipient.count({
    where: { broadcastId: broadcast.id, status: "queued" },
  });
  if (queuedCount > MAX_RECIPIENTS_IN_PROCESS) {
    await fail(
      broadcast.id,
      `Broadcast too large for in-process send: ${queuedCount} recipients (cap ${MAX_RECIPIENTS_IN_PROCESS}). Split the audience or move to a worker.`,
    );
    return;
  }

  const binding = getProviderBinding(BROADCAST_CHANNEL);
  let config;
  try {
    config = await binding.getSendConfig(broadcast.teamId);
  } catch (err) {
    const msg =
      err instanceof ProviderNotConfiguredError
        ? `WhatsApp not connected: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    await fail(broadcast.id, msg);
    return;
  }

  const provider = binding.provider;
  if (!provider.sendTemplate) {
    await fail(broadcast.id, "provider does not support templates");
    return;
  }

  const variables = parseVariables(broadcast.variables);
  // Hoist what doesn't change between recipients: the template body (for the
  // placeholder count + DB-side rendering preview) and its variable bindings.
  // Bindings define WHICH variables are pulled per-recipient and which use
  // the broadcast's literal value (the legacy "same for everyone" path).
  const template = await loadTemplate(broadcast.teamId, broadcast.templateId);
  const templateBody = template.bodyText;
  const bindings = parseVariableBindings(template.variableBindings);
  const bodyVarCount = countTemplatePlaceholders(templateBody);
  if (variables.body.length !== bodyVarCount) {
    await fail(
      broadcast.id,
      `Variable count mismatch: template expects ${bodyVarCount}, broadcast has ${variables.body.length}. Template may have changed since the broadcast was created.`,
    );
    return;
  }

  // Compare-and-swap: claim the broadcast atomically. If two POSTs raced (or
  // a retry fired before the first finished), only one of them flips
  // `queued` → `running`; the other sees `count === 0` and bails out without
  // sending a single message.
  //
  // Resume case: the boot reconciler flips `paused` → `queued` and re-fires
  // startBroadcast, so by the time we get here a previously-paused broadcast
  // is `queued` again and the same CAS picks it up. No special-case needed.
  const claimed = await db.broadcast.updateMany({
    where: { id: broadcast.id, status: "queued" },
    data: { status: "running", startedAt: new Date() },
  });
  if (claimed.count === 0) return;

  await publish({
    type: "broadcast.status_changed",
    teamId: broadcast.teamId,
    broadcastId: broadcast.id,
    status: "running",
  });

  // Worker-pool: SEND_CONCURRENCY workers pull from a single in-memory
  // queue that's continuously refilled from a paginated DB cursor. Page
  // size is small (PAGE_SIZE) so peak heap stays bounded even on a 10k
  // broadcast — only ~PAGE_SIZE * 2 contact rows live in memory at any
  // moment (current page + a refill prefetch). Each worker waits
  // SEND_GAP_MS after its own send before grabbing the next, so global
  // throughput is bounded by (workers ÷ gap) and Meta never sees a
  // thundering herd from a single broadcast.
  //
  // Counter bumps inside processOneRecipient fire-and-forget so the DB
  // roundtrip doesn't serialize with the next recipient's send. We track
  // their promises in `pendingBumps` so we can drain them before flipping
  // the broadcast to `completed` — otherwise a UI watching for the status
  // change can briefly observe sentCount + failedCount < totalCount.
  const PAGE_SIZE = 100;
  const broadcastId_ = broadcast.id; // capture for the refill closure (TS can't
  // narrow `broadcast` through the closure boundary).
  // Select only the recipient + contact fields the send path actually reads.
  // Without this, every page drags every Contact column (incl. customFields
  // JSONB) for every recipient — at 10k recipients this dominates the
  // broadcast's DB cost. Keep in sync with resolvePerRecipientVariables +
  // resolveBinding's ContactLike (name/phoneNumber/email/location/customFields).
  const RECIPIENT_SELECT = {
    id: true,
    contactId: true,
    status: true,
    contact: {
      select: {
        id: true,
        name: true,
        phoneNumber: true,
        email: true,
        location: true,
        customFields: true,
      },
    },
  } as const;

  type Recipient = Awaited<
    ReturnType<typeof db.broadcastRecipient.findMany<{
      where: { broadcastId: string; status: "queued" };
      select: typeof RECIPIENT_SELECT;
      orderBy: { id: "asc" };
      take: typeof PAGE_SIZE;
    }>>
  >[number];
  const pendingBumps = new Set<Promise<unknown>>();
  const queue: Recipient[] = [];
  let cursorId: string | undefined;
  let exhausted = false;

  async function refill(): Promise<void> {
    if (exhausted) return;
    const page = await db.broadcastRecipient.findMany({
      where: { broadcastId: broadcastId_, status: "queued" },
      select: RECIPIENT_SELECT,
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });
    if (page.length === 0) {
      exhausted = true;
      return;
    }
    cursorId = page[page.length - 1]!.id;
    queue.push(...page);
  }

  await refill();
  const lanes = Math.min(SEND_CONCURRENCY, queue.length);

  // Cooperative cancel — operators flip the broadcast row to `canceled`
  // via POST /api/broadcasts/:id/cancel; the lanes check this flag at the
  // top of every iteration. Recipients already sent stay sent (Meta can't
  // be unsent); the loop simply stops pulling more queued rows.
  //
  // Cancel polling is rate-limited to CANCEL_POLL_MS (every ~2s) — the cancel
  // signal lives in-memory and the DB read only refreshes the cache when the
  // window expires. Without the cache, a 10k-recipient broadcast issued one
  // SELECT per recipient × 5 lanes = ~10k extra DB round-trips that bought
  // sub-200ms cancel responsiveness no operator needed.
  const CANCEL_POLL_MS = 2_000;
  let canceled = false;
  let lastCancelPollAt = 0;
  async function checkCanceled(): Promise<boolean> {
    if (canceled) return true;
    const now = Date.now();
    if (now - lastCancelPollAt < CANCEL_POLL_MS) return false;
    lastCancelPollAt = now;
    const row = await db.broadcast.findUnique({
      where: { id: broadcastId_ },
      select: { status: true },
    });
    if (row?.status === "canceled") {
      canceled = true;
    }
    return canceled;
  }

  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (true) {
        if (await checkCanceled()) return;
        // Graceful-shutdown check: the NestJS wrapper signals shutdown
        // before awaiting in-flight runs. Each lane exits the loop here,
        // which means the current recipient (if any was already started
        // above) finished its Meta call + DB write before we return.
        // Anything not yet pulled stays in `queued` for the next process's
        // boot reconciler to resume.
        if (shuttingDown) return;
        // Honor a cross-lane 429 backoff set by any lane (see pauseAllLanes).
        // Sleeping here, before pulling the next recipient, is what makes the
        // pause global instead of single-lane.
        const pauseMs = lanePauseRemaining(broadcast.id);
        if (pauseMs > 0) await sleep(pauseMs);
        if (queue.length === 0) {
          await refill();
          if (queue.length === 0) return;
        }
        const recipient = queue.shift();
        if (!recipient) return;
        await processOneRecipient(
          broadcast,
          recipient,
          provider,
          config,
          bindings,
          variables,
          templateBody,
          pendingBumps,
        );
        if (SEND_GAP_MS > 0) await sleep(SEND_GAP_MS);
      }
    }),
  );

  // Drain any in-flight bumps before stamping completed. allSettled because
  // individual bump failures are already logged inside the wrapper — we just
  // want to wait for resolution, not surface the errors twice.
  if (pendingBumps.size > 0) {
    await Promise.allSettled(pendingBumps);
  }

  // Drop the 429 state so neither Map grows across many broadcasts.
  reset429Streak(broadcast.id);
  PAUSE_429.delete(broadcast.id);

  // Flush any pending throttled progress emit + drop the throttle entry so
  // the Map doesn't grow unbounded across many broadcasts. Without this the
  // UI might miss the final progress emit (if the trailing timer hadn't
  // fired by the time we mark completed).
  const throttle = progressThrottles.get(broadcast.id);
  if (throttle) {
    if (throttle.pendingTimer) {
      clearTimeout(throttle.pendingTimer);
      throttle.pendingTimer = null;
    }
    emitProgress(broadcast.id, throttle.latest);
    progressThrottles.delete(broadcast.id);
  }

  // Three possible exits from the lane loop:
  //   1. canceled by operator → cancel endpoint owns the status emit.
  //   2. shuttingDown (graceful drain) → flip `running` → `paused`. Boot
  //      reconciler on the next process will flip back to `queued` and call
  //      startBroadcast(); recipient CAS prevents double-send.
  //   3. recipients exhausted (normal completion) → flip `running` →
  //      `completed`.
  //
  // Every branch is gated on status="running" so a race with cancel/pause
  // never overwrites the more specific terminal status.
  if (canceled) {
    // cancel endpoint already published the status change.
  } else if (shuttingDown) {
    const queuedRemaining = await db.broadcastRecipient.count({
      where: { broadcastId: broadcast.id, status: "queued" },
    });
    await db.broadcast.updateMany({
      where: { id: broadcast.id, status: "running" },
      data: { status: "paused" },
    });
    console.warn(
      `[broadcast ${broadcast.id}] paused for shutdown — ${queuedRemaining} recipient(s) remain queued`,
    );
    await publish({
      type: "broadcast.status_changed",
      teamId: broadcast.teamId,
      broadcastId: broadcast.id,
      status: "paused",
    });
  } else {
    await db.broadcast.updateMany({
      where: { id: broadcast.id, status: "running" },
      data: { status: "completed", completedAt: new Date() },
    });
    await publish({
      type: "broadcast.status_changed",
      teamId: broadcast.teamId,
      broadcastId: broadcast.id,
      status: "completed",
    });
  }
}

/**
 * One recipient's full send path: resolve conversation, send template, lock
 * in `sent`, write the Message row, emit. Each branch maps cleanly to the
 * matching `markRecipientFailed` + `bumpCounters({ failed: 1 })` pair so a
 * failure mid-path doesn't leave the recipient stuck in `queued`. The
 * concurrency pool above calls this once per recipient and applies the
 * inter-send delay around the call.
 */
async function processOneRecipient(
  broadcast: {
    id: string;
    teamId: string;
    templateId: string;
    templateName: string;
    templateLanguage: string;
    createdById: string | null;
  },
  recipient: {
    id: string;
    contactId: string;
    contact: {
      id: string;
      name: string;
      phoneNumber: string | null;
      email: string | null;
      location: string | null;
      customFields: Prisma.JsonValue;
    };
  },
  provider: MessagingProvider,
  config: unknown,
  bindings: VariableBindings,
  variables: BroadcastVariables,
  templateBody: string,
  pendingBumps: Set<Promise<unknown>>,
): Promise<void> {
  // Capture the optional method once — providers without a template catalog
  // fail the recipient gracefully (vs throwing) so the rest of the broadcast
  // continues. Using the local const also keeps `sendTemplate` typed as
  // defined across the await points below.
  const sendTemplate = provider.sendTemplate;
  if (!sendTemplate) {
    await markRecipientFailed(recipient.id, "provider does not support templates");
    bumpCountersFireAndForget(broadcast.id, broadcast.teamId, { failed: 1 }, pendingBumps);
    return;
  }
  // Per-recipient conversation resolution. Outside the send try because a
  // DB error here means we DIDN'T touch Meta — safe to mark `failed` and
  // let the user retry.
    let conversationId: string;
    // Carried out of the try-scope so the `message:new` publish below can
    // ship the absolute team-wide unread count without an extra round-trip.
    // Broadcast outbound doesn't change unread, so the pre-send value
    // remains accurate at publish time.
    let conversationUnreadCount = 0;
    try {
      // Strict invariant: one contact = one conversation. Reuse the existing
      // row regardless of status; a closed conversation just reopens
      // (→ pending) when a broadcast lands. Matches the webhook ingest path.
      const existing = await db.conversation.findFirst({
        where: { teamId: broadcast.teamId, contactId: recipient.contactId },
        orderBy: { lastMessageAt: "desc" },
      });
      let conversation = existing;
      if (!conversation) {
        try {
          conversation = await db.conversation.create({
            data: {
              teamId: broadcast.teamId,
              contactId: recipient.contactId,
              // Broadcasts are WhatsApp-only by design; stamp the same channel
              // the recipient messages carry so conv.channel == msg.channel.
              channel: BROADCAST_CHANNEL,
              status: "pending",
              lastMessagePreview: "",
            },
          });
        } catch (err) {
          // Lost the race for this contact's single conversation (unique
          // [teamId, contactId]) to a concurrent inbound — reuse the winner.
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
            conversation = await db.conversation.findFirstOrThrow({
              where: { teamId: broadcast.teamId, contactId: recipient.contactId },
              orderBy: { lastMessageAt: "desc" },
            });
          } else throw err;
        }
      } else if (conversation.status === "closed") {
        conversation = await db.conversation.update({
          where: { id: conversation.id },
          data: { status: "pending" },
        });
        await publish({
          type: "broadcast.conversation_reopened",
          teamId: broadcast.teamId,
          broadcastId: broadcast.id,
          conversationId: conversation.id,
        });
      }
      conversationId = conversation.id;
      conversationUnreadCount = conversation.unreadCount;
    } catch (err) {
      await markRecipientFailed(recipient.id, errorDetail(err));
      bumpCountersFireAndForget(broadcast.id, broadcast.teamId, { failed: 1 }, pendingBumps);
      return;
    }

    // Resolve per-recipient variable values from the template's bindings.
    // For variables bound to `manual`, this returns the broadcast's literal —
    // matches the pre-bindings behavior 1:1. Bound variables pull from the
    // contact row, falling back to the binding's defaultValue and then the
    // broadcast literal.
    const perRecipientVars = resolvePerRecipientVariables(
      bindings,
      variables,
      recipient.contact,
    );

    // WhatsApp templates require a phone number. Skip non-phone recipients
    // (Instagram/Telegram contacts that wandered into the audience) with a
    // clear failure message rather than feeding `null` to Meta.
    if (!recipient.contact.phoneNumber) {
      await markRecipientFailed(
        recipient.id,
        "Contact has no phone number — WhatsApp templates require one.",
      );
      bumpCountersFireAndForget(broadcast.id, broadcast.teamId, { failed: 1 }, pendingBumps);
      return;
    }
    const toPhone = recipient.contact.phoneNumber;

    // Double-send guard — claim a per-recipient OutboundSendAttempt BEFORE
    // touching Meta. On a resumed re-entry the prior row tells us whether the
    // send already reached Meta, so a crash between the Meta accept and the
    // `queued → sent` flip can't re-send a billed template (audit 2026-05-22;
    // see claimBroadcastSendAttempt).
    const attemptClaim = await claimBroadcastSendAttempt(
      recipient.id,
      broadcast.teamId,
      conversationId,
    );
    if (attemptClaim.kind === "abort") {
      await markRecipientFailed(recipient.id, attemptClaim.reason);
      bumpCountersFireAndForget(broadcast.id, broadcast.teamId, { failed: 1 }, pendingBumps);
      return;
    }

    // The send itself. Anything that throws here counts as a failed recipient
    // — Meta either rejected us or the network died, no message went out.
    let send: Awaited<ReturnType<typeof sendTemplate>>;
    if (attemptClaim.kind === "reconcile") {
      // A prior (crashed) attempt already reached Meta — skip the Meta call and
      // fall through to the recipient-lock + idempotent bookkeeping using the
      // stored externalId (createOutboundMessageIdempotent dedupes on it).
      send = { externalId: attemptClaim.externalId, timestamp: attemptClaim.timestamp };
    } else {
      try {
        send = await sendTemplate(
          {
            to: toPhone,
            name: broadcast.templateName,
            language: broadcast.templateLanguage,
            variables: {
              body: perRecipientVars.body,
              ...(perRecipientVars.header ? { header: perRecipientVars.header } : {}),
            },
          },
          config,
        );
      } catch (err) {
        // Meta rate-limit handling: a flagged number / rapid burst can produce
        // a 4/80007 response. Without a backoff, the entire broadcast becomes
        // a wall of "rate_limited"-failed recipients — and Meta charges
        // quality score for it. One sleep+retry is the cheapest mitigation:
        // we wait for ~3s of cooldown then send the same recipient again.
        // Only ONE retry — a permanently-flagged number shouldn't loop.
        if (normalizeMetaSendError(err)?.code === "rate_limited") {
          // Global per-broadcast 429 streak: when Meta rate-limits N
          // consecutive sends within ~30s the number's quality rating is
          // sliding — keep hammering at 25 msg/sec and we drain quality
          // AND mark thousands of recipients as false-failed. Pause the
          // broadcast for 60s before retrying this recipient so the rate
          // limit window has time to clear.
          track429Hit(broadcast.id);
          if (rate429Streak(broadcast.id) >= 10) {
            console.warn(
              `[broadcast ${broadcast.id}] 10 consecutive 429s — pausing all lanes 60s`,
            );
            // Signal the OTHER lanes to back off too (they check at their loop
            // top), then wait it out here before this lane's own retry.
            pauseAllLanes(broadcast.id, PAUSE_429_MS);
            await sleep(PAUSE_429_MS);
            reset429Streak(broadcast.id);
          }
          await sleep(3_000 + Math.floor(Math.random() * 1_000));
          try {
            send = await sendTemplate(
              {
                to: toPhone,
                name: broadcast.templateName,
                language: broadcast.templateLanguage,
                variables: {
                  body: perRecipientVars.body,
                  ...(perRecipientVars.header
                    ? { header: perRecipientVars.header }
                    : {}),
                },
              },
              config,
            );
          } catch (retryErr) {
            await releaseBroadcastSendAttempt(recipient.id);
            await markRecipientFailed(recipient.id, errorDetail(retryErr));
            bumpCountersFireAndForget(
              broadcast.id,
              broadcast.teamId,
              { failed: 1 },
              pendingBumps,
            );
            return;
          }
        } else {
          await releaseBroadcastSendAttempt(recipient.id);
          await markRecipientFailed(recipient.id, errorDetail(err));
          bumpCountersFireAndForget(
            broadcast.id,
            broadcast.teamId,
            { failed: 1 },
            pendingBumps,
          );
          return;
        }
      }
      // Meta accepted — stamp the attempt `completed` (with the wamid) BEFORE
      // the recipient `queued → sent` flip so a crash in that window resumes
      // into the reconcile path instead of re-sending to Meta.
      await completeBroadcastSendAttempt(recipient.id, send.externalId);
    }

    // Send SUCCEEDED. Lock in the recipient as `sent` BEFORE doing any
    // bookkeeping — once Meta has accepted, we must never resend, and any DB
    // wobble after this point would otherwise leave the row as `queued` for
    // a future resume to re-process.
    const recipientLocked = await db.broadcastRecipient.updateMany({
      where: { id: recipient.id, status: "queued" },
      data: {
        status: "sent",
        externalId: send.externalId,
        conversationId,
        sentAt: send.timestamp,
      },
    });
    if (recipientLocked.count === 0) {
      // Another process beat us to it — their recipient row is the source of
      // truth. Skip the bookkeeping below to avoid duplicate Message rows.
      console.warn(
        `[broadcast ${broadcast.id}] recipient ${recipient.id} was already claimed; skipping post-send bookkeeping`,
      );
      return;
    }
    bumpCountersFireAndForget(broadcast.id, broadcast.teamId, { sent: 1 }, pendingBumps);

    // Best-effort post-send bookkeeping. A failure here is a real bug worth
    // logging, but it must NEVER flip the recipient back to `failed`: the
    // message went out and Meta's already charged us. Worst case the inbox
    // is missing the row until a manual re-fetch.
    try {
      // Render with the same per-recipient values we just sent so the inbox
      // bubble matches what landed in the customer's WhatsApp — not the
      // unresolved literals the agent typed into the broadcast form.
      const renderedBody = renderTemplateBody(templateBody, perRecipientVars.body);
      const preview = renderedBody.slice(0, 200);

      const created = await createOutboundMessageIdempotent({
        teamId: broadcast.teamId,
        conversationId,
        externalId: send.externalId,
        senderUserId: broadcast.createdById,
        body: renderedBody,
        direction: "out",
        channel: BROADCAST_CHANNEL,
        status: "sent",
        rawPayload: {
          sentVia: "broadcast",
          broadcastId: broadcast.id,
          templateId: broadcast.templateId,
          templateName: broadcast.templateName,
          templateLanguage: broadcast.templateLanguage,
          variables,
        } as unknown as Prisma.InputJsonValue,
        timestamp: send.timestamp,
      });

      // CAS on lastMessageAt — a broadcast running concurrent with an
      // inbound from the same contact must not overwrite the inbound's
      // newer summary with the broadcast's outbound timestamp.
      await db.conversation.updateMany({
        where: { id: conversationId, lastMessageAt: { lte: send.timestamp } },
        data: { lastMessageAt: send.timestamp, lastMessagePreview: preview },
      });

      // Re-read so the event payload reflects DB state. If the CAS above
      // no-op'd (a newer inbound raced past send.timestamp), publishing
      // the broadcast's own preview would briefly flash it on every
      // client's conversation list before SSR snaps back to the inbound's
      // preview — the stale-preview bug the user reports.
      const summary = await db.conversation.findUnique({
        where: { id: conversationId },
        select: { lastMessagePreview: true, lastMessageAt: true },
      });
      const publishedPreview = summary?.lastMessagePreview ?? preview;
      const publishedLastMessageAt = (summary?.lastMessageAt ?? send.timestamp).toISOString();

      const messagePayload: Message = {
        id: created.id,
        teamId: broadcast.teamId,
        conversationId,
        externalId: send.externalId,
        senderUserId: broadcast.createdById,
        body: renderedBody,
        direction: "out",
        channel: BROADCAST_CHANNEL,
        status: "sent",
        rawPayload: { sentVia: "broadcast", broadcastId: broadcast.id },
        timestamp: send.timestamp.toISOString(),
      };

      await publish({
        type: "broadcast.recipient_message_sent",
        teamId: broadcast.teamId,
        broadcastId: broadcast.id,
        conversationId,
        message: messagePayload,
        preview: publishedPreview,
        lastMessageAt: publishedLastMessageAt,
        // Outbound broadcast doesn't touch unread, so the conversation
        // row's pre-send value is still the accurate absolute count.
        unreadCount: conversationUnreadCount,
      });
    } catch (err) {
      console.error(
        `[broadcast ${broadcast.id}] post-send bookkeeping failed for recipient ${recipient.id} (message was sent, externalId=${send.externalId})`,
        err,
      );
    }
}

async function markRecipientFailed(recipientId: string, message: string): Promise<void> {
  // CAS so a recipient that was already marked `sent` (or `failed`) by a
  // prior pass isn't reverted.
  await db.broadcastRecipient.updateMany({
    where: { id: recipientId, status: "queued" },
    data: { status: "failed", errorMessage: message.slice(0, 500) },
  });
}

// ---------------------------------------------------------------------------
// Per-recipient double-send guard (audit 2026-05-22)
// ---------------------------------------------------------------------------
//
// The recipient `queued → sent` CAS happens AFTER Meta accepts the send, so a
// hard crash in that window left the recipient `queued`; the resume reconciler
// then re-called Meta → a duplicate billed template send. We close that window
// with the same OutboundSendAttempt jobId gate the text-queue path uses
// (messages.service.ts): claim a row keyed on the recipient BEFORE the Meta
// call, stamp it `completed`+externalId AFTER Meta accepts (still before the
// recipient flip). On a resumed re-entry the prior row tells us whether the
// send already reached Meta.
type BroadcastAttemptClaim =
  | { kind: "proceed" }
  | { kind: "reconcile"; externalId: string; timestamp: Date }
  | { kind: "abort"; reason: string };

function broadcastAttemptJobId(recipientId: string): string {
  return `bc-recipient-${recipientId}`;
}

async function claimBroadcastSendAttempt(
  recipientId: string,
  teamId: string,
  conversationId: string,
): Promise<BroadcastAttemptClaim> {
  const jobId = broadcastAttemptJobId(recipientId);
  try {
    await db.outboundSendAttempt.create({ data: { jobId, teamId, conversationId } });
    return { kind: "proceed" };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const prior = await db.outboundSendAttempt.findUnique({
        where: { jobId },
        select: { completedAt: true, externalId: true, failedAt: true, failureReason: true },
      });
      if (prior?.completedAt && prior.externalId) {
        // Prior attempt already reached Meta — reconcile WITHOUT re-sending.
        return { kind: "reconcile", externalId: prior.externalId, timestamp: prior.completedAt };
      }
      if (prior?.failedAt) {
        return {
          kind: "abort",
          reason: prior.failureReason ?? "previous send attempt failed at the provider",
        };
      }
      // Neither completed nor failed: a prior attempt called Meta and crashed
      // mid-send. Refuse to re-send — one missing message beats a duplicate
      // billed template. The row stays for an operator to reconcile.
      return {
        kind: "abort",
        reason:
          "previous send attempt may have reached Meta; not retrying to avoid a duplicate",
      };
    }
    // Unexpected DB error claiming — fail closed (don't risk a send we can't
    // track). Same posture as the conversation-resolution catch above.
    return { kind: "abort", reason: errorDetail(err) };
  }
}

async function completeBroadcastSendAttempt(
  recipientId: string,
  externalId: string,
): Promise<void> {
  await db.outboundSendAttempt.updateMany({
    where: { jobId: broadcastAttemptJobId(recipientId) },
    data: { completedAt: new Date(), externalId },
  });
}

async function releaseBroadcastSendAttempt(recipientId: string): Promise<void> {
  // Meta rejected / network died — nothing sent. Delete the claim so a manual
  // broadcast retry can re-claim cleanly (the recipient is marked `failed`
  // and won't be re-pulled by a resume, so leaving it would only leak a row).
  await db.outboundSendAttempt
    .deleteMany({ where: { jobId: broadcastAttemptJobId(recipientId) } })
    .catch(() => {
      /* best-effort */
    });
}

/**
 * Per-broadcast throttle state. We emit `broadcast.progress` at most once
 * every PROGRESS_EMIT_INTERVAL_MS so a 25 msg/sec broadcast doesn't spam
 * 25 socket emits/sec at every team-watching tab. The DB increment is
 * NOT throttled — counters stay authoritative; only the live emit is
 * coalesced. The trailing emit fires with the latest counts so the UI
 * always converges to the true final state.
 */
const PROGRESS_EMIT_INTERVAL_MS = 500;
interface ProgressThrottle {
  lastEmitAt: number;
  pendingTimer: NodeJS.Timeout | null;
  latest: { sentCount: number; failedCount: number; totalCount: number; teamId: string };
}
const progressThrottles = new Map<string, ProgressThrottle>();

function emitProgress(broadcastId: string, state: ProgressThrottle["latest"]): void {
  void publish({
    type: "broadcast.progress",
    teamId: state.teamId,
    broadcastId,
    sentCount: state.sentCount,
    failedCount: state.failedCount,
    totalCount: state.totalCount,
  });
}

function scheduleProgress(
  broadcastId: string,
  state: ProgressThrottle["latest"],
): void {
  const now = Date.now();
  const existing = progressThrottles.get(broadcastId);
  if (!existing) {
    progressThrottles.set(broadcastId, { lastEmitAt: now, pendingTimer: null, latest: state });
    emitProgress(broadcastId, state);
    return;
  }
  existing.latest = state;
  if (now - existing.lastEmitAt >= PROGRESS_EMIT_INTERVAL_MS) {
    existing.lastEmitAt = now;
    if (existing.pendingTimer) {
      clearTimeout(existing.pendingTimer);
      existing.pendingTimer = null;
    }
    emitProgress(broadcastId, state);
    return;
  }
  if (existing.pendingTimer) return; // trailing emit already scheduled
  const delay = PROGRESS_EMIT_INTERVAL_MS - (now - existing.lastEmitAt);
  existing.pendingTimer = setTimeout(() => {
    const cur = progressThrottles.get(broadcastId);
    if (!cur) return;
    cur.lastEmitAt = Date.now();
    cur.pendingTimer = null;
    emitProgress(broadcastId, cur.latest);
  }, delay);
}

async function bumpCounters(
  broadcastId: string,
  teamId: string,
  delta: { sent?: number; failed?: number },
): Promise<void> {
  const updated = await db.broadcast.update({
    where: { id: broadcastId },
    data: {
      ...(delta.sent ? { sentCount: { increment: delta.sent } } : {}),
      ...(delta.failed ? { failedCount: { increment: delta.failed } } : {}),
    },
    select: { sentCount: true, failedCount: true, totalCount: true },
  });
  // Throttled emit (see scheduleProgress). DB write is authoritative and
  // unthrottled; the wire-level emit is coalesced.
  scheduleProgress(broadcastId, {
    teamId,
    sentCount: updated.sentCount,
    failedCount: updated.failedCount,
    totalCount: updated.totalCount,
  });
}

/**
 * Fire-and-forget counter bump. Used inside the per-recipient send path so
 * the DB roundtrip + socket emit don't block the next send. Increments are
 * atomic at the DB level, so out-of-order completion still yields correct
 * final totals; subscribers may briefly observe counters out of order but
 * never miss an update (each `update` is its own committed row). Errors are
 * logged, never thrown — a bookkeeping miss must not abort the broadcast.
 *
 * `pendingBumps` is a per-broadcast tracker the caller drains before flipping
 * the row to `completed`, so a UI watching for that status change never
 * observes sentCount + failedCount < totalCount.
 */
function bumpCountersFireAndForget(
  broadcastId: string,
  teamId: string,
  delta: { sent?: number; failed?: number },
  pendingBumps: Set<Promise<unknown>>,
): void {
  const p = bumpCounters(broadcastId, teamId, delta).catch((err) => {
    console.error(
      `[broadcast ${broadcastId}] counter bump failed (delta=${JSON.stringify(delta)})`,
      err,
    );
  });
  pendingBumps.add(p);
  // Self-evict so the Set doesn't grow unbounded across a long broadcast —
  // we only care about what's still in-flight at the drain point.
  void p.finally(() => pendingBumps.delete(p));
}

async function fail(broadcastId: string, message: string): Promise<void> {
  // Drop any pending throttled progress emit — the broadcast is failing,
  // there's no further state to converge to and we'd rather not deliver
  // a stale "progress" after the "failed" status.
  const throttle = progressThrottles.get(broadcastId);
  if (throttle?.pendingTimer) clearTimeout(throttle.pendingTimer);
  progressThrottles.delete(broadcastId);

  const row = await db.broadcast.update({
    where: { id: broadcastId },
    data: {
      status: "failed",
      lastError: message.slice(0, 1000),
      completedAt: new Date(),
    },
    select: { teamId: true },
  });
  await publish({
    type: "broadcast.status_changed",
    teamId: row.teamId,
    broadcastId,
    status: "failed",
    error: message,
  });
}

/**
 * Boot-time reconciler. Two cases:
 *
 *   1. `running` orphans — the previous process died (crash or hard restart
 *      that bypassed graceful shutdown) without flipping the status. By
 *      definition orphaned: the api process is the only thing that drives
 *      the runner. Treated as a paused broadcast — flip to `paused` and
 *      resume below. Safer than `failed` because the per-recipient CAS
 *      already prevents double-send on every recipient that was already
 *      `sent`, and a recipient stuck in `queued` is by definition unsent.
 *
 *   2. `paused` rows — graceful shutdown stamped this; resume.
 *
 * Resume mechanism: flip the row back to `queued` and call startBroadcast().
 * The runner's CAS `queued → running` claim handles the rest; the lane loop
 * skips already-`sent` recipients via the per-recipient `queued → sent` CAS
 * inside processOneRecipient.
 *
 * Edge case — mid-fetch crash on attempt 1: the previous process called
 * Meta but died before stamping `queued → sent`. On resume, we re-call
 * Meta for that recipient. Meta sends the message AGAIN. The recipient
 * row stays at `queued` because we still don't know the first wamid; the
 * SECOND call writes a fresh Message + recipient row. This is the same
 * double-send risk that P2 (OutboundSendAttempt for outbound text sends)
 * addresses for the text-send path; broadcasts have their own narrower
 * window because per-recipient send + CAS happen back-to-back without a
 * BullMQ-style retry layer in between. Document, don't block on it.
 *
 * Called from BroadcastsService.onModuleInit.
 */
export async function reconcileOrphanedBroadcasts(): Promise<void> {
  // Reset the in-process shutdown flag — if this process previously called
  // signalShutdown() and is now starting fresh (e.g., from a test harness
  // restart inside the same Node instance), we need to actually accept
  // resumes here.
  resetShutdownFlag();

  // 1) `running` orphans → flip to `paused` so the resume path below picks
  // them up uniformly with broadcasts that were paused by graceful shutdown.
  const runningOrphans = await db.broadcast.findMany({
    where: { status: "running" },
    select: { id: true, teamId: true },
  });
  if (runningOrphans.length > 0) {
    console.warn(
      `[broadcast-reconciler] flipping ${runningOrphans.length} orphaned running broadcast(s) to paused for resume`,
    );
    await db.broadcast.updateMany({
      where: { id: { in: runningOrphans.map((o) => o.id) } },
      data: { status: "paused" },
    });
  }

  // 2) Every `paused` row → flip back to `queued` and re-fire the runner.
  // updateMany is racing with create() callers but the per-row CAS in
  // runBroadcast.claim() (status="queued") keeps it race-safe.
  const pausedRows = await db.broadcast.findMany({
    where: { status: "paused" },
    select: { id: true, teamId: true },
  });
  if (pausedRows.length === 0) return;

  for (const row of pausedRows) {
    const queuedRemaining = await db.broadcastRecipient.count({
      where: { broadcastId: row.id, status: "queued" },
    });
    if (queuedRemaining === 0) {
      // Nothing to resume — mark completed. This handles the edge case
      // where the previous process sent every recipient but died before
      // flipping the parent row to `completed`.
      await db.broadcast.updateMany({
        where: { id: row.id, status: "paused" },
        data: { status: "completed", completedAt: new Date() },
      });
      await publish({
        type: "broadcast.status_changed",
        teamId: row.teamId,
        broadcastId: row.id,
        status: "completed",
      });
      continue;
    }

    const flipped = await db.broadcast.updateMany({
      where: { id: row.id, status: "paused" },
      data: { status: "queued" },
    });
    if (flipped.count === 0) continue;

    console.warn(
      `[broadcast-reconciler] resuming broadcast ${row.id} (${queuedRemaining} recipient(s) remaining)`,
    );
    // Fire-and-forget — startBroadcast schedules the runner inside
    // setImmediate via its own mechanics. We don't await so onModuleInit
    // returns quickly.
    startBroadcast(row.id);
  }
}

async function loadTemplate(
  teamId: string,
  templateId: string,
): Promise<{ bodyText: string; variableBindings: Prisma.JsonValue }> {
  const row = await db.messageTemplate.findFirst({
    where: { id: templateId, teamId },
    select: { bodyText: true, variableBindings: true },
  });
  return {
    bodyText: row?.bodyText ?? "",
    variableBindings: row?.variableBindings ?? {},
  };
}

/**
 * Resolve every variable for ONE recipient.
 *
 * The variable count comes from the broadcast-form payload (validated to match
 * the template above), so we iterate that array and consult the matching
 * binding by index. Missing bindings degrade to `manual` (the legacy path).
 */
function resolvePerRecipientVariables(
  bindings: VariableBindings,
  literals: BroadcastVariables,
  contact: {
    name: string;
    phoneNumber: string | null;
    email: string | null;
    location: string | null;
    customFields: Prisma.JsonValue;
  },
): BroadcastVariables {
  // Two-layer resolution:
  //   1. `resolveBinding` honors the template's binding (contact_field /
  //      contact_custom_field) — pulls the matching contact value, falls
  //      back to the binding's default, then to the agent-typed literal.
  //   2. Whatever string falls out of that gets a SECOND pass through
  //      `resolveFieldTokens`, which substitutes any `{{contact.X}}` tokens
  //      the agent typed straight into the broadcast input. This is what
  //      makes per-recipient personalization work even on templates without
  //      bindings configured.
  // Plain literals with no tokens pass through unchanged.
  const body = literals.body.map((literal, i) => {
    const bound = resolveBinding(bindings.body[i], literal, contact);
    return resolveFieldTokens(bound, contact);
  });
  const header = literals.header
    ? resolveFieldTokens(
        resolveBinding(bindings.header, literals.header, contact),
        contact,
      )
    : undefined;
  return header ? { body, header } : { body };
}

function parseVariables(v: Prisma.JsonValue): BroadcastVariables {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return { body: [] };
  }
  const obj = v as { body?: unknown; header?: unknown };
  const body = Array.isArray(obj.body)
    ? obj.body.filter((x): x is string => typeof x === "string")
    : [];
  const header = typeof obj.header === "string" ? obj.header : undefined;
  return { body, ...(header ? { header } : {}) };
}

function errorDetail(err: unknown): string {
  const normalized = normalizeMetaSendError(err);
  if (normalized) return `${normalized.code}: ${normalized.message}`;
  if (err instanceof MetaSendError) {
    return `Meta ${err.httpStatus}: ${err.body}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
