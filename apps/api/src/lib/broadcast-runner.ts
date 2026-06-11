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
import { extractFieldTokens, resolveFieldTokens } from "@ccp/shared/field-tokens";
import type { Message } from "@ccp/shared/types";

/**
 * IN-MEMORY PER-BROADCAST STATE — five Maps keyed by broadcastId hold runner
 * scratch state across recipients. Normal completion (`runBroadcast`'s tail
 * block + the throttle drain in `processOneRecipient` + `fail()`) deletes
 * their entries; a process crash leaves them stale. The boot reconciler
 * (`reconcileOrphanedBroadcasts`) is the resume path; the
 * `pruneBroadcastInMemoryStateForTerminalRows` helper called from
 * `BroadcastsService.onModuleInit` then clears stale entries belonging to
 * already-terminal broadcasts so a reused/resumed id can't inherit them.
 * If you ADD a new per-broadcast Map, register it here AND in
 * `pruneBroadcastInMemoryStateForTerminalRows`:
 *
 *   - STREAK_429            — 429 streak count (per-broadcast)
 *   - PAUSE_429             — global pause deadline (per-broadcast)
 *   - PERMANENT_STREAK      — consecutive permanent-error count (per-broadcast)
 *   - FATAL_PAUSE           — fatal-error pause signal (per-broadcast)
 *   - inFlightRuns          — top-level runBroadcast promise
 *   - broadcastTeamSlots    — per-TEAM concurrent-broadcast gate
 *   - teamRecipientSlots    — per-TEAM concurrent-RECIPIENT gate (lane-level)
 *   - progressThrottles     — coalesced progress emit state
 */

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

/**
 * Permanent-error circuit breaker. The 429 streak above handles TRANSIENT rate
 * limits (back off, retry). But a credential that's dead for the whole run —
 * an expired/revoked Meta token (`auth_expired`) or a WhatsApp number that was
 * deconfigured mid-flight (`provider_not_configured`) — makes EVERY remaining
 * recipient a guaranteed-failing Meta call at full lane speed: a wall of false
 * `failed` rows, wasted calls against a flagged credential, and a delayed
 * operator discovery of the real cause. The send config is resolved ONCE at
 * run start, so a token that dies after that never self-heals within the run.
 *
 * When N consecutive sends fail with a permanent class, we CAS the broadcast
 * `running → paused` and signal all lanes to stop. `paused` is the existing
 * resume state: the boot reconciler flips it back to `queued` and re-fires the
 * runner (re-resolving the config), and the per-recipient CAS keeps already-
 * sent rows untouched. The operator sees "paused — WhatsApp connection error"
 * and can fix the credential + retry instead of staring at thousands of
 * failures. Reset on any success so an isolated rejection (one bad number)
 * doesn't trip it.
 */
const PERMANENT_ERROR_PAUSE_THRESHOLD = 5;
const PERMANENT_STREAK: Map<string, number> = new Map();
function trackPermanentHit(broadcastId: string): number {
  const next = (PERMANENT_STREAK.get(broadcastId) ?? 0) + 1;
  PERMANENT_STREAK.set(broadcastId, next);
  return next;
}
function resetPermanentStreak(broadcastId: string): void {
  PERMANENT_STREAK.delete(broadcastId);
}
/**
 * Lanes set this when the permanent-error breaker trips so the OTHER lanes
 * stop pulling recipients (mirrors `canceled`, but driven in-memory rather
 * than via a DB status poll — the breaker already wrote `paused` to the row).
 */
const FATAL_PAUSE: Set<string> = new Set();

interface BroadcastVariables {
  body: string[];
  header?: string;
  /** Campaign-level media for an IMAGE/VIDEO/DOCUMENT template header — one
   *  media reused across every recipient (a public link, reusable unlike
   *  Meta's single-use upload-media id). */
  headerMedia?: { kind: "image" | "video" | "document"; link: string; filename?: string };
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

/**
 * Per-team RECIPIENT-LEVEL concurrency cap. Sits on top of the per-broadcast
 * lane pool (SEND_CONCURRENCY) and the per-team broadcast cap above. Without
 * this, one team running N broadcasts × SEND_CONCURRENCY lanes can call
 * processOneRecipient on up to N×5 contacts concurrently — enough, when the
 * api process is also serving REST + Socket.io for OTHER teams, to dominate
 * the Prisma pool and Meta call budget. The recipient cap bounds the team's
 * in-flight recipient count regardless of how many of its broadcasts are
 * running. The global ceiling (sum of lanes across all running broadcasts in
 * this process) is still SEND_CONCURRENCY × MAX_RUNNING_BROADCASTS; this
 * cap only ensures no single team can consume more than its share of it.
 *
 * Lanes await slot acquisition before pulling the next recipient (rather than
 * the moveToDelayed pattern BullMQ workers use — the broadcast runner is not a
 * BullMQ job, so a queued-defer doesn't apply). Wait queue is FIFO so a
 * starved lane eventually makes progress; a depth-threshold warn log surfaces
 * a team that's chronically waiting (slow Meta, undersized cap, etc.).
 *
 * Tunable via BROADCAST_PER_TEAM_RECIPIENT_CONCURRENCY (default 5; matches the
 * global SEND_CONCURRENCY so a single team running one broadcast is unaffected,
 * but a second concurrent broadcast can't double its in-flight count).
 *
 * Keyed by teamId. Entry is dropped when the team has zero active + zero
 * waiters so the Map stays bounded with one entry per actively-sending team.
 */
function perTeamRecipientConcurrency(): number {
  const raw = Number.parseInt(
    process.env.BROADCAST_PER_TEAM_RECIPIENT_CONCURRENCY ?? "5",
    10,
  );
  return Number.isFinite(raw) && raw > 0 && raw <= 50 ? raw : 5;
}

/** Wait queue depth that triggers a structured warn log ("this team is starving"). */
const RECIPIENT_QUEUE_DEPTH_WARN = 50;
/** Throttle the warn log so a chronically-starved team doesn't spam stdout. */
const RECIPIENT_QUEUE_WARN_INTERVAL_MS = 30_000;

interface TeamRecipientSlotState {
  /** In-flight processOneRecipient calls for this team. */
  active: number;
  /** FIFO of resolvers waiting for a slot. */
  waiters: Array<() => void>;
  /** Last time we logged a queue-depth warning for this team. */
  lastWarnAt: number;
}
const teamRecipientSlots = new Map<string, TeamRecipientSlotState>();

function getOrCreateRecipientSlotEntry(teamId: string): TeamRecipientSlotState {
  let entry = teamRecipientSlots.get(teamId);
  if (!entry) {
    entry = { active: 0, waiters: [], lastWarnAt: 0 };
    teamRecipientSlots.set(teamId, entry);
  }
  return entry;
}

/**
 * Acquire a per-team recipient slot. Resolves synchronously when a slot is
 * free, or after the lane ahead releases. Pair with `releaseTeamRecipientSlot`
 * in a `finally` so a thrown recipient doesn't permanently leak a slot.
 *
 * Invariant: `active` is incremented exactly once per acquire — either inline
 * when a slot is immediately free, or by the releasing caller when it hands
 * the slot to a waiter (slot ownership transfers without `active` ever
 * dropping below cap, so a concurrent arrival can't observe a stale "free"
 * slot).
 */
async function acquireTeamRecipientSlot(teamId: string): Promise<void> {
  const cap = perTeamRecipientConcurrency();
  const entry = getOrCreateRecipientSlotEntry(teamId);
  if (entry.active < cap) {
    entry.active += 1;
    return;
  }
  if (entry.waiters.length >= RECIPIENT_QUEUE_DEPTH_WARN) {
    const now = Date.now();
    if (now - entry.lastWarnAt > RECIPIENT_QUEUE_WARN_INTERVAL_MS) {
      entry.lastWarnAt = now;
      console.warn(
        `[broadcast] team ${teamId} starving on recipient slots: ${entry.waiters.length} waiter(s), cap=${cap}`,
      );
    }
  }
  await new Promise<void>((resolve) => {
    entry.waiters.push(resolve);
  });
  // `active` was already incremented by the releasing caller when it
  // dequeued us — DO NOT bump again here.
}

function releaseTeamRecipientSlot(teamId: string): void {
  const entry = teamRecipientSlots.get(teamId);
  if (!entry) return;
  const next = entry.waiters.shift();
  if (next) {
    // Hand the slot directly to the next waiter — `active` stays at cap so
    // a concurrent arrival can't sneak in ahead. The waiter resumes on the
    // microtask queue with the slot already accounted for.
    next();
    return;
  }
  entry.active = Math.max(0, entry.active - 1);
  if (entry.active === 0 && entry.waiters.length === 0) {
    teamRecipientSlots.delete(teamId);
  }
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
    // broadcasts finishes. (If the process dies while a row is parked here,
    // the boot reconciler's queued-orphan sweep re-fires it — see step 0 of
    // reconcileOrphanedBroadcasts.) unref so this timer can't hold the
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
  // Clear `lastError` on (re)claim — the permanent-error breaker stamps it when
  // it pauses, and a successful resume must not leave a stale "WhatsApp
  // connection error" banner on the eventually-completed broadcast.
  const claimed = await db.broadcast.updateMany({
    where: { id: broadcast.id, status: "queued" },
    data: { status: "running", startedAt: new Date(), lastError: null },
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
  // L7: customFields is JSONB and can hold arbitrarily large blobs per
  // contact; loading it on every recipient page when no template variable
  // references one is pure waste. Detect at run start whether ANY binding
  // pulls from custom fields OR any literal embeds a `$var.contact.<key>`
  // token that isn't a builtin contact field. If not, omit customFields
  // from the recipient select (decision is one const, not branched per
  // recipient). The token-token check covers the `resolveFieldTokens` pass
  // that runs on every literal in `resolvePerRecipientVariables` — agents
  // can hand-type `$var.contact.<custom>` even when the binding is
  // `manual`. BUILTIN_CONTACT_KEYS mirrors the resolver's allowlist; any
  // unrecognized contact-namespace token is treated as a custom-field hint.
  const BUILTIN_CONTACT_TOKEN_KEYS = new Set([
    "name",
    "phone",
    "phoneNumber",
    "email",
    "location",
    "last_inbound_at",
    "window_state",
    "stage_name",
    "tag_names",
  ]);
  const bindingsReferenceCustomField =
    bindings.body.some((b) => b?.source.kind === "contact_custom_field") ||
    bindings.header?.source.kind === "contact_custom_field";
  const literalReferencesCustomField = (() => {
    const literals: string[] = [...variables.body, ...(variables.header ? [variables.header] : [])];
    for (const text of literals) {
      if (!text || typeof text !== "string" || !text.includes("$var.")) continue;
      for (const tok of extractFieldTokens(text)) {
        const segs = tok.slice("$var.".length).split(".");
        // Only $var.contact.<key> matters — other namespaces don't hit
        // customFields. The trailing `[key]` check rejects builtin keys.
        if (segs[0] === "contact" && segs.length === 2 && !BUILTIN_CONTACT_TOKEN_KEYS.has(segs[1]!)) {
          return true;
        }
      }
    }
    return false;
  })();
  const needsCustomFields = bindingsReferenceCustomField || literalReferencesCustomField;

  // Select only the recipient + contact fields the send path actually reads.
  // Without this, every page drags every Contact column (incl. customFields
  // JSONB) for every recipient — at 10k recipients this dominates the
  // broadcast's DB cost. Keep in sync with resolvePerRecipientVariables +
  // resolveBinding's ContactLike (name/phoneNumber/email/location/customFields).
  //
  // L7: customFields is always declared in the TYPE select (so downstream
  // signatures stay stable) but the RUNTIME select only includes it when a
  // binding or literal token actually reads a custom field. When omitted at
  // runtime, the row arrives without customFields populated and we coerce
  // to `{}` before handing to processOneRecipient (resolveBinding +
  // resolveFieldTokens both treat a non-object customFields as empty).
  const RECIPIENT_SELECT_FULL = {
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
        // Re-checked at SEND time (not just at audience-resolution time) so a
        // contact deleted AFTER the broadcast was created — the de-facto
        // opt-out path, most likely on a SCHEDULED broadcast whose create→fire
        // gap is hours/days — is skipped instead of getting a billed template.
        deletedAt: true,
        customFields: true,
      },
    },
  } as const;
  const RECIPIENT_SELECT: typeof RECIPIENT_SELECT_FULL = needsCustomFields
    ? RECIPIENT_SELECT_FULL
    : ({
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
            deletedAt: true,
          },
        },
      } as unknown as typeof RECIPIENT_SELECT_FULL);

  type Recipient = Awaited<
    ReturnType<typeof db.broadcastRecipient.findMany<{
      where: { broadcastId: string; status: "queued" };
      select: typeof RECIPIENT_SELECT_FULL;
      orderBy: { id: "asc" };
      take: typeof PAGE_SIZE;
    }>>
  >[number];
  const pendingBumps = new Set<Promise<unknown>>();
  const queue: Recipient[] = [];
  let cursorId: string | undefined;
  let exhausted = false;
  // M5: same-contact recipient short-circuit. A broadcast can include the
  // SAME contactId twice (e.g. duplicated rows from manually-merged audiences
  // we couldn't dedupe perfectly), and with SEND_CONCURRENCY lanes pulling
  // independently, each lane re-issues conversation.findFirst for that
  // contact. Cache the resolved conversation (id + status + unreadCount) per
  // contactId; cleared automatically when this runBroadcast returns (function
  // scope, not module-global). Race-safe: if the first hit was `closed` and
  // we reopened, the cached status flips to `pending` so the SECOND hit
  // doesn't double-publish `broadcast.conversation_reopened`.
  const conversationCache = new Map<
    string,
    { id: string; status: string; unreadCount: number }
  >();

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
        // Fatal-error breaker tripped by another (or this) lane — the broadcast
        // row is already `paused` and the boot reconciler will resume it once
        // the credential is fixed. Stop pulling new recipients.
        if (FATAL_PAUSE.has(broadcast.id)) return;
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
        // L7: customFields may have been omitted from the runtime select.
        // Coerce to `{}` so processOneRecipient + the resolvers see a
        // consistent JsonValue shape. (Has zero effect when the field WAS
        // selected — Prisma either populated it or it's null/undefined and
        // the resolvers already treat non-object values as empty.)
        if (recipient.contact && (recipient.contact as { customFields?: unknown }).customFields === undefined) {
          (recipient.contact as { customFields: Prisma.JsonValue }).customFields = {};
        }
        // Per-team recipient-slot gate. Awaits when another team is already at
        // its cap so a single team's burst can't dominate every lane in the
        // process — without this, one team running multiple broadcasts could
        // pin every Meta call slot while others starve. Slot is released in a
        // `finally` so a thrown recipient (shouldn't happen — processOneRecipient
        // swallows its errors — but defensive) doesn't leak the slot.
        await acquireTeamRecipientSlot(broadcast.teamId);
        try {
          await processOneRecipient(
            broadcast,
            recipient,
            provider,
            config,
            bindings,
            variables,
            templateBody,
            pendingBumps,
            conversationCache,
          );
        } finally {
          releaseTeamRecipientSlot(broadcast.teamId);
        }
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
  // Drop the permanent-error breaker state too. If the breaker tripped, the
  // row is already `paused` (handled in the tail branch below); clearing the
  // FATAL_PAUSE signal here is safe because every lane has already drained.
  resetPermanentStreak(broadcast.id);
  const fatalPaused = FATAL_PAUSE.delete(broadcast.id);

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

  // Four possible exits from the lane loop:
  //   1. canceled by operator → cancel endpoint owns the status emit.
  //   2. fatalPaused (permanent-error breaker) → the tripping lane already
  //      CAS'd `running` → `paused` and published; nothing more to do here.
  //      Boot reconciler resumes it once the credential is fixed.
  //   3. shuttingDown (graceful drain) → flip `running` → `paused`. Boot
  //      reconciler on the next process will flip back to `queued` and call
  //      startBroadcast(); recipient CAS prevents double-send.
  //   4. recipients exhausted (normal completion) → flip `running` →
  //      `completed`.
  //
  // Every branch is gated on status="running" so a race with cancel/pause
  // never overwrites the more specific terminal status.
  if (canceled) {
    // cancel endpoint already published the status change.
  } else if (fatalPaused) {
    // Permanent-error breaker already wrote `paused` + published. No-op.
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
      deletedAt: Date | null;
      customFields: Prisma.JsonValue;
    };
  },
  provider: MessagingProvider,
  config: unknown,
  bindings: VariableBindings,
  variables: BroadcastVariables,
  templateBody: string,
  pendingBumps: Set<Promise<unknown>>,
  // M5 — per-runBroadcast cache; avoids N+1 conversation.findFirst when
  // the same contact appears multiple times in a single broadcast.
  conversationCache: Map<string, { id: string; status: string; unreadCount: number }>,
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
  // Re-check contact liveness at FIRE time. Audience resolution filters
  // `deletedAt: null` at create time, but a contact can be soft-deleted in the
  // create→fire gap (seconds for "send now", hours/days for a scheduled
  // broadcast). Deleting a contact is the de-facto opt-out, so we must not
  // deliver a billed template to one Meta would charge for and the customer
  // could report as spam. Short-circuits BEFORE conversation resolution so we
  // don't reopen a closed thread for someone who was removed. Mirrors the
  // missing-phone guard below.
  if (recipient.contact.deletedAt) {
    await markRecipientFailed(
      recipient.id,
      "Contact was deleted after the broadcast was created.",
    );
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
      //
      // M5: short-circuit on the per-broadcast cache when this contact was
      // already resolved by a prior lane / recipient. We only need
      // id/status/unreadCount downstream; status drives the reopen branch
      // below and the cache entry is kept in sync after a reopen.
      const cached = conversationCache.get(recipient.contactId);
      let conversation: { id: string; status: string; unreadCount: number } | null =
        cached ?? null;
      if (!conversation) {
        const existing = await db.conversation.findFirst({
          where: { teamId: broadcast.teamId, contactId: recipient.contactId },
          orderBy: { lastMessageAt: "desc" },
          select: { id: true, status: true, unreadCount: true },
        });
        conversation = existing;
      }
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
            select: { id: true, status: true, unreadCount: true },
          });
        } catch (err) {
          // Lost the race for this contact's single conversation (unique
          // [teamId, contactId]) to a concurrent inbound — reuse the winner.
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
            conversation = await db.conversation.findFirstOrThrow({
              where: { teamId: broadcast.teamId, contactId: recipient.contactId },
              orderBy: { lastMessageAt: "desc" },
              select: { id: true, status: true, unreadCount: true },
            });
          } else throw err;
        }
      } else if (conversation.status === "closed") {
        conversation = await db.conversation.update({
          where: { id: conversation.id },
          data: { status: "pending" },
          select: { id: true, status: true, unreadCount: true },
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
      // M5 — record / refresh the cache. Cache the POST-reopen state so the
      // next recipient sharing this contactId doesn't re-fire the
      // `broadcast.conversation_reopened` publish.
      conversationCache.set(recipient.contactId, {
        id: conversation.id,
        status: conversation.status,
        unreadCount: conversation.unreadCount,
      });
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
              ...(variables.headerMedia ? { headerMedia: variables.headerMedia } : {}),
            },
          },
          config,
        );
      } catch (err) {
        // Meta rate-limit handling: a flagged number / rapid burst can produce
        // a rate/throughput/messaging-limit response — 4 / 80007 (app-level) or,
        // far more commonly under a real broadcast, 130429 (per-second throughput),
        // 131048 (spam/quality limit) or 131056 (pair limit). All five normalize
        // to `rate_limited` (see normalizeMetaSendError), so this branch now fires
        // on the errors broadcasts actually hit. Without a backoff, the entire
        // broadcast becomes a wall of "rate_limited"-failed recipients — and Meta
        // charges quality score for it. One sleep+retry is the cheapest mitigation:
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
                  ...(variables.headerMedia
                    ? { headerMedia: variables.headerMedia }
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
            // A first error that looked like a rate-limit can resolve into a
            // permanent credential failure on retry (token revoked mid-run,
            // number deconfigured). Consult the breaker here too — otherwise a
            // dead credential whose first symptom was a 429 would burn the
            // whole audience as false failures (the else-branch below is the
            // only other place this runs). Self-classifying: a genuinely
            // rate-limited retryErr is a non-permanent error and just resets
            // the streak.
            await maybeTripPermanentBreaker(broadcast, retryErr);
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
          // Permanent-error breaker: a credential that's dead for the whole run
          // (expired/revoked token → `auth_expired`, deconfigured number →
          // `provider_not_configured`) fails every remaining recipient. Track
          // the consecutive streak; once it crosses the threshold, pause the
          // broadcast so the operator can reconnect + retry instead of burning
          // through the audience as false failures.
          await maybeTripPermanentBreaker(broadcast, err);
          return;
        }
      }
      // A send (or reconcile) succeeded — clear the permanent-error streak so
      // an isolated rejection earlier in the run can't accumulate toward the
      // breaker across unrelated good sends.
      resetPermanentStreak(broadcast.id);
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

/**
 * Whether a send error is a PERMANENT credential failure — one that will recur
 * for every remaining recipient until the operator reconnects WhatsApp, as
 * opposed to a per-recipient rejection (bad number, unsupported content) or a
 * transient rate limit (handled by the 429 streak). Only these classes feed
 * the permanent-error breaker.
 */
function isPermanentCredentialError(err: unknown): boolean {
  if (err instanceof ProviderNotConfiguredError) return true;
  return normalizeMetaSendError(err)?.code === "auth_expired";
}

/**
 * Permanent-error breaker. Called from the non-rate-limited failure branch.
 * Bumps the consecutive permanent-error streak; when it crosses the threshold,
 * CAS the broadcast `running → paused`, set the in-memory FATAL_PAUSE signal so
 * every lane stops pulling, and publish the paused status so the UI surfaces
 * "paused — WhatsApp connection error". The boot reconciler resumes a `paused`
 * broadcast (re-resolving the send config) once the credential is fixed.
 */
async function maybeTripPermanentBreaker(
  broadcast: { id: string; teamId: string },
  err: unknown,
): Promise<void> {
  if (!isPermanentCredentialError(err)) {
    // A non-permanent rejection (bad number, unsupported message) breaks any
    // accumulating permanent streak — those are isolated, not a dead credential.
    resetPermanentStreak(broadcast.id);
    return;
  }
  const streak = trackPermanentHit(broadcast.id);
  if (streak < PERMANENT_ERROR_PAUSE_THRESHOLD) return;
  if (FATAL_PAUSE.has(broadcast.id)) return; // another lane already tripped it
  // Claim the trip atomically in-memory before the DB write so two lanes
  // crossing the threshold in the same tick don't both pause/publish.
  FATAL_PAUSE.add(broadcast.id);
  const reason = isProviderNotConfigured(err)
    ? "WhatsApp connection error — the number is no longer configured."
    : "WhatsApp connection error — the access token expired or was revoked.";
  const paused = await db.broadcast.updateMany({
    where: { id: broadcast.id, status: "running" },
    data: { status: "paused", lastError: reason },
  });
  if (paused.count === 0) {
    // Already left `running` (canceled / completed by a racing path). Leave the
    // FATAL_PAUSE flag set so lanes still stop; the tail clears it.
    return;
  }
  console.warn(
    `[broadcast ${broadcast.id}] ${PERMANENT_ERROR_PAUSE_THRESHOLD} consecutive permanent send errors — pausing broadcast (${reason})`,
  );
  await publish({
    type: "broadcast.status_changed",
    teamId: broadcast.teamId,
    broadcastId: broadcast.id,
    status: "paused",
    error: reason,
  });
}

function isProviderNotConfigured(err: unknown): boolean {
  return err instanceof ProviderNotConfiguredError;
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
  }).catch((err) => {
    // Progress frames are best-effort UI sugar — a throwing publish must not
    // surface as an unhandledRejection (Node 24 `--unhandled-rejections=throw`
    // would terminate the worker mid-broadcast). Log and carry on.
    console.error(
      `[broadcast-runner] emitProgress publish failed (broadcastId=${broadcastId})`,
      err,
    );
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

  // 0) Snapshot broadcasts already sitting in `queued` at boot. These are
  // ORPHANS: a row is created `queued` (immediate send) or flipped
  // `scheduled`→`queued` by its delayed job, then `startBroadcast()` runs
  // fire-and-forget — if the process dies before the runner's CAS claim flips
  // it to `running` (e.g. a crash/deploy in the create→claim, team-at-cap
  // defer, retry, or scheduled-fire window), nothing ever picks it up again.
  // The running- and paused-recovery below don't touch `queued`, so without
  // this the row sends NOTHING forever — a billed, customer-facing broadcast
  // silently lost. Snapshot BEFORE step 2 flips paused→queued so the two sets
  // are disjoint (paused resumes are re-fired by step 2 itself).
  const queuedOrphans = await db.broadcast.findMany({
    where: { status: "queued" },
    select: { id: true },
  });

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

  // 3) Re-fire the `queued` orphans snapshotted in step 0. startBroadcast is
  // idempotent (CAS on status="queued" in runBroadcast.claim), so a row that
  // some other path already advanced is a no-op. Done LAST so step 2's
  // paused→queued resumes — which step 2 already fired — aren't double-fired.
  for (const row of queuedOrphans) {
    console.warn(
      `[broadcast-reconciler] resuming orphaned queued broadcast ${row.id}`,
    );
    startBroadcast(row.id);
  }
}

/**
 * Crash-recovery for the in-memory state Maps documented at the top of this
 * file. A process that crashed mid-broadcast can leave STREAK_429 / PAUSE_429
 * / inFlightRuns / progressThrottles entries pinned to a broadcastId that is
 * now in a terminal status — and a reused-or-resumed broadcastId would then
 * inherit a stale 60s 429 pause, mysterious slowdown, etc. Run this AFTER
 * `reconcileOrphanedBroadcasts` so the only ids we encounter as terminal are
 * the ones we expect (running/paused have been demoted/resumed by that point).
 *
 * Cross-team scope: every entry's key is a broadcast id, so a single DB scan
 * per process is sufficient. Pulling only ids minimizes the query cost.
 */
export async function pruneBroadcastInMemoryStateForTerminalRows(): Promise<void> {
  // Anything NOT in (queued, running, paused, scheduled) is terminal from the
  // runner's perspective; scheduled is also "no in-memory state yet" so we
  // can safely include it in the prune set. We instead query the inverse —
  // terminal statuses — so the index hits a known small set.
  const terminal = await db.broadcast.findMany({
    where: { status: { in: ["completed", "failed", "canceled"] } },
    select: { id: true },
  });
  if (terminal.length === 0) return;
  let cleared = 0;
  for (const row of terminal) {
    if (STREAK_429.delete(row.id)) cleared++;
    if (PAUSE_429.delete(row.id)) cleared++;
    if (PERMANENT_STREAK.delete(row.id)) cleared++;
    if (FATAL_PAUSE.delete(row.id)) cleared++;
    if (inFlightRuns.delete(row.id)) cleared++;
    const throttle = progressThrottles.get(row.id);
    if (throttle) {
      if (throttle.pendingTimer) clearTimeout(throttle.pendingTimer);
      progressThrottles.delete(row.id);
      cleared++;
    }
    // broadcastTeamSlots + teamRecipientSlots are keyed by teamId, not
    // broadcastId — neither is pruned per-row here. A truly stuck entry would
    // only happen if a runner crashed BETWEEN acquire and the release in
    // `finally`, leaving `active` artificially high. The boot path
    // reconstructs lane state from DB rows and re-fires startBroadcast, which
    // re-acquires slots; old entries from the dead process are not visible to
    // the new one (Maps live in process memory).
  }
  if (cleared > 0) {
    console.log(
      `[broadcast-reconciler] pruned ${cleared} stale in-memory state entr${cleared === 1 ? "y" : "ies"} for terminal broadcasts`,
    );
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
  const obj = v as { body?: unknown; header?: unknown; headerMedia?: unknown };
  const body = Array.isArray(obj.body)
    ? obj.body.filter((x): x is string => typeof x === "string")
    : [];
  const header = typeof obj.header === "string" ? obj.header : undefined;
  let headerMedia: BroadcastVariables["headerMedia"];
  const hm = obj.headerMedia as
    | { kind?: unknown; link?: unknown; filename?: unknown }
    | undefined;
  if (
    hm &&
    (hm.kind === "image" || hm.kind === "video" || hm.kind === "document") &&
    typeof hm.link === "string"
  ) {
    headerMedia = {
      kind: hm.kind,
      link: hm.link,
      ...(typeof hm.filename === "string" ? { filename: hm.filename } : {}),
    };
  }
  return {
    body,
    ...(header ? { header } : {}),
    ...(headerMedia ? { headerMedia } : {}),
  };
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
