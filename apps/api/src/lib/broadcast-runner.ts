import { Prisma } from "@prisma/client";

import { blobStorage } from "@/lib/blob-storage";
import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { assignConversation } from "@/lib/conversations/mutations";
import { createOutboundMessageIdempotent, isTransient } from "@/lib/messages/idempotent-create";
import {
  BsuidPortfolioMismatchError,
  applyBsuidPortfolioGuard,
} from "@/lib/messaging/bsuid-routing";
import { getProviderBinding } from "@/lib/providers";
import { ProviderNotConfiguredError } from "@/lib/providers/config";
import {
  countTemplatePlaceholders,
  isPairRateLimitError,
  MetaSendError,
  normalizeMetaSendError,
  renderTemplateBody,
} from "@/lib/providers/meta";
import {
  encodeUrlButtonValue,
  requiredTemplateButtonParams,
  templateNamedPlaceholders,
} from "@ccp/shared/template-render";
import type { MessagingProvider, TemplateCardVariables } from "@ccp/shared/providers/types";
import type { Channel } from "@ccp/shared/types";
import { CHANNEL_CAPABILITIES, isPhoneChannel } from "@ccp/shared/providers/capabilities";
import { flagChannelNeedsReconnect } from "@/lib/providers/channel-health";
import { enqueueBroadcastMaterialize } from "@/lib/broadcasts/materialize-queue";
import { enqueueScheduledBroadcast } from "@/lib/broadcasts/schedule-queue";
import {
  createAccountRouter,
  isSocialFanOut,
  type AccountRouter,
} from "@/lib/broadcasts/social-account-router";
import {
  acquireSendToken,
  resolveSendRate,
  sendRateLimiterEnabled,
  resolveSocialSendRate,
} from "@/lib/broadcasts/send-rate-limiter";
import { getWhatsappHealth } from "@/lib/providers/meta-health";

/** Resolved send binding for one channel — the provider + its per-team config. */
type ChannelBinding = { provider: MessagingProvider; config: unknown };

/**
 * errorMessage stamped on recipients finalized by `BroadcastsService.cancel()`
 * (queued → failed for recipients that never sent). Also the marker
 * `retryFailed()` filters OUT so a deliberately-canceled audience is never
 * re-sent (billed Meta template sends are irreversible), AND the signal the
 * post-send reconcile below keys on: a lane that had pulled a recipient but not
 * yet created its `bc-recipient-<id>` attempt row is invisible to cancel()'s
 * in-flight snapshot, so cancel() can flip a recipient this runner is mid-send
 * to failed+marker; the queued→sent CAS then matches 0 rows even though Meta
 * accepted. This constant lets that path detect its own send landed and reconcile.
 * Owned here (not in broadcasts.service.ts) because the service already imports
 * from this module — the reverse edge would be circular. Keep the string stable.
 */
export const CANCEL_RECIPIENT_MARKER =
  "Broadcast canceled before this recipient was sent.";
import {
  parseVariableBindings,
  resolveBinding,
  type VariableBindings,
} from "@ccp/shared/template-bindings";
import { extractFieldTokens, resolveFieldTokens } from "@ccp/shared/field-tokens";
import { computeWindowStatus } from "@ccp/shared/utils/window";
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
 * Rate: `resolveSendPacing` picks `lanes` workers each leaving `gapMs` between
 * its own sends, adaptively from the WhatsApp number's throughput level, always
 * deliberately UNDER Meta's per-number ceiling so a burst can't drag the
 * number's quality rating down. See `resolveSendPacing` for what the resulting
 * rate actually is — it is NOT lanes÷gap. All knobs are env-tunable.
 */

/**
 * Send pacing. A broadcast runs `lanes` workers, each pausing `gapMs` between
 * its own sends.
 *
 * DO NOT read the rate as `lanes ÷ gapMs`. That was the original claim here and
 * it is wrong by 5–7×: a lane awaits the Meta round-trip AND ~6–8 DB queries
 * BEFORE it sleeps, so the real per-lane period is `work + gapMs`, not `gapMs`.
 * With a typical ~500ms Meta call the honest figures are:
 *
 *   level     lanes/gap    naive claim   realistic     100k ETA
 *   baseline  5 / 200ms    25 msg/s      ~8-10 msg/s   ~3 hours
 *   STANDARD  8 / 125ms    64 msg/s      ~15 msg/s     ~1.9 hours
 *   HIGH      16 / 60ms    266 msg/s     ~35 msg/s     ~48 minutes
 *
 * These are estimates from the loop's structure, not measurements — treat them
 * as the right ORDER of magnitude and re-measure before quoting an SLA.
 *
 * Second ceiling, easy to miss: effective concurrency is
 * `min(lanes, perTeamRecipientConcurrency())`, and that per-team cap defaults to
 * 16 — exactly the HIGH lane count. So HIGH is already at the cap, and a team
 * running TWO campaigns at once splits those 16 slots between them, roughly
 * halving each. Raise BROADCAST_PER_TEAM_RECIPIENT_CONCURRENCY with the lane
 * count, or concurrent campaigns silently serialize.
 *
 * WhatsApp exposes a per-number THROUGHPUT LEVEL (STANDARD ~80 msg/s, HIGH up to
 * ~1000 msg/s — Meta's ceilings, which we stay well under). Being under is what
 * protects the number's quality rating: over-driving triggers 130429s that drag
 * quality down into a tier downgrade. Being far under, as above, is safe but
 * slow — the operator must expect a multi-hour 100k send, which also means every
 * Meta signal validated at t=0 is stale for most of the run.
 * All four knobs are env-tunable so ops can retune without a deploy.
 */
function envInt(name: string, def: number, min: number, max: number): number {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(raw) || raw < min || raw > max) return def;
  return raw;
}
interface SendPacing {
  lanes: number;
  gapMs: number;
}
/**
 * Resolve pacing for a run from the channel + the number's throughput level.
 * `throughputLevel` is null for social channels and for a WhatsApp number we've
 * never polled — both fall to the conservative baseline.
 */
/**
 * Lanes needed to SUSTAIN a target rate, from Little's Law:
 * `concurrency = rate × latency`.
 *
 * This is what lets one process serve every Meta tier without a second
 * container. Meta auto-scales a healthy number 250 → 2K → 10K → 100K, and the
 * matching throughput level moves STANDARD → HIGH, so the lane count has to
 * move with it — a fixed 16 lanes tops out around 60 msg/s no matter what tier
 * the number reaches (16 lanes ÷ ~260ms per send).
 *
 * Deriving it instead: at 900 msg/s and ~250ms round-trip that is ~225 in-flight
 * requests. These are I/O waits, not CPU — Node carries them comfortably, and
 * each send touches the DB for only a few ms of its ~250ms life, so the 50-slot
 * Prisma pool sees a handful in use, not 225.
 *
 * Two independent things keep this safe: the per-NUMBER token bucket is the
 * rate authority (concurrency can never push past Meta's ceiling), and the
 * process-wide in-flight ceiling below bounds total work regardless of how many
 * broadcasts run at once.
 */
export function lanesForRate(ratePerSec: number): number {
  const latencyMs = envInt("BROADCAST_ASSUMED_SEND_LATENCY_MS", 250, 50, 5_000);
  const needed = Math.ceil(ratePerSec * (latencyMs / 1_000));
  return Math.max(1, Math.min(needed, MAX_LANES_PER_RUN));
}

/** Hard ceiling on lanes for a single run — a config typo can't uncap it. */
const MAX_LANES_PER_RUN = 256;

function resolveSendPacing(
  channel: Channel,
  throughputLevel: string | null,
  limiterActive: boolean,
  /** COEXISTENCE — Meta's fixed 20 msg/s ceiling; see `resolveSendRate`. */
  isOnBusinessApp?: boolean | null,
): SendPacing {
  // When the token bucket is enforcing the rate, IT is the authority: lanes are
  // sized to sustain that rate and the fixed inter-send gap goes to zero (the
  // send loop already skips the gap in this mode). With the bucket off we keep
  // the historical static pacing byte-for-byte, so enabling the bucket is the
  // single switch that changes send behaviour.
  //
  // `limiterActive` is the RUN's authority, not the env flag alone: a run
  // that never acquires tokens taking this branch would get gapMs 0 with NO
  // rate authority at all — full-speed unpaced lanes. Such a run must fall
  // through to the static gap pacing below.
  if (limiterActive && channel === "whatsapp") {
    return {
      lanes: lanesForRate(resolveSendRate(throughputLevel, isOnBusinessApp)),
      gapMs: 0,
    };
  }
  // COEXISTENCE, static-pacing mode. Handled BEFORE the throughput ladder because
  // Meta's 20/s cap replaces the ladder rather than sitting inside it — a
  // Coexistence number reporting HIGH must not get 16 lanes at a 60ms gap
  // (~266/s). 2 lanes × 125ms ≈ 16/s, under the 20 ceiling with the same margin
  // the bucket path keeps.
  if (channel === "whatsapp" && isOnBusinessApp === true) {
    return {
      lanes: envInt("BROADCAST_SEND_CONCURRENCY_COEXISTENCE", 2, 1, MAX_LANES_PER_RUN),
      gapMs: envInt("BROADCAST_SEND_GAP_MS_COEXISTENCE", 125, 0, 5_000),
    };
  }
  if (channel === "whatsapp" && throughputLevel === "HIGH") {
    return {
      lanes: envInt("BROADCAST_SEND_CONCURRENCY_HIGH", 16, 1, MAX_LANES_PER_RUN),
      gapMs: envInt("BROADCAST_SEND_GAP_MS_HIGH", 60, 0, 5_000),
    };
  }
  if (channel === "whatsapp" && throughputLevel === "STANDARD") {
    return {
      lanes: envInt("BROADCAST_SEND_CONCURRENCY_STANDARD", 8, 1, MAX_LANES_PER_RUN),
      gapMs: envInt("BROADCAST_SEND_GAP_MS_STANDARD", 125, 0, 5_000),
    };
  }
  return {
    lanes: envInt("BROADCAST_SEND_CONCURRENCY", 5, 1, 64),
    gapMs: envInt("BROADCAST_SEND_GAP_MS", 200, 0, 5_000),
  };
}
/**
 * Hard cap on recipients per broadcast. Historically 10k because the whole
 * recipient list was loaded into memory in the create request. That constraint
 * is gone: recipients are cursor-paged in `runBroadcast` (only ~PAGE_SIZE rows
 * live at once) and, for a LARGE audience, inserted asynchronously by the
 * broadcast-materialize worker rather than in the create transaction. So the cap
 * is now a policy ceiling (bound a single team's blast radius / Meta spend), not
 * a memory limit — configurable via BROADCAST_MAX_RECIPIENTS (default 100k), and
 * clamped to a hard ceiling so a config typo can't uncap it. The runner + the
 * create path both read this.
 *
 * NOTE: reaching 100k unique customers/24h ALSO requires the WhatsApp number to
 * be at the 100K/Unlimited messaging-limit tier — enforced separately by the
 * pre-send eligibility gate (see meta-health.ts). This cap is our side; the tier
 * is Meta's side.
 */
const MAX_RECIPIENTS_HARD_CEILING = 250_000;
export const MAX_RECIPIENTS_IN_PROCESS: number = (() => {
  const raw = Number.parseInt(process.env.BROADCAST_MAX_RECIPIENTS ?? "100000", 10);
  if (!Number.isFinite(raw) || raw <= 0) return 100_000;
  return Math.min(raw, MAX_RECIPIENTS_HARD_CEILING);
})();

/**
 * Audiences at or below this size are materialized SYNCHRONOUSLY inside the
 * create request (one bounded transaction) and the runner fires immediately —
 * the fast path for the overwhelming majority of broadcasts, unchanged from
 * before. Larger audiences are staged on the row and their BroadcastRecipient
 * rows are inserted by the broadcast-materialize worker, because a create-time
 * transaction inserting tens of thousands of rows exceeds Prisma's interactive-
 * tx budget and rolls the whole broadcast back. Hand-picked audiences
 * (selected/custom) are capped at MAX_AUDIENCE_IDS (5k) upstream, so only
 * all/by_tag/group audiences ever cross this line.
 */
export const SYNC_MATERIALIZE_MAX = 5_000;

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

/**
 * WhatsApp PAIR rate limit (131056) — scoped to (number, recipient), NOT the
 * number. One recipient mid-heavy-conversation when a campaign fires must not
 * engage the number-wide machinery above (streak → cross-lane pause → whole-run
 * park); instead that single recipient is retried and, if still limited,
 * DEFERRED — pushed back onto the in-memory queue with a not-before timestamp —
 * while every lane keeps sending to everyone else.
 *
 * The numbers come from Meta's published pair limit: one message per 6s
 * sustained, with a ~45-message burst allowance that BORROWS future quota — a
 * fully drained burst needs ~45 × 6s ≈ 4.5 min to repay. So:
 *   - first in-lane retry waits ONE token period (6.5s) — the 3s number-level
 *     sleep is guaranteed wasted against a 6s refill;
 *   - each defer waits 90s, and 3 defers (+ retries) cover the worst-case
 *     burst debt before the recipient is honestly failed (`rate_limited`,
 *     retryable later via the campaign report's Retry-failed).
 */
const PAIR_LIMIT_RETRY_MS = 6_500;
const PAIR_LIMIT_DEFER_MS = 90_000;
const PAIR_LIMIT_MAX_DEFERS = 3;
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
  headerMedia?: {
    kind: "image" | "video" | "document";
    /** Exactly one of link/id — see TemplateHeaderMedia. */
    link?: string;
    id?: string;
    filename?: string;
  };
  /**
   * Carousel cards, campaign-level. The count is fixed by the approved
   * template, so this is a straight pass-through of what the composer collected.
   */
  cards?: Array<{
    kind: "image" | "video";
    link?: string;
    id?: string;
    body?: string[];
    buttons?: Array<{
      index: number;
      subType: "url" | "quick_reply" | "copy_code";
      text: string;
    }>;
  }>;
  /** The pin for a LOCATION-header template — one place for every recipient. */
  headerLocation?: {
    latitude: string;
    longitude: string;
    name?: string;
    address?: string;
  };
  /** Countdown expiry for a LIMITED_TIME_OFFER template, UNIX milliseconds. */
  limitedTimeOfferExpiresAtMs?: number;
  /** Tap-target CTA override — one destination/title for the campaign. */
  tapTarget?: { url: string; title: string };
  /**
   * TOP-LEVEL button values — the campaign's coupon code / shared URL suffix.
   * One value per button for every recipient, validated against
   * `requiredTemplateButtonParams` at create.
   */
  buttons?: Array<{
    index: number;
    subType: "url" | "quick_reply" | "copy_code";
    text: string;
  }>;
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
 * process). Keyed by workspaceId; the entry is dropped when the team goes idle so
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

function tryAcquireBroadcastTeamSlot(workspaceId: string): boolean {
  const cap = perTeamBroadcastConcurrency();
  let entry = broadcastTeamSlots.get(workspaceId);
  if (!entry) {
    entry = { active: 0 };
    broadcastTeamSlots.set(workspaceId, entry);
  }
  if (entry.active >= cap) return false;
  entry.active += 1;
  return true;
}

function releaseBroadcastTeamSlot(workspaceId: string): void {
  const entry = broadcastTeamSlots.get(workspaceId);
  if (!entry) return;
  entry.active = Math.max(0, entry.active - 1);
  if (entry.active === 0) broadcastTeamSlots.delete(workspaceId);
}

/**
 * GLOBAL concurrent-broadcast ceiling — the missing half of the pair. The
 * per-team gate above bounds ONE team; it says nothing about the whole
 * process. With ~30 tenants each allowed 2 concurrent broadcasts, the
 * worst-case in-flight lane count was 30 × 2 × 16 = 960 concurrent
 * recipient sends: far past the Prisma pool, the Meta call budget, and the
 * heap headroom of a 2GB api container — and it would starve the inbox
 * (REST + Socket.io share this event loop) for every other tenant at once.
 * Per-team fairness does not imply a survivable total.
 *
 * The runner's own comments already referenced `MAX_RUNNING_BROADCASTS` as
 * though it existed; it never did. This is that constant.
 *
 * Default 6 concurrent broadcasts → a worst-case 6 × 16 = 96 in-flight
 * recipient sends, which the pool and the Meta budget absorb comfortably.
 * A broadcast that can't claim a global slot stays `queued` and re-attempts
 * on the same defer timer as the per-team path, so nothing is dropped —
 * throughput is deferred, never lost. Tunable via MAX_RUNNING_BROADCASTS.
 *
 * Single-process only, like every other in-memory gate here; a second app
 * instance needs Redis counters (deferred — see CLAUDE.md §16).
 */
function maxRunningBroadcasts(): number {
  const raw = Number.parseInt(process.env.MAX_RUNNING_BROADCASTS ?? "6", 10);
  return Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : 6;
}

let runningBroadcastCount = 0;

function tryAcquireGlobalBroadcastSlot(): boolean {
  if (runningBroadcastCount >= maxRunningBroadcasts()) return false;
  runningBroadcastCount += 1;
  return true;
}

function releaseGlobalBroadcastSlot(): void {
  runningBroadcastCount = Math.max(0, runningBroadcastCount - 1);
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
 * Tunable via BROADCAST_PER_TEAM_RECIPIENT_CONCURRENCY (default 16 — at least the
 * HIGH-throughput lane count so a single large broadcast on a HIGH-throughput
 * number isn't throttled below its resolved pacing; a team running several
 * broadcasts still can't exceed this shared in-flight ceiling). The effective
 * per-run rate is min(pacing.lanes, this cap), so this must be ≥ the largest
 * pacing.lanes (16) or it silently caps throughput.
 *
 * Keyed by workspaceId. Entry is dropped when the team has zero active + zero
 * waiters so the Map stays bounded with one entry per actively-sending team.
 */
export function perTeamRecipientConcurrency(): number {
  const raw = Number.parseInt(
    process.env.BROADCAST_PER_TEAM_RECIPIENT_CONCURRENCY ?? "",
    10,
  );
  if (Number.isFinite(raw) && raw > 0 && raw <= MAX_LANES_PER_RUN) return raw;
  // DEFAULT SCALES WITH THE TIER. The effective per-run rate is
  // `min(pacing.lanes, this cap)`, so a fixed 16 here would silently pin a
  // HIGH-throughput number to ~16 in-flight sends however many lanes it
  // resolved — exactly the "raise one knob, forget its twin" trap the old
  // hardcoded pair had. Sized to the largest lane count the rate limiter can
  // ask for so a single big broadcast is never throttled below its number's
  // allowance; the PROCESS-wide ceiling below is what actually bounds total
  // work when several teams send at once.
  return sendRateLimiterEnabled()
    ? lanesForRate(resolveSendRate("HIGH"))
    : 16;
}

/**
 * PROCESS-WIDE in-flight send ceiling — the missing half of the per-team cap.
 *
 * `MAX_RUNNING_BROADCASTS` bounds how many broadcasts run, and the per-team cap
 * bounds one tenant's share, but neither bounds the SUM: 6 concurrent
 * broadcasts × 225 lanes is ~1,350 simultaneous Meta calls in the same process
 * that serves the inbox. A per-tenant cap with no global ceiling is a bug class
 * this codebase has shipped before, so the global gate is explicit here.
 *
 * The token bucket limits the rate PER NUMBER; this limits total concurrent
 * work in THIS process, which is what protects inbox latency and the Prisma
 * pool. Default is one tier's worth of lanes plus headroom.
 */
export function globalSendConcurrency(): number {
  const raw = Number.parseInt(process.env.BROADCAST_GLOBAL_SEND_CONCURRENCY ?? "", 10);
  if (Number.isFinite(raw) && raw > 0 && raw <= 1_000) return raw;
  return sendRateLimiterEnabled() ? 300 : 64;
}

let globalSendActive = 0;
const globalSendWaiters: Array<() => void> = [];

async function acquireGlobalSendSlot(): Promise<void> {
  const cap = globalSendConcurrency();
  if (globalSendActive < cap) {
    globalSendActive += 1;
    return;
  }
  await new Promise<void>((resolve) => globalSendWaiters.push(resolve));
}

function releaseGlobalSendSlot(): void {
  const next = globalSendWaiters.shift();
  // Hand the slot straight to the waiter — `globalSendActive` never dips, so a
  // concurrent arrival can't observe a phantom free slot (same ownership-
  // transfer invariant as the per-team gate).
  if (next) next();
  else globalSendActive = Math.max(0, globalSendActive - 1);
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

function getOrCreateRecipientSlotEntry(workspaceId: string): TeamRecipientSlotState {
  let entry = teamRecipientSlots.get(workspaceId);
  if (!entry) {
    entry = { active: 0, waiters: [], lastWarnAt: 0 };
    teamRecipientSlots.set(workspaceId, entry);
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
async function acquireTeamRecipientSlot(workspaceId: string): Promise<void> {
  const cap = perTeamRecipientConcurrency();
  const entry = getOrCreateRecipientSlotEntry(workspaceId);
  if (entry.active < cap) {
    entry.active += 1;
    return;
  }
  if (entry.waiters.length >= RECIPIENT_QUEUE_DEPTH_WARN) {
    const now = Date.now();
    if (now - entry.lastWarnAt > RECIPIENT_QUEUE_WARN_INTERVAL_MS) {
      entry.lastWarnAt = now;
      console.warn(
        `[broadcast] team ${workspaceId} starving on recipient slots: ${entry.waiters.length} waiter(s), cap=${cap}`,
      );
    }
  }
  await new Promise<void>((resolve) => {
    entry.waiters.push(resolve);
  });
  // `active` was already incremented by the releasing caller when it
  // dequeued us — DO NOT bump again here.
}

function releaseTeamRecipientSlot(workspaceId: string): void {
  const entry = teamRecipientSlots.get(workspaceId);
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
    teamRecipientSlots.delete(workspaceId);
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
  // here avoids the wasted workspaceId lookup + slot churn.
  if (inFlightRuns.has(broadcastId)) return;

  // Per-team concurrency gate. Resolve the owning team cheaply (PK lookup,
  // workspaceId only) so we can cap concurrent broadcasts per team.
  const owner = await db.broadcast.findUnique({
    where: { id: broadcastId },
    select: { workspaceId: true, status: true },
  });
  if (!owner) {
    console.warn(`[broadcast ${broadcastId}] not found at start`);
    return;
  }
  // Only `queued` rows are runnable; anything else is already claimed /
  // terminal and runBroadcast would bail anyway.
  if (owner.status !== "queued") return;

  if (!tryAcquireBroadcastTeamSlot(owner.workspaceId)) {
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

  // Global ceiling. Claimed AFTER the team slot so the release paths stay
  // symmetric — on refusal we hand the team slot straight back, otherwise a
  // process at the global cap would leak one team slot per deferred attempt
  // and permanently wedge that team below its own cap.
  if (!tryAcquireGlobalBroadcastSlot()) {
    releaseBroadcastTeamSlot(owner.workspaceId);
    console.warn(
      `[broadcast ${broadcastId}] deferred: process at the global ` +
        `concurrent-broadcast cap (${maxRunningBroadcasts()})`,
    );
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
      releaseBroadcastTeamSlot(owner.workspaceId);
      releaseGlobalBroadcastSlot();
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

  // A FRESH run must never inherit the previous one's fatal-pause signal, or
  // every lane exits on its first check and the broadcast sends nothing —
  // silently, since the row simply completes with its recipients untouched.
  //
  // The run tail clears this flag, so it is normally already gone. It survives
  // in one case: the flag was set from OUTSIDE a live run — which is exactly
  // what `pauseBroadcastsForTemplate` does off a webhook — against a row that
  // said `running` while no runner was actually executing (an orphan awaiting
  // the boot reconciler). Clearing on claim makes that unreachable rather than
  // relying on every setter to have picked the right moment.
  FATAL_PAUSE.delete(broadcast.id);

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

  // The omnichannel `customer` mode was REMOVED 2026-07-27 (a broadcast is
  // strictly single-channel, single sending account). A legacy customer-mode
  // row can still reach here — scheduled or parked `paused` before the
  // removal, then fired/resumed after deploy. Running it through the
  // single-channel path would misroute its mixed-channel recipients out one
  // number, so refuse loudly instead: fail with a reason the operator can act
  // on (recreate as per-channel campaigns).
  if (broadcast.targetMode === "customer") {
    await fail(
      broadcast.id,
      'This campaign used the removed "People (best channel)" mode. Recreate it as one broadcast per channel.',
    );
    return;
  }

  // Resolve the send binding: ONE channel (`broadcast.channel`) with the
  // park-on-missing-creds recovery below. `bindingByChannel` holds that single
  // entry; `processOneRecipient` resolves it per recipient.
  const bindingByChannel = new Map<Channel, ChannelBinding>();
  // FAN-OUT campaigns pin no account, so there is no single run-level config to
  // resolve — and trying would actively break them: `getSendConfig(null)` on a
  // workspace with two Pages is deliberately AMBIGUOUS (`ACCOUNT_UNRESOLVED`),
  // which the block below would read as "not connected" and park the whole
  // campaign as paused. Every recipient carries its own account instead.
  const fanOut = isSocialFanOut(broadcast.channel, broadcast.channelConnectionId);
  if (fanOut) {
    const binding = getProviderBinding(broadcast.channel);
    if (broadcast.kind === "template" && !binding.provider.sendTemplate) {
      await fail(broadcast.id, "provider does not support templates");
      return;
    }
    // `config: null` is load-bearing, not a placeholder: a fan-out recipient
    // MUST resolve its own account, and a recipient carrying no account stamp
    // has never messaged any of these Pages — so there is no id to address and
    // it is failed individually below rather than sent with a guessed account.
    bindingByChannel.set(broadcast.channel, { provider: binding.provider, config: null });
  }
  if (!fanOut) {
    // Route to the broadcast's ACTUAL channel: template broadcasts are WhatsApp;
    // freeform broadcasts carry their own channel (Messenger / Instagram).
    const binding = getProviderBinding(broadcast.channel);
    let config;
    try {
      // Send from the ACCOUNT the campaign was bound to at creation — the
      // specific WhatsApp number / Page / handle the operator chose, and the one
      // whose contacts the audience was scoped to. Falling through to the
      // channel default (null) would put the campaign out on a different sender
      // identity than the one the audience and the template were picked for.
      config = await binding.getSendConfig(
        broadcast.workspaceId,
        broadcast.channelConnectionId,
      );
    } catch (err) {
      const msg =
        err instanceof ProviderNotConfiguredError
          ? `${broadcast.channel} not connected: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      // RECOVERABLE, not terminal: creds missing/expired at run start — the
      // exact dead-credential class the permanent-error breaker parks mid-run.
      // Park the row `paused` (NOT `failed`) so the boot reconciler resumes it
      // once creds are fixed. CAS on status='queued' (fires BEFORE the
      // queued→running claim below): every recipient is still `queued`, so the
      // per-recipient queued→sent CAS on resume sends each exactly once.
      const parked = await db.broadcast.updateMany({
        where: { id: broadcast.id, status: "queued" },
        data: {
          status: "paused",
          pausedAt: new Date(),
          pausedReason: "not_connected",
          lastError: msg.slice(0, 1000),
        },
      });
      if (parked.count === 0) return; // already canceled / claimed elsewhere
      console.warn(
        `[broadcast ${broadcast.id}] ${broadcast.channel} not connected at fire time — parked as paused (reconciler resumes on next restart once creds are fixed)`,
      );
      await publish({
        type: "broadcast.status_changed",
        workspaceId: broadcast.workspaceId,
        broadcastId: broadcast.id,
        status: "paused",
        error: msg,
      });
      return;
    }

    const provider = binding.provider;
    // Only template broadcasts need the template send method; freeform broadcasts
    // send via `sendText` (always present). A social provider has no `sendTemplate`.
    if (broadcast.kind === "template" && !provider.sendTemplate) {
      await fail(broadcast.id, "provider does not support templates");
      return;
    }
    bindingByChannel.set(broadcast.channel, { provider, config });
  }

  // Per-run resolver for the FAN-OUT case: a social campaign whose recipients
  // were stamped with their own account at materialize time. Caches per account
  // (including known-bad ones) so a 100k run resolves each account once.
  const accountRouter = createAccountRouter(broadcast.workspaceId, broadcast.channel);

  const variables = parseVariables(broadcast.variables);
  // Hoist what doesn't change between recipients. TEMPLATE broadcasts load the
  // template body + bindings + run the variable-count guard. FREEFORM broadcasts
  // (Messenger/Instagram) carry a plain `bodyText` and skip all of that.
  const template =
    broadcast.kind === "template"
      ? await loadTemplate(broadcast.workspaceId, broadcast.templateId!)
      : null;
  const templateBody = template?.bodyText ?? "";
  const bindings = parseVariableBindings(template?.variableBindings ?? null);
  // Meta's own answer for this template, stored at sync time. NOT inferred from
  // the body text: a positional template containing `{{order_id}}` as literal
  // copy would be misread, and the wrong wire shape fails every recipient.
  const templateParameterFormat: "named" | "positional" =
    template?.parameterFormat === "named" ? "named" : "positional";
  // Placeholder names in FIRST-APPEARANCE order — the order the composer
  // collected values in, and therefore the order we zip them back in.
  const namedBodyVars =
    templateParameterFormat === "named" ? templateNamedPlaceholders(templateBody) : [];
  const headerText = (Array.isArray(template?.components) ? template.components : [])
    .map((c) =>
      c && typeof c === "object" ? (c as { type?: string; format?: string; text?: string }) : null,
    )
    .find((c) => c?.type === "HEADER" && c?.format === "TEXT")?.text;
  const namedHeaderVar =
    templateParameterFormat === "named" && headerText
      ? templateNamedPlaceholders(headerText)[0]
      : undefined;

  // One object rather than three more positional params on an already-8-arg
  // function — and it keeps the three facts that must agree together.
  const wireFormat: TemplateWireFormat = {
    parameterFormat: templateParameterFormat,
    namedBodyVars,
    ...(namedHeaderVar ? { namedHeaderVar } : {}),
  };

  if (template) {
    // A button carrying a send-time parameter (dynamic URL suffix / coupon
    // copy-code) still can't be filled from a broadcast — there is no
    // per-recipient button UI — so Meta would reject every recipient. Fail the
    // whole broadcast HERE, before the CAS claim and before one message is sent,
    // rather than burning the audience on a guaranteed rejection.
    // Category included: an authentication template's OTP button is rewritten
    // by Meta to type `url`, so it is only recognizable from the category.
    const requiredButtons = requiredTemplateButtonParams(
      template.components,
      template.category,
    );
    if (requiredButtons.length > 0) {
      await fail(
        broadcast.id,
        `Template has button(s) needing a send-time value (${requiredButtons
          .map((b) => `#${b.index + 1} ${b.subType}`)
          .join(", ")}), which broadcasts can't supply.`,
      );
      return;
    }
    // Named templates ARE broadcastable. The composer collects one value per
    // named placeholder in FIRST-APPEARANCE order, and the runner zips that
    // array back against the placeholder names below — so `Broadcast.variables`
    // keeps its `{ body: string[] }` shape and no data migration was needed.
    //
    // The count guard adapts to the format: a named body's expected count is
    // the number of DISTINCT names, not the highest `{{n}}`.
    const bodyVarCount =
      templateParameterFormat === "named"
        ? namedBodyVars.length
        : countTemplatePlaceholders(templateBody);
    if (variables.body.length !== bodyVarCount) {
      await fail(
        broadcast.id,
        `Variable count mismatch: template expects ${bodyVarCount}, broadcast has ${variables.body.length}. Template may have changed since the broadcast was created.`,
      );
      return;
    }
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

  // ── Header media: upload ONCE, reuse for the whole run ───────────────────
  //
  // With a `link`, Meta fetches our R2 object once PER RECIPIENT — 100,000
  // fetches for a 100k campaign, each one a chance for a transient fault to fail
  // a recipient for no reason. Meta's own guidance is to upload the asset and
  // send its media `id` instead, so nothing is fetched from us at all.
  //
  // Whether one media id may be reused across many messages is NOT something we
  // could confirm from Meta's docs (see lib/templates/), and a
  // broadcast is billed and irreversible — so this does not bet on the answer.
  // The id is used optimistically and `mediaState` FALLS BACK to the per-
  // recipient presigned link the first time an id-mode send fails, retrying that
  // recipient on the link so nobody is lost either way:
  //   - ids reusable   → one upload, zero R2 fetches, full win;
  //   - ids single-use → recipient #2 fails once, is retried on the link, and the
  //                      run finishes on links exactly as it does today.
  const mediaState = await prepareBroadcastMedia(broadcast, bindingByChannel);

  // Sending resets Meta's 12-month auto-archival clock. Stamped ONCE per run,
  // not per recipient: a 100k campaign is one use of the template, and a write
  // per recipient would add 100k pointless updates to the hot send path.
  // Fire-and-forget — a failure here costs an archival warning, never a send.
  if (broadcast.templateId) {
    void db.messageTemplate
      .updateMany({
        where: { id: broadcast.templateId, workspaceId: broadcast.workspaceId },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => undefined);
  }

  await publish({
    type: "broadcast.status_changed",
    workspaceId: broadcast.workspaceId,
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
  // Recipient page size. A 100k broadcast is NEVER loaded whole — lanes pull
  // from this queue while it refills from a keyset cursor, so memory is bounded
  // by the page, not the audience.
  //
  // It must stay comfortably ABOVE the lane count or lanes idle waiting on a
  // refill: at ~225 lanes a 100-row page drains in a fraction of a second and
  // every lane blocks on the same DB round-trip. 500 gives roughly two pages of
  // runway at the highest tier while staying small enough that the rows (and
  // their contact JSON) are a trivial slice of heap. Unchanged at 100 when the
  // rate limiter is off, so low-throughput behaviour is byte-identical.
  const PAGE_SIZE = sendRateLimiterEnabled() ? 500 : 100;
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
    // The person this recipient stood for at CREATE time. Only populated by
    // the removed customer-mode (2026-07-27) — kept in the select so legacy
    // rows keep their shape; new rows always carry null.
    customerId: true,
    // Pre-drawn campaign assignee (lib/assignment/broadcast-plan.ts), applied
    // after a successful send.
    assignedUserId: true,
    // WHICH ACCOUNT to send this recipient from, stamped at materialize time.
    // Null = use the campaign's own account (every WhatsApp campaign and every
    // single-account social run). See resolve-recipient-accounts.ts.
    channelConnectionId: true,
    contact: {
      select: {
        id: true,
        name: true,
        // CURRENT owner of this contact (person link).
        customerId: true,
        // Drives the conversation/message channel stamp.
        identityChannel: true,
        phoneNumber: true,
        // Freeform (social) broadcasts dial the PSID/IGSID, not a phone.
        externalContactId: true,
        bsuid: true,
        parentBsuid: true,
        bsuidPortfolioId: true,
        email: true,
        location: true,
        // Drives the HUMAN_AGENT tag decision on freeform (social) sends — inside
        // the 24h window Meta wants messaging_type:RESPONSE (no tag).
        lastInboundAt: true,
        // Re-checked at SEND time (not just at audience-resolution time) so a
        // contact deleted AFTER the broadcast was created — the de-facto
        // opt-out path, most likely on a SCHEDULED broadcast whose create→fire
        // gap is hours/days — is skipped instead of getting a billed template.
        deletedAt: true,
        // Re-checked at SEND time for the same reason: create-time marketing
        // suppression can't cover a contact who opts out during the create→fire
        // gap of a scheduled MARKETING broadcast.
        marketingOptOutAt: true,
        // Same fire-time re-check: a contact blocked after create must be
        // skipped, not handed to Meta for a guaranteed rejection.
        blockedAt: true,
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
        customerId: true,
        assignedUserId: true,
        channelConnectionId: true,
        contact: {
          select: {
            id: true,
            name: true,
            customerId: true,
            identityChannel: true,
            phoneNumber: true,
            externalContactId: true,
            bsuid: true,
            parentBsuid: true,
            bsuidPortfolioId: true,
            email: true,
            location: true,
            lastInboundAt: true,
            deletedAt: true,
            marketingOptOutAt: true,
            blockedAt: true,
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
  // scope, not module-global). Double-publish safety (post I-3): the closed→
  // pending flip + `broadcast.conversation_reopened` publish are now DEFERRED to
  // after a successful send and guarded by a DB CAS (`updateMany where status:
  // "closed"` → publishes only when count>0). So even if two lanes both read a
  // cached `closed` status and both set `needsReopen`, exactly ONE CAS flips the
  // row and publishes; the loser's CAS returns 0 and stays silent. The cache
  // holds the pre-reopen status between resolve and post-send (then flips to
  // `pending` on the successful reopen) — a stale `closed` cache is expected and
  // harmless; the DB CAS, not the cache flip, is what dedupes the publish.
  const conversationCache = new Map<
    string,
    { id: string; status: string; unreadCount: number }
  >();

  // Pair-limit (131056) defer state — see the PAIR_LIMIT_* constants. Keyed by
  // recipient id. Per-run locals on purpose: a resume (pause / crash / restart)
  // starts the count fresh, which is correct — by then the pair window has had
  // ample time to repay.
  const pairDeferCounts = new Map<string, number>();
  const pairDeferNotBefore = new Map<string, number>();

  async function refill(): Promise<void> {
    if (exhausted) return;
    const page = await withTransientRetry(() =>
      db.broadcastRecipient.findMany({
        where: { broadcastId: broadcastId_, status: "queued" },
        select: RECIPIENT_SELECT,
        orderBy: { id: "asc" },
        take: PAGE_SIZE,
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      }),
    );
    if (page.length === 0) {
      exhausted = true;
      return;
    }
    cursorId = page[page.length - 1]!.id;
    queue.push(...page);
  }

  // Serialize refill across lanes. When several lanes drain the queue to 0 at a
  // page boundary they'd otherwise each call refill() concurrently with the
  // SAME cursorId (only reassigned after the awaited findMany resolves), fetch
  // the identical page, and push it twice — duplicate recipient processing.
  // Sharing one in-flight promise keeps the cursorId read strictly ordered so
  // duplicate pages are impossible.
  let refillInFlight: Promise<void> | null = null;
  const refillOnce = (): Promise<void> =>
    (refillInFlight ??= refill().finally(() => {
      refillInFlight = null;
    }));

  await refill();
  // Resolve send pacing from the number's throughput level (WhatsApp only;
  // social + never-polled numbers fall to the conservative baseline).
  // One health read per run — cheap, and the level rarely changes mid-run.
  // The ACCOUNT id matters: throughput is per-number, and this run sends from
  // the campaign's bound account — reading the workspace default would size
  // lanes and the bucket's fill rate off a different number's tier (a HIGH
  // default pacing a STANDARD second number at 900/s = sustained 130429s).
  //
  // The same read also yields `isOnBusinessApp` — a COEXISTENCE number (still in use
  // in the WhatsApp Business app) is hard-capped by Meta at 20 messages/second,
  // OUTSIDE the 80/1000 ladder that `throughput.level` reports. Meta still reports a
  // level for those numbers, so pacing off the level alone ran them 2-4x over a hard
  // ceiling.
  const health =
    broadcast.channel === "whatsapp"
      ? await getWhatsappHealth(
          broadcast.workspaceId,
          broadcast.channelConnectionId,
        ).catch(() => null)
      : null;
  const throughputLevel = health?.throughputLevel ?? null;
  const isOnBusinessApp = health?.isOnBusinessApp ?? null;
  const rateLimited = sendRateLimiterEnabled();
  const pacing = resolveSendPacing(
    broadcast.channel,
    throughputLevel,
    rateLimited,
    isOnBusinessApp,
  );
  const lanes = Math.min(pacing.lanes, queue.length);

  // Per-NUMBER send-rate ceiling (dark unless BROADCAST_RATE_LIMITER_ENABLED=1).
  // Keyed on the account, not the run: the ceiling belongs to the phone number,
  // so two campaigns on one number must share it — which a per-lane sleep can
  // never express. `rateKey` falls back to the workspace for channels with no
  // per-number concept, so the bucket is still a single shared ceiling there.
  // The resolved send config names the account this run sends from — and EVERY
  // live channel has one, so the workspace fallback should never fire:
  // `phoneNumberId` for WhatsApp, `pageId` for Messenger AND Instagram (IG sends
  // through its linked Page).
  //
  // Social used to have no per-account key at all, because this only read
  // `phoneNumberId`. Two Pages in one workspace therefore SHARED one bucket: they
  // throttled each other, and the aggregate could still overshoot because Meta's
  // limits are per PAGE. The fallback is kept only as a genuine last resort for a
  // channel with no account concept (the first-party web widget), not as the
  // routine social path it had become.
  const sendConfig = bindingByChannel.get(broadcast.channel)?.config as
    | { phoneNumberId?: string; pageId?: string }
    | undefined;
  const rateKey =
    sendConfig?.phoneNumberId ||
    sendConfig?.pageId ||
    `ws:${broadcast.workspaceId}:${broadcast.channel}`;
  // WhatsApp paces off Meta's throughput ladder + the Coexistence cap; social has
  // its own, unrelated Page limits. Feeding a social run through
  // `resolveSendRate` landed it on the WhatsApp BASELINE (40/s) purely because
  // `throughput.level` is null for a Page — the right number by accident, for the
  // wrong reason, and sitting exactly ON Meta's Page-inbox ceiling instead of under it.
  const sendRate =
    broadcast.channel === "whatsapp"
      ? resolveSendRate(throughputLevel, isOnBusinessApp)
      : resolveSocialSendRate(broadcast.channel === "instagram" ? "instagram" : "messenger");

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
    const row = await withTransientRetry(() =>
      db.broadcast.findUnique({
        where: { id: broadcastId_ },
        select: { status: true },
      }),
    );
    if (row?.status === "canceled") {
      canceled = true;
    }
    return canceled;
  }

  // The lane loop + completion tail are wrapped so a transient DB blip that
  // survives `withTransientRetry` (or any other unexpected throw inside a lane)
  // can't strand the broadcast `running` with no in-process recovery. On an
  // unexpected throw we CAS `running → paused` + publish (same resume contract
  // the shutdown / fatal-pause paths use; the boot reconciler picks it back up
  // and the per-recipient CAS prevents double-send). The `finally` always runs
  // the in-memory cleanup so the 429 / permanent-streak / progressThrottle Maps
  // can't leak on the throw path.
  try {
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
          await refillOnce();
          if (queue.length === 0) return;
        }
        const recipient = queue.shift();
        if (!recipient) return;
        // A pair-limit-deferred recipient is only retried after its not-before
        // timestamp. If the next queued recipient is ready NOW, rotate the
        // deferred one to the back and send to them instead — a defer must
        // never idle a lane mid-run. Only when nothing else is ready (the
        // drain tail) does the lane sleep out the remainder.
        const pairNotBefore = pairDeferNotBefore.get(recipient.id) ?? 0;
        if (pairNotBefore > Date.now()) {
          const head = queue[0];
          if (head && (pairDeferNotBefore.get(head.id) ?? 0) <= Date.now()) {
            queue.push(recipient);
            continue;
          }
          await sleep(pairNotBefore - Date.now());
          // The sleep can be 90s — re-run the loop-top exit checks before
          // sending. A recipient dropped here still has a `queued` DB row, so
          // the cancel finalize / boot reconciler accounts for them exactly
          // like any other not-yet-pulled row.
          if ((await checkCanceled()) || FATAL_PAUSE.has(broadcast.id) || shuttingDown) {
            return;
          }
        }
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
        // Rate gate BEFORE the Meta call, and before taking a team slot, so a
        // lane waiting on tokens isn't also holding a slot another team could
        // be using.
        // Bucket on the RECIPIENT's account when the campaign fans out, because
        // Meta's send ceilings are per Page: two Pages in one campaign must not
        // throttle each other, and their combined rate must not exceed either
        // one's limit. `rateKey` (the campaign's single account) is the fallback
        // and stays exactly right for WhatsApp and single-account social runs.
        //
        // The bucket key must be the PROVIDER's account id (binding.rateKey),
        // never our internal connection cuid: the run fallback and every other
        // broadcast key on the provider id, so a cuid-keyed bucket was a SECOND
        // bucket for the same Page — splitting one Page's traffic across two
        // buckets and pacing it past the documented ceiling. The router caches
        // per account, so this resolve is one config read per account per run.
        //
        // This is why the account is stamped on the recipient ROW at materialize
        // time rather than resolved during the send: this gate fires before the
        // recipient's conversation is ever read.
        if (rateLimited) {
          const recipientBinding = recipient.channelConnectionId
            ? await accountRouter.resolve(recipient.channelConnectionId)
            : null;
          await acquireSendToken(recipientBinding?.rateKey ?? rateKey, sendRate);
        }
        // Global gate BEFORE the per-team one: the process-wide ceiling is the
        // one protecting inbox latency, so it must bound every lane of every
        // running broadcast, not just one tenant's share.
        await acquireGlobalSendSlot();
        await acquireTeamRecipientSlot(broadcast.workspaceId);
        let deferSignal: "defer_pair_limit" | void;
        try {
          deferSignal = await processOneRecipient(
            broadcast,
            recipient,
            bindingByChannel,
            accountRouter,
            bindings,
            variables,
            templateBody,
            wireFormat,
            pendingBumps,
            conversationCache,
            mediaState,
          );
        } finally {
          // Release in reverse acquire order. Both are in the SAME finally so a
          // thrown recipient can never leak either slot — a leaked global slot
          // would permanently shrink the process's send capacity.
          releaseTeamRecipientSlot(broadcast.workspaceId);
          releaseGlobalSendSlot();
        }
        if (deferSignal === "defer_pair_limit") {
          const defers = (pairDeferCounts.get(recipient.id) ?? 0) + 1;
          if (defers > PAIR_LIMIT_MAX_DEFERS) {
            pairDeferCounts.delete(recipient.id);
            pairDeferNotBefore.delete(recipient.id);
            // ~5 minutes of retries didn't clear it — fail honestly rather
            // than hold the run's tail open forever. The reason stays
            // `rate_limited`, so the campaign report buckets this recipient
            // as RETRYABLE and Retry-failed re-sends them once the pair
            // window has repaid.
            await failRecipientAndCount(
              recipient.id,
              "WhatsApp is limiting how fast this person can be messaged (pair rate limit, code 131056) — retries over several minutes did not clear it. Use Retry failed to re-send them later.",
              broadcast.id,
              broadcast.workspaceId,
              pendingBumps,
              "rate_limited",
            );
          } else {
            pairDeferCounts.set(recipient.id, defers);
            pairDeferNotBefore.set(recipient.id, Date.now() + PAIR_LIMIT_DEFER_MS);
            queue.push(recipient);
            console.warn(
              `[broadcast ${broadcast.id}] recipient ${recipient.id} pair-rate-limited (131056) — defer ${defers}/${PAIR_LIMIT_MAX_DEFERS}, retry in ${PAIR_LIMIT_DEFER_MS / 1000}s`,
            );
          }
        } else if (pairDeferNotBefore.has(recipient.id)) {
          // A previously-deferred recipient resolved (sent, or failed for a
          // different reason) — drop the defer state so the maps stay small.
          pairDeferCounts.delete(recipient.id);
          pairDeferNotBefore.delete(recipient.id);
        }
        // The bucket, when on, IS the rate — the fixed gap on top of it would
        // only push the achieved rate below the target. When off, today's
        // pacing is byte-identical.
        if (!rateLimited && pacing.gapMs > 0) await sleep(pacing.gapMs);
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
    const paused = await db.broadcast.updateMany({
      where: { id: broadcast.id, status: "running" },
      data: { status: "paused", pausedAt: new Date(), pausedReason: "shutdown" },
    });
    console.warn(
      `[broadcast ${broadcast.id}] paused for shutdown — ${queuedRemaining} recipient(s) remain queued`,
    );
    // §10 again: a broadcast cancelled mid-shutdown already left `running`, so
    // the CAS matches nothing and there is no state change to announce.
    if (paused.count > 0) {
      await publish({
        type: "broadcast.status_changed",
        workspaceId: broadcast.workspaceId,
        broadcastId: broadcast.id,
        status: "paused",
      });
    }
  } else {
    // Normal completion. But a run where EVERY recipient failed must not be
    // stored as `completed` — that made it match the "Completed" filter while
    // the badge (count-aware) painted it red "All failed", so the Failed tab
    // showed nothing. Classify from the freshly-drained counters: all-failed →
    // the discrete `failed` enum (filter + badge + stored row now agree); a
    // partial failure stays `completed` (badge shows amber "N failed").
    const fresh = await db.broadcast.findUnique({
      where: { id: broadcast.id },
      select: { totalCount: true, failedCount: true },
    });
    const allFailed =
      !!fresh && fresh.totalCount > 0 && fresh.failedCount >= fresh.totalCount;
    const finalStatus = allFailed ? "failed" : "completed";
    const finished = await db.broadcast.updateMany({
      where: { id: broadcast.id, status: "running" },
      data: { status: finalStatus, completedAt: new Date() },
    });
    // §10: emit only after a state change that actually committed. A racing
    // cancel() flips the row out of `running` first, so this CAS matches 0 —
    // publishing anyway would tell every client the broadcast "completed" after
    // it was cancelled. Same guard cancel() and maybeTripPermanentBreaker use.
    if (finished.count > 0) {
      await publish({
        type: "broadcast.status_changed",
        workspaceId: broadcast.workspaceId,
        broadcastId: broadcast.id,
        status: finalStatus,
      });
    }
  }
  } catch (err) {
    // An unexpected throw (e.g. a persistent DB error that outlived
    // withTransientRetry) escaped the lane loop / completion tail. The
    // surviving exits above never ran, so the row would otherwise stay
    // `running` until the next process restart. Park it `paused` via the SAME
    // CAS contract the shutdown / fatal-pause paths use — gated on
    // status="running" so a racing cancel/complete wins — and publish so the
    // UI reflects it. The boot reconciler resumes a `paused` row and the
    // per-recipient CAS keeps already-sent recipients from re-sending.
    const message = errorDetail(err);
    console.error(`[broadcast ${broadcast.id}] runner errored mid-flight — pausing`, err);
    try {
      const paused = await db.broadcast.updateMany({
        where: { id: broadcast.id, status: "running" },
        data: {
          status: "paused",
          pausedAt: new Date(),
          pausedReason: "credentials",
          lastError: message.slice(0, 1000),
        },
      });
      if (paused.count > 0) {
        await publish({
          type: "broadcast.status_changed",
          workspaceId: broadcast.workspaceId,
          broadcastId: broadcast.id,
          status: "paused",
          error: message,
        });
      }
    } catch (pauseErr) {
      // The DB is still unreachable — nothing more we can do here. The boot
      // reconciler's `running`-orphan sweep is the last-resort recovery.
      console.error(
        `[broadcast ${broadcast.id}] failed to park as paused after mid-flight error`,
        pauseErr,
      );
    }
  } finally {
    // Always release in-memory state so the 429 / permanent-streak / pause /
    // throttle Maps can't leak on the throw path. All deletes are idempotent,
    // so re-running them after the happy-path cleanup above is a no-op.
    reset429Streak(broadcast.id);
    PAUSE_429.delete(broadcast.id);
    resetPermanentStreak(broadcast.id);
    FATAL_PAUSE.delete(broadcast.id);
    const t = progressThrottles.get(broadcast.id);
    if (t?.pendingTimer) clearTimeout(t.pendingTimer);
    progressThrottles.delete(broadcast.id);
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
/**
 * The wire shape a template's parameters must take, resolved ONCE per broadcast
 * from Meta's stored `parameter_format`.
 *
 * Grouped because the three facts must agree: a `named` format with an empty
 * name list would send zero body parameters and fail every recipient, and a
 * `positional` format carrying names would be silently ignored.
 */
interface TemplateWireFormat {
  parameterFormat: "named" | "positional";
  /** Placeholder names in first-appearance order — the order the composer
   *  collected values in, and therefore the order the runner zips them back. */
  namedBodyVars: string[];
  /** The header's single placeholder name, when the header is named-format. */
  namedHeaderVar?: string;
}

async function processOneRecipient(
  broadcast: {
    id: string;
    workspaceId: string;
    kind: "template" | "freeform";
    // "customer" never reaches here — runBroadcast refuses legacy omnichannel
    // rows up front (mode removed 2026-07-27); the type keeps the DB row shape.
    targetMode: "contact" | "customer";
    channel: Channel;
    /** The account this campaign sends from (permanent-breaker reconnect flag). */
    channelConnectionId: string | null;
    templateId: string | null;
    templateName: string | null;
    templateLanguage: string | null;
    templateCategory: string | null;
    bodyText: string | null;
    createdById: string | null;
    /** Whether this campaign may take over an already-assigned conversation. */
    assignmentOverwrite: boolean;
    /** "on_reply" (default) or "on_send" — see the assignment block below. */
    assignmentTrigger: string;
  },
  recipient: {
    id: string;
    contactId: string;
    /** The person this row stood for at CREATE time (customer-mode). */
    customerId: string | null;
    /** Assignee drawn at materialize time; null when the campaign assigns nobody. */
    assignedUserId: string | null;
    /**
     * The account this recipient must be sent from, stamped at materialize time.
     * Null = the campaign's own account. See resolve-recipient-accounts.ts.
     */
    channelConnectionId: string | null;
    contact: {
      id: string;
      name: string;
      /** CURRENT owner — differs from `recipient.customerId` after a merge. */
      customerId: string | null;
      identityChannel: Channel;
      phoneNumber: string | null;
      externalContactId: string | null;
      /** BSUID trio — the phone-less WhatsApp destination + portfolio guard. */
      bsuid: string | null;
      parentBsuid: string | null;
      bsuidPortfolioId: string | null;
      email: string | null;
      location: string | null;
      lastInboundAt: Date | null;
      deletedAt: Date | null;
      marketingOptOutAt: Date | null;
      blockedAt: Date | null;
      customFields: Prisma.JsonValue;
    };
  },
  bindingByChannel: Map<Channel, ChannelBinding>,
  /** Resolves per-account credentials when a social campaign fans out. */
  accountRouter: AccountRouter,
  bindings: VariableBindings,
  variables: BroadcastVariables,
  templateBody: string,
  wireFormat: TemplateWireFormat,
  pendingBumps: Set<Promise<unknown>>,
  // M5 — per-runBroadcast cache; avoids N+1 conversation.findFirst when
  // the same contact appears multiple times in a single broadcast.
  conversationCache: Map<string, { id: string; status: string; unreadCount: number }>,
  // Run-scoped header-media strategy. Shared by every lane BY REFERENCE so the
  // first id-mode failure disables the id for all of them at once, rather than
  // each lane rediscovering it.
  mediaState: BroadcastMediaState,
  // `"defer_pair_limit"`: the recipient hit WhatsApp's per-(number, recipient)
  // pair limit twice (row left `queued`, attempt claim released) — the lane
  // loop re-queues them with a not-before timestamp instead of the run-wide
  // park every other send error resolves to internally.
): Promise<"defer_pair_limit" | void> {
  // Resolve the broadcast's single channel + its provider binding. A missing
  // binding fails the recipient individually — never poisons the run.
  const sendChannel: Channel = broadcast.channel;
  const activeBinding = bindingByChannel.get(sendChannel);
  if (!activeBinding) {
    await failRecipientAndCount(
      recipient.id,
      `${sendChannel} is not connected.`,
      broadcast.id,
      broadcast.workspaceId,
      pendingBumps,
    );
    return;
  }
  // `provider` is identical for every account on a channel — only the
  // CREDENTIALS differ — so only `config` is per-recipient. That is what keeps
  // this change small: `sendTemplate`, `capabilities` and `useHumanAgentTag`
  // below are all provider-level and need no rework.
  const { provider } = activeBinding;
  let config = activeBinding.config;
  if (config === null && !recipient.channelConnectionId) {
    // Fan-out run, and this recipient has no account: they have never messaged
    // any of the connected Pages, so Meta has issued no id for them and there is
    // nothing to address. (Imported and manually-added contacts are exactly
    // this.) Fail the one recipient with a reason an operator can act on.
    await failRecipientAndCount(
      recipient.id,
      "This contact has never messaged any of your connected accounts, so there is no address to send to.",
      broadcast.id,
      broadcast.workspaceId,
      pendingBumps,
    );
    return;
  }
  if (recipient.channelConnectionId) {
    // Fan-out: this recipient's id was issued by a specific account and is
    // meaningless to any other, so it MUST go out from that one.
    const own = await accountRouter.resolve(recipient.channelConnectionId);
    if (!own) {
      // One disconnected account fails only ITS recipients. Failing the run
      // would be the blast-radius mistake fan-out exists to avoid — every other
      // account in the campaign is still perfectly able to send.
      await failRecipientAndCount(
        recipient.id,
        "The account this contact messaged is no longer connected.",
        broadcast.id,
        broadcast.workspaceId,
        pendingBumps,
      );
      return;
    }
    config = own.config;
  }

  // Capture the optional method once — providers without a template catalog
  // fail the recipient gracefully (vs throwing) so the rest of the broadcast
  // continues. Using the local const also keeps `sendTemplate` typed as
  // defined across the await points below.
  // Template broadcasts need the template send method; freeform broadcasts use
  // plain `sendText` (a required provider method, always present).
  const sendTemplate = provider.sendTemplate;
  const isFreeform = broadcast.kind === "freeform";
  // Meta social: inside the 24h free-form window Meta wants messaging_type:
  // RESPONSE (no tag); the HUMAN_AGENT tag is only for the 24h–7d support band.
  // Freeform broadcasts target IN-WINDOW recipients, so without deriving this
  // every social broadcast message would go out HUMAN_AGENT — tag misuse Meta
  // penalizes. Mirrors send-text-internal. Ignored by WhatsApp (window null).
  const freeFormMs = provider.capabilities.freeFormWindowMs;
  const useHumanAgentTag =
    freeFormMs !== null &&
    ["closed", "never"].includes(
      computeWindowStatus(
        recipient.contact.lastInboundAt?.toISOString() ?? null,
        Date.now(),
        freeFormMs,
      ).state,
    );
  if (!isFreeform && !sendTemplate) {
    await failRecipientAndCount(
      recipient.id,
      "provider does not support templates",
      broadcast.id,
      broadcast.workspaceId,
      pendingBumps,
    );
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
    await failRecipientAndCount(
      recipient.id,
      "Contact was deleted after the broadcast was created.",
      broadcast.id,
      broadcast.workspaceId,
      pendingBumps,
    );
    return;
  }
  // Re-check marketing opt-out at FIRE time. Create-time suppression
  // (broadcasts.service.ts) only sees opt-outs that existed when the broadcast
  // was built; a contact who opts out during the create→fire gap of a SCHEDULED
  // MARKETING template would otherwise still receive the billed send — a
  // compliance failure. Mirrors the create-time category gate: only MARKETING
  // templates suppress (utility/auth messages still reach an opted-out contact).
  // Distinct errorCode so retry buckets exclude these (a compliance skip is not
  // a transient failure to retry).
  const isMarketingTemplate =
    broadcast.kind === "template" &&
    (broadcast.templateCategory ?? "MARKETING").toUpperCase() === "MARKETING";
  if (isMarketingTemplate && recipient.contact.marketingOptOutAt) {
    await failRecipientAndCount(
      recipient.id,
      "Contact opted out of marketing after the broadcast was created.",
      broadcast.id,
      broadcast.workspaceId,
      pendingBumps,
      "marketing_opt_out",
    );
    return;
  }
  // Re-check the provider-level block at FIRE time, same reasoning as the two
  // guards above: the workspace can block a contact in the create→fire gap,
  // and Meta rejects every send to a blocked user anyway — skipping keeps the
  // campaign report honest ("blocked", not a generic provider failure) and
  // saves the doomed Graph call. Applies to EVERY kind, not just marketing —
  // a block stops all messaging, unlike a marketing opt-out.
  if (recipient.contact.blockedAt) {
    await failRecipientAndCount(
      recipient.id,
      "Contact is blocked.",
      broadcast.id,
      broadcast.workspaceId,
      pendingBumps,
      "contact_blocked",
    );
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
    // I-3: whether the resolved conversation was CLOSED at resolve time. The
    // actual closed→pending flip + `conversation_reopened` publish are deferred
    // to AFTER a successful send (post-send bookkeeping below), so a failed
    // broadcast send can't resurrect a deliberately-closed thread with nothing
    // delivered to the customer.
    let needsReopen = false;
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
          where: { workspaceId: broadcast.workspaceId, contactId: recipient.contactId },
          orderBy: { lastMessageAt: "desc" },
          select: { id: true, status: true, unreadCount: true },
        });
        conversation = existing;
      }
      if (!conversation) {
        try {
          conversation = await db.conversation.create({
            data: {
              workspaceId: broadcast.workspaceId,
              contactId: recipient.contactId,
              // Stamp the broadcast's channel so conv.channel == msg.channel ==
              // the contact's identity channel (WhatsApp for templates, the
              // social channel for freeform) — never a hardcoded WhatsApp.
              channel: sendChannel,
              // ...and the ACCOUNT the campaign sends from. A campaign run on
              // the Sales number that opens a brand-new thread must leave that
              // thread owned by the Sales number: the customer's reply lands
              // there, and the 24h window that governs the agent's free-form
              // answer belongs to it. Left null, the reply resolved the
              // workspace DEFAULT — a different number, where no window exists
              // — or, once the account-unresolved guard landed, refused to send
              // at all. Null stays null for a single-account workspace, which
              // is what the unambiguous fallback is for.
              // The RECIPIENT's account first: on a fan-out campaign the thread
              // belongs to the Page that customer actually messaged, and their
              // reply — plus the 24h window that governs the agent's free-form
              // answer — lands there. Falls back to the campaign's own account,
              // which is every WhatsApp run and every single-account social run.
              ...(recipient.channelConnectionId ?? broadcast.channelConnectionId
                ? {
                    channelConnectionId:
                      recipient.channelConnectionId ?? broadcast.channelConnectionId,
                  }
                : {}),
              status: "pending",
              lastMessagePreview: "",
            },
            select: { id: true, status: true, unreadCount: true },
          });
        } catch (err) {
          // Lost the race for this contact's single conversation (unique
          // [workspaceId, contactId]) to a concurrent inbound — reuse the winner.
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
            conversation = await db.conversation.findFirstOrThrow({
              where: { workspaceId: broadcast.workspaceId, contactId: recipient.contactId },
              orderBy: { lastMessageAt: "desc" },
              select: { id: true, status: true, unreadCount: true },
            });
          } else throw err;
        }
      } else if (conversation.status === "closed") {
        // I-3: DON'T flip closed→pending or publish `conversation_reopened`
        // here — defer until the send actually succeeds. Flipping pre-send meant
        // a failed send (missing phone, Meta rejection) silently resurrected a
        // deliberately-closed thread in the triage queue with nothing delivered.
        needsReopen = true;
      }
      conversationId = conversation.id;
      conversationUnreadCount = conversation.unreadCount;
      // M5 — record / refresh the cache with the resolved (pre-reopen) state.
      // The post-send reopen updates it to `pending` once the send lands.
      conversationCache.set(recipient.contactId, {
        id: conversation.id,
        status: conversation.status,
        unreadCount: conversation.unreadCount,
      });
    } catch (err) {
      await failRecipientAndCount(
        recipient.id,
        errorDetail(err),
        broadcast.id,
        broadcast.workspaceId,
        pendingBumps,
      );
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

    // Destination address by the SEND channel: phone channels (WhatsApp) dial
    // the phone; social channels dial the PSID/IGSID. Channel-based (not
    // kind-based) so a customer-mode WhatsApp recipient correctly dials their
    // phone even though the send is freeform. Skip a recipient missing the
    // right identity with a clear failure rather than feeding `null` to Meta.
    const dialsPhone = isPhoneChannel(sendChannel);
    let toPhone = dialsPhone
      ? recipient.contact.phoneNumber
      : recipient.contact.externalContactId;
    let viaBsuid = false;
    // A phone-less WhatsApp contact identified only by BSUID (username
    // adopter) is still reachable — for everything except AUTHENTICATION
    // templates, which Meta refuses to a BSUID address (131062). Refusing
    // locally saves a billed call per recipient; the report buckets it under
    // the same `bsuid_needs_phone` code the inbox path uses. The portfolio
    // guard retargets to the parent BSUID on a known cross-portfolio
    // mismatch and refuses when none is stored (Meta hard-fails those).
    if (dialsPhone && !toPhone && recipient.contact.bsuid) {
      if (
        broadcast.kind === "template" &&
        (broadcast.templateCategory ?? "").toLowerCase() === "authentication"
      ) {
        await failRecipientAndCount(
          recipient.id,
          "Authentication templates need the contact's phone number — we only have their WhatsApp id.",
          broadcast.id,
          broadcast.workspaceId,
          pendingBumps,
          "bsuid_needs_phone",
        );
        return;
      }
      try {
        const guarded = await applyBsuidPortfolioGuard(
          { channel: sendChannel, to: recipient.contact.bsuid, viaBsuid: true },
          recipient.contact,
          config as { wabaAccountId?: string },
        );
        toPhone = guarded.to;
        viaBsuid = true;
      } catch (err) {
        if (err instanceof BsuidPortfolioMismatchError) {
          await failRecipientAndCount(
            recipient.id,
            err.message,
            broadcast.id,
            broadcast.workspaceId,
            pendingBumps,
            "bsuid_needs_phone",
          );
          return;
        }
        throw err;
      }
    }
    if (!toPhone) {
      await failRecipientAndCount(
        recipient.id,
        dialsPhone
          ? "Contact has no phone number for this channel."
          : "Contact has no messaging id for this channel.",
        broadcast.id,
        broadcast.workspaceId,
        pendingBumps,
      );
      return;
    }

    // Fire-time freeform-window re-check, for EVERY channel.
    //
    // Customer-mode picks each person's best channel at CREATE time; a SCHEDULED
    // broadcast fired hours/days later can have recipients whose 24h window has
    // since closed. On WhatsApp that send is a guaranteed Meta rejection, so it is
    // skipped with an actionable reason instead of a cryptic bulk failure.
    //
    // SOCIAL USED TO BE EXEMPT HERE, and that was the dangerous half. An
    // out-of-window Messenger/Instagram recipient fell through to
    // `useHumanAgentTag` above and went out under `MESSAGE_TAG` + `HUMAN_AGENT`.
    // That tag is not a delivery mechanism, it is a POLICY claim — Meta grants it
    // so "a human agent [can] respond to a person's message" outside 24h, and is
    // explicit that "Message Tags may not be used to send promotional content" and
    // that "use of Message Tags outside the approved use cases may result in
    // restrictions on the Page or Instagram account's ability to send messages".
    //
    // A broadcast is bulk outbound by construction: nobody is answering anyone's
    // inquiry. So tagging one HUMAN_AGENT is misuse in the ordinary case, and the
    // penalty lands on the CUSTOMER'S account — sending restrictions that are slow
    // and painful to lift. We cannot classify message content, so we cannot judge
    // "promotional" per campaign; what we can do is refuse to make the claim at all
    // in the one place it is never true.
    //
    // The recipient is therefore skipped, exactly like WhatsApp, with the same
    // reason an operator can act on. In-window recipients are unaffected and go
    // out as `messaging_type: RESPONSE`, which is what they always should have
    // been. Agent-typed replies keep the tag — there a human agent really is
    // responding, which is precisely the approved use.
    if (isFreeform) {
      const freeFormMs = CHANNEL_CAPABILITIES[sendChannel].freeFormWindowMs;
      if (
        freeFormMs !== null &&
        ["closed", "never"].includes(
          computeWindowStatus(
            recipient.contact.lastInboundAt?.toISOString() ?? null,
            Date.now(),
            freeFormMs,
          ).state,
        )
      ) {
        await failRecipientAndCount(
          recipient.id,
          dialsPhone
            ? "Messaging window closed since the broadcast was created — the contact must message first to reopen it."
            : "Messaging window closed — a broadcast can't be sent under the Human Agent tag, " +
              "which Meta reserves for a human replying to that person's own message. " +
              "The contact must message first to reopen the window.",
          broadcast.id,
          broadcast.workspaceId,
          pendingBumps,
          "window_closed",
        );
        return;
      }
    }

    // Empty-variable guard. WhatsApp REJECTS a template whose variable resolved
    // to an empty value ("parameter value is empty"), so firing the send would
    // just waste a Meta round-trip and surface a cryptic error. The usual cause
    // is a variable bound to a contact field (e.g. email) the recipient doesn't
    // have, with no default on the binding. Fail fast with a clear, actionable
    // reason instead of a cryptic Meta rejection — the fix is to set a default
    // value on the template variable binding (or exclude field-less contacts).
    const emptyBodyIdx = perRecipientVars.body.findIndex(
      (v) => v.trim().length === 0,
    );
    const headerEmpty =
      perRecipientVars.header !== undefined &&
      perRecipientVars.header.trim().length === 0;
    if (emptyBodyIdx !== -1 || headerEmpty) {
      const which = headerEmpty ? "the header variable" : `variable {{${emptyBodyIdx + 1}}}`;
      await failRecipientAndCount(
        recipient.id,
        `Skipped — ${which} resolved to empty for this contact (a mapped field like email is missing and the template has no default value). WhatsApp rejects templates with an empty variable.`,
        broadcast.id,
        broadcast.workspaceId,
        pendingBumps,
      );
      return;
    }

    // Double-send guard — claim a per-recipient OutboundSendAttempt BEFORE
    // touching Meta. On a resumed re-entry the prior row tells us whether the
    // send already reached Meta, so a crash between the Meta accept and the
    // `queued → sent` flip can't re-send a billed template (audit 2026-05-22;
    // see claimBroadcastSendAttempt).
    const attemptClaim = await claimBroadcastSendAttempt(
      recipient.id,
      broadcast.workspaceId,
      conversationId,
    );
    if (attemptClaim.kind === "abort") {
      await failRecipientAndCount(
        recipient.id,
        attemptClaim.reason,
        broadcast.id,
        broadcast.workspaceId,
        pendingBumps,
      );
      return;
    }

    // The send itself. Anything that throws here counts as a failed recipient
    // — Meta either rejected us or the network died, no message went out.
    let send: Awaited<ReturnType<NonNullable<typeof sendTemplate>>>;
    if (attemptClaim.kind === "reconcile") {
      // A prior (crashed) attempt already reached Meta — skip the Meta call and
      // fall through to the recipient-lock + idempotent bookkeeping using the
      // stored externalId (createOutboundMessageIdempotent dedupes on it).
      send = { externalId: attemptClaim.externalId, timestamp: attemptClaim.timestamp };
    } else {
      // Meta FETCHES the header-media link and our R2 bucket is private, so a
      // stored own (stable, non-fetchable) URL must be presigned — via the
      // RUN-SCOPED cache (mediaState.presignedLink), so every recipient in a
      // 25-minute window shares ONE URL and Meta's 10-minute media cache
      // actually hits instead of fetching R2 once per recipient. A foreign
      // link (not ours) passes through untouched. The rate-limit retry below
      // is bounded well under the cache's re-mint window, so it always rides
      // a still-valid signature.
      let headerMedia: typeof variables.headerMedia;
      try {
        headerMedia = !variables.headerMedia
          ? undefined
          : // The run-scoped id (uploaded once at start) wins — nothing is
            // fetched from our storage at all. `mediaState.disable()` clears it
            // if an id-mode send ever fails, and every later recipient falls
            // through to the presigned-link branch below.
            mediaState.mediaId
            ? { kind: variables.headerMedia.kind, id: mediaState.mediaId,
                ...(variables.headerMedia.filename
                  ? { filename: variables.headerMedia.filename }
                  : {}) }
            : // A caller-supplied id needs no presigning either. Only a link does.
              variables.headerMedia.id || !variables.headerMedia.link
              ? variables.headerMedia
              : {
                  ...variables.headerMedia,
                  link: blobStorage.isOwnUrl(variables.headerMedia.link)
                    ? await mediaState.presignedLink(variables.headerMedia.link)
                    : variables.headerMedia.link,
                };
      } catch (err) {
        // Presigning the private-bucket header link can throw (R2 config /
        // network fault, malformed stored URL). No Meta call has happened yet,
        // so this is a PER-RECIPIENT failure — it must fail ONLY this recipient
        // via the same markRecipientFailed + bump + return every sibling error
        // path uses. If it escaped here it would propagate out of
        // processOneRecipient (no top-level catch) into `Promise.all(lanes)` →
        // runBroadcast's catch, parking the WHOLE broadcast `paused`; a
        // deterministically-bad header URL would then loop pause→resume→pause.
        // Deliberately NOT routed through maybeTripPermanentBreaker: this isn't
        // a dead Meta credential, it's the same class as the missing-phone /
        // empty-variable guards above (fail one recipient, keep the run going).
        // Release the claimed attempt so a manual retry can re-claim cleanly.
        await releaseBroadcastSendAttempt(recipient.id);
        await failRecipientAndCount(
          recipient.id,
          errorDetail(err),
          broadcast.id,
          broadcast.workspaceId,
          pendingBumps,
        );
        return;
      }

      // Carousel cards, built the same way the header media is: the run-scoped
      // ids win, otherwise each own-storage link is presigned for this send.
      const cardsForSend = await buildCardsForSend(
        variables.cards,
        mediaState,
        recipient.contact,
      );
      const cardsVar = cardsForSend ? { cards: cardsForSend } : {};

      // Campaign-level and constant for the whole run — the countdown counts to
      // ONE deadline, not a per-recipient one.
      const offerExpiry =
        variables.limitedTimeOfferExpiresAtMs !== undefined
          ? { limitedTimeOfferExpiresAtMs: variables.limitedTimeOfferExpiresAtMs }
          : {};
      // Also campaign-level: a location template promotes ONE place.
      const headerLocation = variables.headerLocation
        ? { headerLocation: variables.headerLocation }
        : {};
      // Campaign-level too: one tap-target destination for every recipient.
      const tapTarget = variables.tapTarget ? { tapTarget: variables.tapTarget } : {};
      // Top-level button values — the campaign's coupon code / URL suffix.
      // URL suffixes are percent-encoded with the same identity-passthrough
      // encoder the single-send path uses, so a suffix that works in the reply
      // box can't fail in a campaign. (Auth OTP buttons never appear here —
      // broadcast creation demands explicit values and the composer doesn't
      // offer auth templates for campaigns.)
      const topButtons =
        variables.buttons && variables.buttons.length > 0
          ? {
              buttons: variables.buttons.map((b) =>
                b.subType === "url" ? { ...b, text: encodeUrlButtonValue(b.text) } : b,
              ),
            }
          : {};

    // The template variables in Meta's wire shape, built ONCE and reused by
      // both the initial send and the 429 retry below. Two inline copies is
      // exactly how the monotonicity check in commit-outbound-send once drifted.
      //
      // NAMED templates zip the composer's first-appearance-ordered values back
      // against the placeholder NAMES; positional ones pass the array straight
      // through. Getting this wrong is not a cosmetic bug — the wrong parameter
      // shape fails every recipient with Meta error 132000.
        const templateVariables =
        wireFormat.parameterFormat === "named"
          ? {
              body: [] as string[],
              bodyNamed: wireFormat.namedBodyVars.map((name, i) => ({
                name,
                text: perRecipientVars.body[i] ?? "",
              })),
              ...(wireFormat.namedHeaderVar && perRecipientVars.header !== undefined
                ? {
                    headerNamed: {
                      name: wireFormat.namedHeaderVar,
                      text: perRecipientVars.header,
                    },
                  }
                : {}),
              ...(headerMedia ? { headerMedia } : {}),
              ...headerLocation,
              ...offerExpiry,
              ...tapTarget,
              ...topButtons,
              ...cardsVar,
            }
          : {
              body: perRecipientVars.body,
              ...(perRecipientVars.header ? { header: perRecipientVars.header } : {}),
              ...(headerMedia ? { headerMedia } : {}),
              ...headerLocation,
              ...offerExpiry,
              ...tapTarget,
              ...topButtons,
              ...cardsVar,
            };

      // Captured BEFORE the send: `mediaState.mediaId` can be cleared by a
      // sibling lane mid-flight, and the fallback must key off what THIS send
      // actually put on the wire.
      // True when THIS send put a run-scoped id on the wire — header or cards.
      // Captured before the send because a sibling lane can clear the state
      // mid-flight, and the fallback must key off what actually went out.
      const usedRunMediaId =
        Boolean(headerMedia && "id" in headerMedia && mediaState.mediaId) ||
        Boolean(cardsForSend && mediaState.cardMediaIds);
      try {
        send = isFreeform
          ? await provider.sendText({ to: toPhone, ...(viaBsuid ? { viaBsuid: true } : {}), body: broadcast.bodyText ?? "", useHumanAgentTag }, config)
          : await sendTemplate!(
              {
                to: toPhone,
                ...(viaBsuid ? { viaBsuid: true } : {}),
                name: broadcast.templateName!,
                language: broadcast.templateLanguage!,
                variables: templateVariables,
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
        // ~3s of cooldown for number-level limits, a full 6.5s token period for
        // the per-recipient pair limit (131056), then send the same recipient
        // again. Only ONE in-lane retry — a permanently-flagged number shouldn't
        // loop (a persistently pair-limited RECIPIENT is deferred instead; see
        // the lane loop's "defer_pair_limit" handling).
        if (normalizeMetaSendError(err)?.code === "rate_limited") {
          // 131056 is the (number, recipient) PAIR limit — it says nothing
          // about the number's own throughput, so it must not feed the
          // number-wide streak/pause below (see PAIR_LIMIT_* rationale).
          const pairLimited = isPairRateLimitError(err);
          if (!pairLimited) {
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
          }
          // Pair limit refills one token per 6s — a 3s sleep guarantees a
          // wasted retry, so wait a full token period for that case.
          await sleep(
            (pairLimited ? PAIR_LIMIT_RETRY_MS : 3_000) +
              Math.floor(Math.random() * 1_000),
          );
          try {
            send = isFreeform
              ? await provider.sendText({ to: toPhone, ...(viaBsuid ? { viaBsuid: true } : {}), body: broadcast.bodyText ?? "", useHumanAgentTag }, config)
              : await sendTemplate!(
                  {
                    to: toPhone,
                    ...(viaBsuid ? { viaBsuid: true } : {}),
                    name: broadcast.templateName!,
                    language: broadcast.templateLanguage!,
                    variables: templateVariables,
                  },
                  config,
                );
          } catch (retryErr) {
            await releaseBroadcastSendAttempt(recipient.id);
            // STILL rate-limited after the backoff → this is a SUSTAINED limit
            // (a spam/quality throttle can last ~30 minutes), not a burst.
            //
            // Failing the recipient here — which is what used to happen — turns
            // a temporary throttle into permanent damage: at ~10 msg/s a
            // 30-minute limit manufactures thousands of "failed" recipients who
            // were never actually undeliverable, and the operator's only remedy
            // is a Retry button that re-sends them all.
            //
            // Instead: leave the recipient `queued` (the attempt claim was just
            // released, so it re-sends cleanly) and park the whole broadcast.
            // The drift sweeper resumes it after its cooldown, by which time the
            // rate-limit window has cleared. Nobody is marked failed, nobody is
            // double-sent — the queued→sent CAS still guarantees exactly-once.
            if (normalizeMetaSendError(retryErr)?.code === "rate_limited") {
              // Still PAIR-limited after a full 6s token period → this one
              // recipient has burst debt (can take minutes to repay). That is
              // no reason to park a whole campaign: signal the lane loop to
              // defer just this recipient (row stays `queued`, claim already
              // released above) and keep every lane sending to everyone else.
              if (isPairRateLimitError(retryErr)) {
                return "defer_pair_limit";
              }
              await pauseForSustainedRateLimit(broadcast);
              return;
            }
            await failRecipientAndCount(
              recipient.id,
              errorDetail(retryErr),
              broadcast.id,
              broadcast.workspaceId,
              pendingBumps,
              normalizeMetaSendError(retryErr)?.code ?? null,
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
        } else if (usedRunMediaId && !isFreeform) {
          // This send used the run-scoped media id. We could not confirm from
          // Meta's docs that one uploaded id may be referenced by MANY messages
          // (lib/templates/), so an id-mode failure is treated as
          // "the id didn't work" and the run falls back to per-recipient
          // presigned links — permanently, so at most ONE recipient ever pays
          // for the uncertainty.
          //
          // Retrying on the link is safe for the same reason the rate-limit
          // retry above is: no message reached Meta (the send threw), and the
          // per-recipient OutboundSendAttempt claim still guards a crash in the
          // window. If the real cause was something else entirely (a bad number,
          // an opt-out), the link retry fails identically and the recipient is
          // marked failed exactly as it would have been.
          mediaState.disable(normalizeMetaSendError(err)?.code ?? "unknown", broadcast.id);
          try {
            const linkMedia = variables.headerMedia?.link
              ? {
                  ...variables.headerMedia,
                  id: undefined,
                  link: blobStorage.isOwnUrl(variables.headerMedia.link)
                    ? await mediaState.presignedLink(variables.headerMedia.link)
                    : variables.headerMedia.link,
                }
              : undefined;
            // `disable()` above cleared BOTH id sets, so this rebuild comes
            // back on links for the header and every card alike.
            const linkCards = await buildCardsForSend(
              variables.cards,
              mediaState,
              recipient.contact,
            );
            send = await sendTemplate!(
              {
                to: toPhone,
                ...(viaBsuid ? { viaBsuid: true } : {}),
                name: broadcast.templateName!,
                language: broadcast.templateLanguage!,
                variables: {
                  ...templateVariables,
                  ...(linkMedia ? { headerMedia: linkMedia } : {}),
                  ...(linkCards ? { cards: linkCards } : {}),
                },
              },
              config,
            );
          } catch (retryErr) {
            await releaseBroadcastSendAttempt(recipient.id);
            await failRecipientAndCount(
              recipient.id,
              errorDetail(retryErr),
              broadcast.id,
              broadcast.workspaceId,
              pendingBumps,
              normalizeMetaSendError(retryErr)?.code ?? null,
            );
            await maybeTripPermanentBreaker(broadcast, retryErr);
            return;
          }
        } else {
          await releaseBroadcastSendAttempt(recipient.id);
          await failRecipientAndCount(
            recipient.id,
            errorDetail(err),
            broadcast.id,
            broadcast.workspaceId,
            pendingBumps,
            normalizeMetaSendError(err)?.code ?? null,
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
        // Seed the delivery ladder at `sent`. Meta's own `sent` status webhook
        // is therefore always a no-op, which is why ingest skips propagating it
        // — that alone removes a third of the webhook write volume on a 100k
        // campaign. From here the ladder is webhook-owned.
        //
        // …unless Meta HELD the message for a portfolio-pacing quality
        // assessment. It has a wamid but has not left Meta's queue, so counting
        // it as sent reports a campaign as away when it is parked.
        deliveryState: send.heldForQualityAssessment ? "held" : "sent",
      },
    });
    if (recipientLocked.count === 0) {
      // The queued→sent CAS missed. Two causes: (a) a genuine concurrent claim —
      // their row is the source of truth, skip; (b) a cancel() that raced this
      // in-flight send. cancel() snapshots in-flight recipients (their
      // `bc-recipient-<id>` OutboundSendAttempt with failedAt=null) and excludes
      // them from the queued→failed finalize, but a lane that had pulled this
      // recipient yet not YET created its attempt row is invisible to that
      // snapshot — so cancel flipped it to failed+CANCEL_RECIPIENT_MARKER and
      // over-counted it as failed. Meta already accepted our send, so the row
      // must end up `sent`, not silently-failed with no inbox Message row (and
      // retryFailed excludes the marker, so it would otherwise never reconcile).
      // Reconcile: CAS the failed+marker state → sent. The marker gate makes this
      // idempotent (a second pass finds it already `sent` and no-ops).
      const reconciled = await db.broadcastRecipient.updateMany({
        where: {
          id: recipient.id,
          status: "failed",
          errorMessage: CANCEL_RECIPIENT_MARKER,
        },
        data: {
          status: "sent",
          externalId: send.externalId,
          conversationId,
          sentAt: send.timestamp,
          // Meta accepted this send, so the delivery ladder starts at `sent`
          // here too — the cancel had wrongly parked it at failed_at_send.
          deliveryState: send.heldForQualityAssessment ? "held" : "sent",
        },
      });
      if (reconciled.count === 0) {
        // Case (a): not the cancel race (or already reconciled) — leave the
        // winning row as the source of truth and skip duplicate bookkeeping.
        console.warn(
          `[broadcast ${broadcast.id}] recipient ${recipient.id} was already claimed; skipping post-send bookkeeping`,
        );
        return;
      }
      // cancel() incremented failedCount for this recipient; undo that AND count
      // the send in one clamped write (GREATEST(0, …) guards a lost earlier bump)
      // so the terminal counters stay honest. This branch is the ONLY way past
      // the reconcile CAS with work done (the reconciled.count===0 sub-branch
      // returned early), so the failed→sent move fully accounts for the send —
      // no separate {sent:1} bump (that lives only in the normal-lock `else`).
      // Swallow-and-log: a counter miss must never abort the (already-delivered)
      // recipient.
      await reconcileCancelRaceCounters(broadcast.id, broadcast.workspaceId).catch((err) => {
        console.error(
          `[broadcast ${broadcast.id}] cancel-race counter reconcile failed for recipient ${recipient.id}`,
          err,
        );
      });
    } else {
      // Normal queued→sent lock won — count this send. Kept in an `else`
      // (not a trailing flagged bump) so it's structurally impossible to
      // double-count with the cancel-race reconcile above, even if a future
      // early-return is added to that branch.
      bumpCountersFireAndForget(broadcast.id, broadcast.workspaceId, { sent: 1 }, pendingBumps);
    }

    // I-3: the send DEFINITIVELY succeeded (recipient locked `sent`) — NOW
    // perform the deferred closed→pending reopen + publish. CAS-guarded on
    // status=closed AND workspaceId-scoped so a concurrent inbound that already
    // reopened it doesn't double-publish; wrapped so a reopen wobble can't undo
    // the already-committed send. A FAILED send returns earlier and never
    // reaches here, so a deliberately-closed thread is only resurrected when a
    // message actually landed.
    if (needsReopen) {
      try {
        const reopened = await db.conversation.updateMany({
          where: { id: conversationId, workspaceId: broadcast.workspaceId, status: "closed" },
          data: { status: "pending" },
        });
        if (reopened.count > 0) {
          conversationCache.set(recipient.contactId, {
            id: conversationId,
            status: "pending",
            unreadCount: conversationUnreadCount,
          });
          await publish({
            type: "broadcast.conversation_reopened",
            workspaceId: broadcast.workspaceId,
            broadcastId: broadcast.id,
            conversationId,
          });
        }
      } catch (err) {
        console.error(
          `[broadcast ${broadcast.id}] deferred reopen failed for conversation ${conversationId} (message was sent)`,
          err,
        );
      }
    }

    // Campaign assignment, "on_send" mode only.
    //
    // The assignee was DRAWN when the recipient row was built (see
    // lib/assignment/broadcast-plan.ts) so an exact-count split is exact and a
    // resumed run reuses the same draw. WHEN it's applied is the campaign's
    // choice, and the DEFAULT is not here:
    //
    //   on_reply (default) — applied when the customer actually replies, in
    //     lib/assignment/campaign-reply.ts. A campaign is overwhelmingly
    //     one-way; assigning all 10,000 recipients here would bury agents in
    //     conversations nobody will ever answer AND poison the
    //     open-conversation counts that capacity limits and least-busy routing
    //     read.
    //   on_send — applied below, once the send definitively succeeded (same
    //     reason the reopen is deferred: a campaign that failed to deliver must
    //     not put work on anyone's plate).
    //
    // Routed through the shared `assignConversation` mutation, so the inbox
    // updates live and the audit trail reads identically to a manual assign.
    // `onlyIfUnassigned` unless the campaign explicitly opted into overwrite —
    // a blast must not take a live support thread from the agent handling it.
    if (recipient.assignedUserId && broadcast.assignmentTrigger === "on_send") {
      try {
        // No pre-read: `onlyIfUnassigned` is evaluated INSIDE the mutation's
        // own read, which is the only place it is race-proof. The old
        // read-then-write left a full round trip in which an agent could claim
        // the thread — and the campaign then took it from them, the exact
        // outcome `assignmentOverwrite: false` promises cannot happen.
        {
          const assigned = await assignConversation({
            db,
            publish,
            workspaceId: broadcast.workspaceId,
            conversationId,
            targetUserId: recipient.assignedUserId,
            onlyIfUnassigned: !broadcast.assignmentOverwrite,
            changedByUserId: null,
            // NOT silent: campaign ownership is a real business change that
            // workflows and partner webhooks should see. Note the invariant
            // this respects — audit/workflow never subscribe to `broadcast.*`;
            // this publishes `conversation.assigned`, which is a per-thread
            // event and correctly fans out per assigned conversation only.
          });
          // `invalid_user` = the drawn agent was deactivated/removed after the
          // materialize-time draw. on_send has no reply-time second chance, so
          // without this line their entire share lands unassigned with zero
          // operator signal. Leaving it unassigned is correct (never route to
          // a ghost); staying silent about it is not.
          if (!assigned.ok && assigned.reason === "invalid_user") {
            console.warn(
              `[broadcast ${broadcast.id}] drawn assignee ${recipient.assignedUserId} is no longer assignable — conversation ${conversationId} left unassigned`,
            );
          }
        }
      } catch (err) {
        // Never fail a delivered send over assignment bookkeeping.
        console.error(
          `[broadcast ${broadcast.id}] assignment failed for conversation ${conversationId} (message was sent)`,
          err,
        );
      }
    }

    // Best-effort post-send bookkeeping. A failure here is a real bug worth
    // logging, but it must NEVER flip the recipient back to `failed`: the
    // message went out and Meta's already charged us. Worst case the inbox
    // is missing the row until a manual re-fetch.
    try {
      // Render with the same per-recipient values we just sent so the inbox
      // bubble matches what landed in the customer's WhatsApp — not the
      // unresolved literals the agent typed into the broadcast form.
      const renderedBody = isFreeform
        ? (broadcast.bodyText ?? "")
        : renderTemplateBody(templateBody, perRecipientVars.body);
      const preview = renderedBody.slice(0, 200);

      const created = await createOutboundMessageIdempotent({
        workspaceId: broadcast.workspaceId,
        conversationId,
        externalId: send.externalId,
        senderUserId: broadcast.createdById,
        body: renderedBody,
        direction: "out",
        channel: sendChannel,
        status: "sent",
        // The CAMPAIGN's account, explicitly — not the choke point's derivation
        // from the thread. A recipient with an existing conversation keeps that
        // thread's pointer, which may name a different number than the campaign
        // sent from; the campaign's account is what actually carried this row.
        // Historical stamp of the account this message ACTUALLY went out from —
        // the recipient's own on a fan-out campaign. Getting this wrong
        // misreports per-account analytics and CSV exports forever.
        channelConnectionId:
          recipient.channelConnectionId ?? broadcast.channelConnectionId ?? null,
        // Durable campaign link. `rawPayload.broadcastId` below is kept for
        // back-compat + the historical backfill, but the rawPayload-retention
        // sweeper COLLAPSES that blob to {"sentVia":"broadcast"} after its
        // window — this column is what survives, and it's what lets a status
        // webhook find the recipient with no extra query.
        broadcastId: broadcast.id,
        // Only when a TEMPLATE actually carried it — a free-form broadcast must not
        // be marked, or the 24h budget would count sends that never consumed it.
        // Broadcasts remain authoritative via `BroadcastRecipient`; this keeps the
        // two views of the same send consistent.
        ...(broadcast.templateName ? { templateName: broadcast.templateName } : {}),
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
        // minor#2: workspaceId-scope the CAS for defense-in-depth consistency with
        // every other conversation write (conversationId is a globally-unique
        // cuid so this isn't exploitable today, but the codebase scopes every
        // tenant-owned write by workspaceId).
        where: { id: conversationId, workspaceId: broadcast.workspaceId, lastMessageAt: { lte: send.timestamp } },
        data: {
          lastMessageAt: send.timestamp,
          lastMessagePreview: preview,
          lastMessageDirection: "out",
        },
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
        workspaceId: broadcast.workspaceId,
        conversationId,
        externalId: send.externalId,
        senderUserId: broadcast.createdById,
        body: renderedBody,
        direction: "out",
        channel: sendChannel,
        status: "sent",
        rawPayload: { sentVia: "broadcast", broadcastId: broadcast.id },
        timestamp: send.timestamp.toISOString(),
      };

      await publish({
        type: "broadcast.recipient_message_sent",
        workspaceId: broadcast.workspaceId,
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

async function markRecipientFailed(
  recipientId: string,
  message: string,
  errorCode?: string | null,
): Promise<boolean> {
  // CAS so a recipient that was already marked `sent` (or `failed`) by a
  // prior pass isn't reverted. Returns whether THIS call actually flipped a
  // queued row — the caller counts the failure only when it did (see
  // `failRecipientAndCount`).
  const res = await db.broadcastRecipient.updateMany({
    where: { id: recipientId, status: "queued" },
    data: {
      status: "failed",
      errorMessage: message.slice(0, 500),
      // Rejected at the API call — the message never entered Meta's network, so
      // there is no wamid and no status webhook will ever arrive for it. Stamp
      // the terminal delivery state HERE or these rows would sit at `pending`
      // forever and the funnel would under-count failures.
      deliveryState: "failed_at_send",
      ...(errorCode ? { errorCode } : {}),
    },
  });
  return res.count > 0;
}

/**
 * Fail a recipient and count it AT MOST ONCE. The failure counter is bumped only
 * when the queued→failed CAS actually won. If `cancel()`'s finalize UPDATE
 * already flipped this queued recipient to failed+CANCEL_RECIPIENT_MARKER (it
 * counts every not-in-flight queued row as failed), the CAS here misses and we
 * must NOT bump again — otherwise `sentCount + failedCount` exceeds `totalCount`.
 * This mirrors the success path, which only bumps `{ sent: 1 }` when its
 * queued→sent CAS wins and otherwise reconciles the marker instead.
 */
async function failRecipientAndCount(
  recipientId: string,
  message: string,
  broadcastId: string,
  workspaceId: string,
  pendingBumps: Set<Promise<unknown>>,
  /** Normalized MetaErrorCode, when the caller has the underlying error. Drives
   *  the campaign report's failure buckets (retry / clean list / suppress). */
  errorCode?: string | null,
): Promise<void> {
  const flipped = await markRecipientFailed(recipientId, message, errorCode);
  if (flipped) {
    bumpCountersFireAndForget(broadcastId, workspaceId, { failed: 1 }, pendingBumps);
  }
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
  const code = normalizeMetaSendError(err)?.code;
  // Beyond a dead token, three account-level states fail every remaining
  // recipient identically until the operator repairs the account (error-codes
  // reference): a policy restriction/lock (368/131031), a billing problem
  // (131042), and an unregistered number (131045/133010). Feeding them into
  // the same streak breaker pauses the run instead of burning the audience.
  // `app_permission_required` (social code 200) is the same shape one layer up:
  // until App Review clears pages_messaging, every recipient who isn't an admin/
  // developer/tester of the app is refused identically. Burning a 10k audience to
  // discover that is exactly what the breaker exists to prevent.
  return (
    code === "auth_expired" ||
    code === "account_restricted" ||
    code === "app_permission_required" ||
    code === "billing_issue" ||
    code === "number_not_registered"
  );
}

/**
 * A template that's paused / disabled / no longer approved fails EVERY recipient
 * of the broadcast identically (they all share one template) — run-fatal, like a
 * dead credential, so it feeds the same breaker instead of burning the audience
 * as false per-recipient failures. Distinct from credential errors so the reason
 * copy + recovery guidance are template-specific (fix/unpause the template, then
 * retry) rather than "reconnect WhatsApp".
 */
function isFatalTemplateError(err: unknown): boolean {
  const code = normalizeMetaSendError(err)?.code;
  // marketing_disabled (131063) rides the template leg of the breaker: the
  // WABA's WhatsApp Manager flag refuses every MARKETING template send, and
  // the recovery guidance is template-side (re-enable the flag or switch
  // templates), not "reconnect WhatsApp".
  return code === "template_unavailable" || code === "marketing_disabled";
}

/**
 * Permanent-error breaker. Called from the non-rate-limited failure branch.
 * Bumps the consecutive permanent-error streak; when it crosses the threshold,
 * CAS the broadcast `running → paused`, set the in-memory FATAL_PAUSE signal so
 * every lane stops pulling, and publish the paused status. Two run-fatal classes
 * feed it: a dead credential (expired/revoked token, deconfigured number) and an
 * unavailable template (paused/disabled/unapproved). The boot reconciler resumes
 * a `paused` broadcast once the underlying issue is fixed; per-recipient CAS
 * keeps resume double-send-safe.
 */
async function maybeTripPermanentBreaker(
  broadcast: {
    id: string;
    workspaceId: string;
    channel: Channel;
    /** The account this campaign sends from — the one whose token failed. */
    channelConnectionId?: string | null;
  },
  err: unknown,
): Promise<void> {
  // Meta's ABUSE WARNING (`613 – 2018338`) stops the campaign on the FIRST hit,
  // with no streak to accumulate.
  //
  // Every other run-fatal class here waits for a streak because one rejection
  // can be an isolated bad recipient. This one cannot: Meta has already decided
  // the account's behaviour "may be considered bothersome or abusive" and warned
  // that "further misuse of API features may result in messaging restrictions
  // being placed on your Page". Counting to a threshold means deliberately
  // committing that further misuse two more times to confirm a message Meta only
  // sends once. The cost of stopping early is a paused campaign an operator can
  // resume; the cost of continuing is the customer's account.
  if (normalizeMetaSendError(err)?.code === "abuse_warning") {
    await tripPermanentBreakerNow(broadcast, "abuse_warning");
    return;
  }
  const credentialFatal = isPermanentCredentialError(err);
  const templateFatal = isFatalTemplateError(err);
  if (!credentialFatal && !templateFatal) {
    // A per-recipient rejection (bad number, unsupported content) breaks any
    // accumulating streak — those are isolated, not a run-fatal fault.
    resetPermanentStreak(broadcast.id);
    return;
  }
  // Light the Settings "reconnect" banner on the FIRST expired-token hit — a
  // broadcast bypasses the send-worker's flag, so otherwise a token dying
  // mid-broadcast pauses the broadcast but leaves the reconnect CTA dark. (Not
  // for a template fault — that's not a connection problem.) Scoped to the
  // SENDING account: its token failed, not its siblings'.
  if (normalizeMetaSendError(err)?.code === "auth_expired") {
    void flagChannelNeedsReconnect(
      broadcast.workspaceId,
      broadcast.channel,
      broadcast.channelConnectionId ?? null,
    );
  }
  const streak = trackPermanentHit(broadcast.id);
  if (streak < PERMANENT_ERROR_PAUSE_THRESHOLD) return;
  if (FATAL_PAUSE.has(broadcast.id)) return; // another lane already tripped it
  // Claim the trip atomically in-memory before the DB write so two lanes
  // crossing the threshold in the same tick don't both pause/publish.
  FATAL_PAUSE.add(broadcast.id);
  const reason = templateFatal
    ? "Template paused/disabled at Meta — fix or unpause the template, then retry the broadcast."
    : isProviderNotConfigured(err)
      ? "WhatsApp connection error — the number is no longer configured."
      : "WhatsApp connection error — the access token expired or was revoked.";
  // `template` is the one cause auto-resume must NOT retry: only an operator
  // action in Meta's console fixes it, and every retry burns another
  // PERMANENT_ERROR_PAUSE_THRESHOLD recipients into `failed` for nothing. A
  // credential fault, by contrast, self-heals the moment the token is refreshed.
  const pausedReason = templateFatal ? "template" : "credentials";
  const paused = await db.broadcast.updateMany({
    where: { id: broadcast.id, status: "running" },
    data: { status: "paused", pausedAt: new Date(), pausedReason, lastError: reason },
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
    workspaceId: broadcast.workspaceId,
    broadcastId: broadcast.id,
    status: "paused",
    error: reason,
  });
}

function isProviderNotConfigured(err: unknown): boolean {
  return err instanceof ProviderNotConfiguredError;
}

/**
 * Pause a broadcast IMMEDIATELY, with no streak — used only where waiting would
 * itself be the harm.
 *
 * Same mechanics as the streak breaker (FATAL_PAUSE claim so every lane stops,
 * running→paused CAS, status publish); the difference is that one occurrence is
 * the whole signal. `abuse_warning` is the case it exists for: Meta sends that
 * warning once, and the documented consequence of ignoring it is a messaging
 * restriction on the customer's account.
 *
 * The reason is stored so auto-resume skips it — this needs a person to look at
 * what was being sent, not a timer.
 */
async function tripPermanentBreakerNow(
  broadcast: { id: string; workspaceId: string },
  pausedReason: "abuse_warning",
): Promise<void> {
  if (FATAL_PAUSE.has(broadcast.id)) return;
  FATAL_PAUSE.add(broadcast.id);
  const reason =
    "Meta warned that this account's messaging looks abusive and may restrict it. " +
    "The broadcast was stopped immediately — review what is being sent before resuming.";
  const paused = await db.broadcast.updateMany({
    where: { id: broadcast.id, status: "running" },
    data: { status: "paused", pausedAt: new Date(), pausedReason, lastError: reason },
  });
  if (paused.count === 0) return;
  console.error(`[broadcast ${broadcast.id}] ABUSE WARNING from Meta — paused immediately: ${reason}`);
  await publish({
    type: "broadcast.status_changed",
    workspaceId: broadcast.workspaceId,
    broadcastId: broadcast.id,
    status: "paused",
    error: reason,
  });
}

/**
 * Park a broadcast because Meta is SUSTAINEDLY rate-limiting it — the recipient
 * that triggered this stays `queued` and is re-sent on resume.
 *
 * Mirrors `maybeTripPermanentBreaker`'s shape (same FATAL_PAUSE claim so lanes
 * stop, same running→paused CAS, same publish) but is a fundamentally different
 * verdict: nothing is wrong with the campaign, the number, or the recipients.
 * We are simply sending faster than Meta currently allows, and the correct
 * response is to wait rather than to burn the audience into `failed`.
 *
 * Recovery is the drift sweeper's cooldown — no operator action needed. That
 * makes this the one pause the system is expected to enter and leave on its own
 * during a large campaign.
 */
async function pauseForSustainedRateLimit(broadcast: {
  id: string;
  workspaceId: string;
}): Promise<void> {
  if (FATAL_PAUSE.has(broadcast.id)) return; // another lane already parked it
  // Claim in-memory before the DB write so two lanes hitting the wall in the
  // same tick don't both pause and publish.
  FATAL_PAUSE.add(broadcast.id);
  const reason =
    "Meta is rate-limiting this number — the broadcast paused and will resume " +
    "automatically once the limit clears. No recipients were lost.";
  const paused = await db.broadcast.updateMany({
    where: { id: broadcast.id, status: "running" },
    data: {
      status: "paused",
      pausedAt: new Date(),
      pausedReason: "rate_limited",
      lastError: reason,
    },
  });
  if (paused.count === 0) {
    // Already left `running` (canceled / completed by a racing path). Keep the
    // FATAL_PAUSE flag set so lanes still stop; the tail clears it.
    return;
  }
  console.warn(
    `[broadcast ${broadcast.id}] sustained rate limit — pausing; queued recipients are intact and will resume`,
  );
  await publish({
    type: "broadcast.status_changed",
    workspaceId: broadcast.workspaceId,
    broadcastId: broadcast.id,
    status: "paused",
    error: reason,
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
  workspaceId: string,
  conversationId: string,
): Promise<BroadcastAttemptClaim> {
  const jobId = broadcastAttemptJobId(recipientId);
  try {
    await db.outboundSendAttempt.create({ data: { jobId, workspaceId, conversationId } });
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
  latest: { sentCount: number; failedCount: number; totalCount: number; workspaceId: string };
}
const progressThrottles = new Map<string, ProgressThrottle>();

function emitProgress(broadcastId: string, state: ProgressThrottle["latest"]): void {
  void publish({
    type: "broadcast.progress",
    workspaceId: state.workspaceId,
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
  workspaceId: string,
  delta: { sent?: number; failed?: number },
): Promise<void> {
  // A transient P2024/P1017/P2034 blip here would otherwise permanently lose the
  // increment (bumpCountersFireAndForget swallows the error), leaving the row's
  // sentCount/failedCount short of totalCount forever. Bounded retry recovers it;
  // a persistent error still throws into the caller's swallow + log path.
  const updated = await withTransientRetry(() =>
    db.broadcast.update({
      where: { id: broadcastId },
      data: {
        ...(delta.sent ? { sentCount: { increment: delta.sent } } : {}),
        ...(delta.failed ? { failedCount: { increment: delta.failed } } : {}),
      },
      select: { sentCount: true, failedCount: true, totalCount: true },
    }),
  );
  // Throttled emit (see scheduleProgress). DB write is authoritative and
  // unthrottled; the wire-level emit is coalesced.
  scheduleProgress(broadcastId, {
    workspaceId,
    sentCount: updated.sentCount,
    failedCount: updated.failedCount,
    totalCount: updated.totalCount,
  });
}

/**
 * Counter fix for the cancel-race reconcile (see the queued→sent CAS miss path):
 * cancel() over-counted this recipient as failed, but our send actually landed
 * and we just flipped it to `sent`. Move one unit from failed → sent in a single
 * clamped write — `GREATEST(0, …)` guards the degenerate case where an earlier
 * failed-bump was lost to a transient blip, so we never persist a negative
 * counter. Raw because Prisma's typed update can't express GREATEST; RETURNING
 * feeds the same throttled progress emit every other counter write uses.
 */
async function reconcileCancelRaceCounters(
  broadcastId: string,
  workspaceId: string,
): Promise<void> {
  const rows = await withTransientRetry(() =>
    db.$queryRaw<
      { sentCount: number; failedCount: number; totalCount: number }[]
    >`
      UPDATE "Broadcast"
      SET "sentCount" = "sentCount" + 1,
          "failedCount" = GREATEST(0, "failedCount" - 1)
      WHERE "id" = ${broadcastId}
      RETURNING "sentCount", "failedCount", "totalCount"
    `,
  );
  const updated = rows[0];
  if (!updated) return;
  scheduleProgress(broadcastId, {
    workspaceId,
    sentCount: Number(updated.sentCount),
    failedCount: Number(updated.failedCount),
    totalCount: Number(updated.totalCount),
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
  workspaceId: string,
  delta: { sent?: number; failed?: number },
  pendingBumps: Set<Promise<unknown>>,
): void {
  const p = bumpCounters(broadcastId, workspaceId, delta).catch((err) => {
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

  // CAS, not a bare update: a cancel landing between the runner's status read
  // and this fail() must not be overwritten canceled→failed (and a concurrently
  // deleted row must not throw P2025 out of the runner).
  const flipped = await db.broadcast.updateMany({
    where: { id: broadcastId, status: { notIn: ["completed", "failed", "canceled"] } },
    data: {
      status: "failed",
      lastError: message.slice(0, 1000),
      completedAt: new Date(),
    },
  });
  if (flipped.count === 0) return;

  // A pre-claim failure (template mismatch, unsupported provider, cap breach)
  // reaches here with every recipient still `queued` — and `retryFailed` only
  // re-queues `status: "failed"` rows, so without this flip the campaign was
  // permanently unretryable ("nothing to retry"). Failing the queued rows with
  // the run's error makes Retry the recovery path it claims to be. Recipients a
  // lane already advanced (sent / failed-at-send) are untouched.
  const failedNow = await db.broadcastRecipient.updateMany({
    where: { broadcastId, status: "queued" },
    data: { status: "failed", errorMessage: message.slice(0, 500) },
  });
  if (failedNow.count > 0) {
    // Keep the denormalized counter honest with the rows just flipped.
    await db.broadcast.updateMany({
      where: { id: broadcastId },
      data: { failedCount: { increment: failedNow.count } },
    });
  }

  const row = await db.broadcast.findUnique({
    where: { id: broadcastId },
    select: { workspaceId: true },
  });
  if (!row) return;
  await publish({
    type: "broadcast.status_changed",
    workspaceId: row.workspaceId,
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
/**
 * Park every broadcast that depends on a template Meta just made unsendable.
 *
 * Meta's own instruction for a paused template is to "halt any automated
 * messaging campaigns that rely on it" — the API rejects the sends anyway. We
 * already trip a breaker after PERMANENT_ERROR_PAUSE_THRESHOLD consecutive
 * failures, but that is REACTIVE: it burns that many recipients into `failed`
 * before it fires, and only if the campaign is mid-send. The status webhook is
 * the PROACTIVE signal — it arrives the moment Meta pauses the template, so
 * acting on it costs zero wasted recipients.
 *
 * Covers `running` (lanes stop via the same in-memory flag the breaker uses),
 * plus `queued` and `scheduled`, which would otherwise fire later into a
 * template that cannot send.
 *
 * `pausedReason: "template"` is deliberate — the periodic auto-resume sweep
 * skips that reason, so these rows wait for either the template's approval
 * webhook (below) or an operator's Retry.
 */
export async function pauseBroadcastsForTemplate(
  workspaceId: string,
  templateId: string,
  detail: string,
): Promise<number> {
  const rows = await db.broadcast.findMany({
    where: {
      workspaceId,
      templateId,
      status: { in: ["running", "queued", "scheduled"] },
    },
    select: { id: true, status: true },
  });
  if (rows.length === 0) return 0;

  for (const row of rows) {
    // Stop the lanes of anything mid-send before the DB write, same claim the
    // breaker makes — a lane between recipients must not slip one more through.
    if (row.status === "running") FATAL_PAUSE.add(row.id);
    const paused = await db.broadcast.updateMany({
      where: { id: row.id, status: row.status },
      data: {
        status: "paused",
        pausedAt: new Date(),
        pausedReason: "template",
        lastError: detail,
      },
    });
    if (paused.count === 0) continue;
    await publish({
      type: "broadcast.status_changed",
      workspaceId,
      broadcastId: row.id,
      status: "paused",
      error: detail,
    });
  }
  console.warn(
    `[template ${templateId}] paused ${rows.length} broadcast(s) — ${detail}`,
  );
  return rows.length;
}

/**
 * The other half: the template is APPROVED again, so the campaigns we parked
 * for it can go.
 *
 * Only rows WE parked with `pausedReason: "template"` are resumed — a campaign
 * an operator paused by hand, or one parked for a credential fault, is none of
 * this function's business. Meta's guidance is exactly this: "resume these
 * campaigns when the template's status has been set to Active again."
 *
 * `FATAL_PAUSE` is cleared first, or the re-fired lanes would exit immediately
 * on the flag we set when we paused them.
 */
export async function resumeBroadcastsForTemplate(
  workspaceId: string,
  templateId: string,
): Promise<number> {
  const rows = await db.broadcast.findMany({
    where: {
      workspaceId,
      templateId,
      status: "paused",
      pausedReason: "template",
    },
    select: { id: true },
  });
  if (rows.length === 0) return 0;
  for (const row of rows) FATAL_PAUSE.delete(row.id);
  return resumePausedBroadcasts({
    workspaceId,
    ids: rows.map((r) => r.id),
    label: "template-reapproved",
  });
}

/**
 * Resume `paused` broadcasts: flip each back to `queued` and re-fire the runner.
 *
 * Shared by the boot reconciler and the drift sweeper so the subtle parts live
 * in ONE place — in particular the "no queued recipients left" case, where the
 * previous process sent everyone but died before stamping `completed`; resuming
 * that row would otherwise leave it paused forever.
 *
 * SAFETY: this never re-sends. The flip is a CAS on `status = 'paused'`, and
 * each recipient is advanced by its own queued→sent CAS, so a recipient Meta
 * already accepted is skipped on resume.
 *
 * @param pausedBefore Only resume rows paused at/before this instant. The
 *   sweeper passes a cooldown so a still-broken cause (dead credentials, a
 *   disabled template) re-parks the row at most once per cooldown instead of
 *   spinning. Omitted at boot, where every paused row should resume at once.
 *   Rows with a NULL `pausedAt` (paused before the column existed) always
 *   qualify — they are by definition old.
 * @param limit Bound per invocation so a backlog can't thundering-herd the
 *   runner. Omitted at boot.
 * @param skipTemplatePauses Exclude `pausedReason: "template"` rows. Set ONLY by
 *   the cooldown sweeper, whose concern is not re-firing a hopeless cause every
 *   10 minutes. It must NOT be set at boot: `retryFailed` CASes on
 *   `status IN ('completed','failed','canceled')`, so it cannot resume a
 *   `paused` row, and there is no resume route — excluding template pauses
 *   everywhere would strand such a broadcast PERMANENTLY, with its remaining
 *   recipients queued forever and no operator action able to release them.
 *   Boot is therefore the backstop that always resumes everything.
 * @param workspaceId Restrict to one tenant. Unset in both production callers (boot
 *   recovery and the sweep are platform-wide); used to scope a recovery to a
 *   single org when operating on one, and by tests that must not resume another
 *   fixture's rows.
 * @returns how many rows had their paused→queued CAS succeed and were re-fired.
 *   NOTE this is the count of rows HANDED to the runner, not rows that stayed
 *   resumed: if the underlying cause is still broken the runner re-parks the row
 *   moments later, which is the intended cooldown loop.
 */
export async function resumePausedBroadcasts({
  pausedBefore,
  limit,
  workspaceId,
  ids,
  skipTemplatePauses = false,
  label = "broadcast-reconciler",
}: {
  pausedBefore?: Date;
  limit?: number;
  workspaceId?: string;
  /**
   * Resume only these rows. Used when the CAUSE is known to be fixed for a
   * specific set — a template that just went back to APPROVED — rather than
   * sweeping everything that has cooled down.
   */
  ids?: string[];
  skipTemplatePauses?: boolean;
  label?: string;
} = {}): Promise<number> {
  if (ids && ids.length === 0) return 0;
  const pausedRows = await db.broadcast.findMany({
    where: {
      status: "paused",
      ...(workspaceId ? { workspaceId } : {}),
      ...(ids ? { id: { in: ids } } : {}),
      // NEVER auto-resume a template-fatal pause. The template is disabled or
      // paused at Meta; only an operator can fix that in Meta's console, and
      // each retry burns another PERMANENT_ERROR_PAUSE_THRESHOLD recipients into
      // `failed` for nothing. The operator resumes it with Retry once fixed.
      //
      // The NULL branch is LOAD-BEARING, not defensive noise. `NOT (col =
      // 'template')` is SQL three-valued logic: for a NULL `pausedReason` it
      // evaluates to NULL rather than true, so a bare NOT silently excludes
      // every row paused before this column existed — the exact rows that must
      // stay resumable, since that is the behaviour they already had. A test
      // caught this; do not "simplify" it back.
      //
      // Combined under AND because both conditions are OR-groups: two `OR` keys
      // in one object literal would silently overwrite each other.
      AND: [
        // `abuse_warning` may NEVER auto-resume on ANY path — boot recovery
        // and the settings-save resume included. Meta's 613/2018338 text is a
        // pre-restriction warning whose documented consequence for "further
        // misuse" is a messaging restriction on the Page; a HUMAN must look at
        // what was being sent, and the explicit operator Resume action
        // (resumeBroadcastManually) is the only way out of this pause. Unlike
        // `template` (below), which boot deliberately resumes as its backstop,
        // this exclusion is unconditional.
        {
          OR: [
            { pausedReason: null },
            { pausedReason: { not: "abuse_warning" } },
          ],
        },
        ...(skipTemplatePauses
          ? [
              {
                OR: [
                  { pausedReason: null },
                  // `template` may not auto-resume from the cooldown sweeper:
                  // it needs an operator action in Meta's console, and each
                  // retry burns recipients for nothing. (abuse_warning is
                  // already excluded unconditionally above.)
                  { pausedReason: { not: "template" } },
                ],
              },
            ]
          : []),
        ...(pausedBefore
          ? [{ OR: [{ pausedAt: { lte: pausedBefore } }, { pausedAt: null }] }]
          : []),
      ],
    },
    select: { id: true, workspaceId: true, scheduledAt: true },
    ...(limit !== undefined ? { take: limit } : {}),
  });

  let resumed = 0;
  for (const row of pausedRows) {
    // A campaign whose fire time hasn't arrived goes back to `scheduled`, not
    // `queued`: pauseBroadcastsForTemplate parks `scheduled` rows too, and
    // resuming one as an immediate send (template re-approved, or the boot
    // reconciler after any deploy) would blast the whole audience days early —
    // billed and irreversible. Re-arming the delayed job is idempotent-safe
    // (`bcast-<id>` jobId), and the schedule-drift sweeper backstops it.
    if (row.scheduledAt && row.scheduledAt.getTime() > Date.now()) {
      const rescheduled = await db.broadcast.updateMany({
        where: { id: row.id, status: "paused" },
        data: { status: "scheduled" },
      });
      if (rescheduled.count === 0) continue;
      await enqueueScheduledBroadcast(
        row.id,
        row.scheduledAt.getTime() - Date.now(),
      ).catch((err) => {
        // The drift sweeper re-arms stranded `scheduled` rows — log, don't fail.
        console.warn(
          `[${label}] re-arming schedule for broadcast ${row.id} failed:`,
          err instanceof Error ? err.message : err,
        );
      });
      await publish({
        type: "broadcast.status_changed",
        workspaceId: row.workspaceId,
        broadcastId: row.id,
        status: "scheduled",
      });
      console.warn(
        `[${label}] broadcast ${row.id} returned to scheduled (fires ${row.scheduledAt.toISOString()})`,
      );
      resumed += 1;
      continue;
    }

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
        workspaceId: row.workspaceId,
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
      `[${label}] resuming broadcast ${row.id} (${queuedRemaining} recipient(s) remaining)`,
    );
    // Fire-and-forget — startBroadcast schedules the runner inside
    // setImmediate via its own mechanics. We don't await so the caller
    // (onModuleInit / a sweep tick) returns quickly.
    void startBroadcast(row.id);
    resumed += 1;
  }
  return resumed;
}

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
    select: { id: true, workspaceId: true },
  });
  if (runningOrphans.length > 0) {
    console.warn(
      `[broadcast-reconciler] flipping ${runningOrphans.length} orphaned running broadcast(s) to paused for resume`,
    );
    await db.broadcast.updateMany({
      where: { id: { in: runningOrphans.map((o) => o.id) } },
      data: { status: "paused", pausedAt: new Date(), pausedReason: "shutdown" },
    });
  }

  // 2) Every `paused` row → flip back to `queued` and re-fire the runner.
  await resumePausedBroadcasts({ label: "broadcast-reconciler" });

  // 3) Re-fire the `queued` orphans snapshotted in step 0. startBroadcast is
  // idempotent (CAS on status="queued" in runBroadcast.claim), so a row that
  // some other path already advanced is a no-op. Done LAST so step 2's
  // paused→queued resumes — which step 2 already fired — aren't double-fired.
  for (const row of queuedOrphans) {
    console.warn(
      `[broadcast-reconciler] resuming orphaned queued broadcast ${row.id}`,
    );
    void startBroadcast(row.id);
  }

  // 3b) Re-enqueue `materializing` orphans — a large broadcast whose materialize
  // job was lost (Redis eviction, crash before the worker finished inserting).
  // The materialize worker is idempotent (status-CAS + createMany skipDuplicates),
  // so a re-enqueue safely resumes insertion and then flips the row to
  // queued/scheduled. Without this, a crash mid-materialize strands a large
  // broadcast forever (the materialize-drift sweeper is the runtime backstop; this
  // is the boot-time one).
  const materializingOrphans = await db.broadcast.findMany({
    where: { status: "materializing" },
    select: { id: true },
  });
  for (const row of materializingOrphans) {
    console.warn(
      `[broadcast-reconciler] re-enqueuing orphaned materializing broadcast ${row.id}`,
    );
    void enqueueBroadcastMaterialize(row.id).catch((err) => {
      console.warn(
        `[broadcast-reconciler] materialize re-enqueue failed for ${row.id}:`,
        err instanceof Error ? err.message : err,
      );
    });
  }

  // 4) Crash-window closer for the cancel-race reconcile. The live reconcile
  // (failed+CANCEL_RECIPIENT_MARKER → sent, inside processOneRecipient) only
  // runs if the process survives to the queued→sent CAS miss. A crash between
  // completeBroadcastSendAttempt and that CAS strands a Meta-accepted+billed
  // recipient at failed+marker forever — steps 1–3 never scan `canceled`, and
  // retryFailed excludes the marker. Recover those here. Awaited (not
  // fire-and-forget): the scan is bounded to canceled broadcasts' marker rows
  // (usually empty) and must finish before boot proceeds so counters/inbox are
  // consistent.
  await reconcileCanceledMarkerRecipients();
}

/**
 * Boot-time recovery for the doubly-conditional cancel-race gap (fix, audit
 * 2026-07): a recipient whose Meta send was ACCEPTED (its `bc-recipient-<id>`
 * OutboundSendAttempt is `completed` with a wamid) but whose live queued→sent
 * reconcile never ran because the process crashed first. cancel() had flipped
 * it to failed+CANCEL_RECIPIENT_MARKER (its attempt row wasn't visible to the
 * in-flight snapshot yet), so it's stuck: the running/paused/queued reconcilers
 * never touch `canceled`, and retryFailed filters the marker out. Meta billed
 * us and the customer received the template, so the row MUST end up `sent` with
 * an inbox Message — exactly what the live cancel-race reconcile produces.
 *
 * Bounded: only `canceled` broadcasts, recipients with a completed attempt.
 * Idempotent: the state-gated CAS no-ops on a second pass (already `sent`), and
 * createOutboundMessageIdempotent dedupes on the wamid, so re-running (or racing
 * the live path) writes nothing twice.
 *
 * Handles BOTH stranded states a cancel-race can leave (audit 2026-07-20 extends
 * this beyond the failed+marker case):
 *   - failed+marker + completed attempt → sent  (cancel counted it as failed).
 *   - queued + completed attempt        → sent  (cancel LEFT it queued because
 *     failedAt was null; the live queued→sent CAS never ran). Meta billed +
 *     delivered it, so it must end sent with an inbox Message.
 * Plus finalizes leftover queued rows whose attempt is in-flight-but-incomplete
 * (crash mid round-trip, delivery unprovable) → failed+marker, so a canceled
 * broadcast's counters ALWAYS sum to totalCount and retryFailed excludes them.
 */
// Exported for the broadcast-schedule-drift sweeper: boot-only invocation left
// a >7-day gap — the send-attempt retention sweeper GC'd the completed-attempt
// evidence this repair keys on, so a cancel-race crash on a box that didn't
// restart within a week became a permanently mis-recorded billed send. The
// query is one indexed join that is empty in the normal case, so a periodic
// call costs nothing.
export async function reconcileCanceledMarkerRecipients(): Promise<void> {
  // Query ONLY the recoverable set in ONE shot: a marker recipient in a
  // `canceled` broadcast whose OutboundSendAttempt DEFINITIVELY reached Meta
  // (completedAt + externalId set). This set is normally EMPTY — a genuine
  // never-sent cancel has NO completed attempt and is excluded by the join, so
  // we never scan cancel history or do a per-recipient lookup. Cost tracks the
  // rare crash-window set, not the number of canceled broadcasts/recipients
  // (the old per-broadcast findMany + per-recipient findUnique was O(cancel
  // history) on every boot).
  const recoverable = await db.$queryRaw<
    {
      recipientId: string;
      contactId: string;
      broadcastId: string;
      conversationId: string;
      externalId: string;
      completedAt: Date;
      sourceStatus: "failed" | "queued";
      channelConnectionId: string | null;
    }[]
  >`
    SELECT br."id"          AS "recipientId",
           br."contactId"   AS "contactId",
           br."channelConnectionId" AS "channelConnectionId",
           br."broadcastId" AS "broadcastId",
           COALESCE(br."conversationId", osa."conversationId") AS "conversationId",
           osa."externalId" AS "externalId",
           osa."completedAt" AS "completedAt",
           br."status"::text AS "sourceStatus"
    FROM "BroadcastRecipient" br
    JOIN "Broadcast" b
      ON b."id" = br."broadcastId" AND b."status" = 'canceled'::"BroadcastStatus"
    JOIN "OutboundSendAttempt" osa
      ON osa."jobId" = 'bc-recipient-' || br."id"
    WHERE osa."completedAt" IS NOT NULL
      AND osa."externalId" IS NOT NULL
      AND (
        -- (a) the marker case: cancel() flipped it to failed+marker before the
        -- attempt row was visible (failed → sent).
        (br."status" = 'failed'::"BroadcastRecipientStatus"
           AND br."errorMessage" = ${CANCEL_RECIPIENT_MARKER})
        -- (b) the still-queued case: cancel() deliberately LEFT it queued because
        -- its attempt hadn't failed (failedAt null), then the process crashed
        -- before the runner's live queued → sent CAS ran. Meta billed + delivered
        -- it, so it must also end up sent (queued → sent).
        OR br."status" = 'queued'::"BroadcastRecipientStatus"
      )
  `;

  // (c) Leftover queued rows in a canceled broadcast whose attempt is in-flight
  // but NOT completed (failedAt null, completedAt null) — the send crashed mid
  // round-trip, we can't prove Meta accepted it, so finalize to failed+marker so
  // the broadcast's counters still sum to totalCount and retryFailed excludes it.
  // ONE atomic CTE: the UPDATE ... RETURNING feeds the failedCount bump, so we
  // count EXACTLY the rows this statement flips — never the rows cancel() already
  // finalized+counted (a re-scan of all failed+marker rows would double-count).
  await db.$executeRaw`
    WITH flipped AS (
      UPDATE "BroadcastRecipient" br
      SET "status" = 'failed'::"BroadcastRecipientStatus",
          "errorMessage" = ${CANCEL_RECIPIENT_MARKER}
      FROM "Broadcast" b
      WHERE b."id" = br."broadcastId"
        AND b."status" = 'canceled'::"BroadcastStatus"
        AND br."status" = 'queued'::"BroadcastRecipientStatus"
        AND NOT EXISTS (
          SELECT 1 FROM "OutboundSendAttempt" osa
          WHERE osa."jobId" = 'bc-recipient-' || br."id"
            AND osa."completedAt" IS NOT NULL
        )
      RETURNING br."broadcastId" AS bid
    ),
    counts AS (
      SELECT bid, COUNT(*)::int AS n FROM flipped GROUP BY bid
    )
    UPDATE "Broadcast" b
    SET "failedCount" = "failedCount" + counts.n
    FROM counts
    WHERE b."id" = counts.bid
  `.catch((err) => {
    console.error("[broadcast-reconciler] finalize of stranded queued rows in canceled broadcasts failed", err);
  });

  if (recoverable.length === 0) return;

  // Memoize per-broadcast render context (template + bindings + variables) so
  // multiple recoverable recipients of the same broadcast load it once. `null`
  // memoizes a broadcast whose row/template vanished so we don't re-query it.
  type RenderCtx = {
    broadcast: NonNullable<Awaited<ReturnType<typeof db.broadcast.findUnique>>>;
    variables: ReturnType<typeof parseVariables>;
    // null for freeform (social / customer-mode) broadcasts — they have no
    // template; the inbox Message is recovered from the plain `bodyText`.
    template: Awaited<ReturnType<typeof loadTemplate>> | null;
    bindings: ReturnType<typeof parseVariableBindings> | null;
  };
  const ctxByBroadcast = new Map<string, RenderCtx | null>();
  const loadCtx = async (broadcastId: string): Promise<RenderCtx | null> => {
    if (ctxByBroadcast.has(broadcastId)) return ctxByBroadcast.get(broadcastId) ?? null;
    const broadcast = await db.broadcast.findUnique({ where: { id: broadcastId } });
    if (!broadcast) {
      // Row genuinely vanished — nothing to recover against. (Distinct from a
      // freeform broadcast, which recovers below with a null template.)
      ctxByBroadcast.set(broadcastId, null);
      return null;
    }
    // Freeform broadcasts have no template — recover the Message from the plain
    // body + the recipient's own channel. Template broadcasts load + render.
    const template =
      broadcast.kind === "freeform"
        ? null
        : await loadTemplate(broadcast.workspaceId, broadcast.templateId!);
    const ctx: RenderCtx = {
      broadcast,
      variables: parseVariables(broadcast.variables),
      template,
      bindings: template ? parseVariableBindings(template.variableBindings) : null,
    };
    ctxByBroadcast.set(broadcastId, ctx);
    return ctx;
  };

  for (const row of recoverable) {
    const ctx = await loadCtx(row.broadcastId);
    if (!ctx) continue;
    const { broadcast, variables, template, bindings } = ctx;
    const attempt = {
      completedAt: row.completedAt,
      externalId: row.externalId,
      conversationId: row.conversationId,
    };
    // Carries the recipient's OWN account so the recovered row is stamped with
    // the account the send actually used — a fan-out campaign's orphan must not
    // be attributed to the campaign's (possibly absent) account.
    const recipient = {
      id: row.recipientId,
      contactId: row.contactId,
      channelConnectionId: row.channelConnectionId,
    };
    const conversationId = row.conversationId;

    {
      // State-gated CAS → sent, keyed on the ACTUAL source state so it stays
      // idempotent (a prior boot pass / live reconcile left it already `sent`,
      // count===0 → skip). Two source states reach here (see the query):
      //   failed+marker → sent  (cancel() had counted it as failed)
      //   queued        → sent  (cancel() left it queued; never counted)
      const reconciled = await db.broadcastRecipient.updateMany({
        where:
          row.sourceStatus === "failed"
            ? { id: recipient.id, status: "failed", errorMessage: CANCEL_RECIPIENT_MARKER }
            : { id: recipient.id, status: "queued" },
        data: {
          status: "sent",
          externalId: attempt.externalId,
          conversationId,
          sentAt: attempt.completedAt,
        },
      });
      if (reconciled.count === 0) continue;

      // Write the inbox Message idempotently (same helper + shape as the live
      // post-send path). Best-effort: the send already happened, so a render/DB
      // wobble here must not revert the now-`sent` recipient — worst case the
      // bubble is missing until a manual refetch (same tolerance the live path
      // documents). Counters are still reconciled below regardless.
      try {
        const contact = await db.contact.findUnique({
          where: { id: recipient.contactId },
          select: {
            name: true,
            phoneNumber: true,
            email: true,
            location: true,
            customFields: true,
            // Stamp the Message with the recipient's actual channel (matches the
            // conversation it was sent on) — a freeform social recovery must not
            // be misattributed to WhatsApp.
            identityChannel: true,
          },
        });
        if (contact) {
          // Template broadcasts render per-recipient variables; freeform ones
          // send the plain body (mirrors the live send at the top of this file).
          const renderedBody =
            template && bindings
              ? renderTemplateBody(
                  template.bodyText,
                  resolvePerRecipientVariables(bindings, variables, contact).body,
                )
              : broadcast.bodyText ?? "";
          await createOutboundMessageIdempotent({
            workspaceId: broadcast.workspaceId,
            conversationId,
            externalId: attempt.externalId,
            senderUserId: broadcast.createdById,
            body: renderedBody,
            direction: "out",
            channel: contact.identityChannel,
            status: "sent",
            // Historical stamp of the account this message ACTUALLY went out
            // from — the recipient's own on a fan-out campaign. Getting this
            // wrong misreports per-account analytics and CSV exports forever.
            channelConnectionId:
              recipient.channelConnectionId ?? broadcast.channelConnectionId ?? null,
            // Template marker, template sends only — see the send path above.
            ...(broadcast.templateName ? { templateName: broadcast.templateName } : {}),
            rawPayload: {
              sentVia: "broadcast",
              broadcastId: broadcast.id,
              templateId: broadcast.templateId,
              templateName: broadcast.templateName,
              templateLanguage: broadcast.templateLanguage,
              variables,
              reconciledFrom: "cancel-race-boot",
            } as unknown as Prisma.InputJsonValue,
            timestamp: attempt.completedAt,
          });
        }
      } catch (err) {
        console.error(
          `[broadcast-reconciler] cancel-race Message write failed for recipient ${recipient.id} (message was sent, externalId=${attempt.externalId})`,
          err,
        );
      }

      // Keep the terminal counters honest. The bump differs by source state:
      //   failed → sent : swap one unit failed→sent (it WAS counted as failed by
      //                   cancel()); the existing clamped helper does exactly this.
      //   queued → sent : it was NEVER counted, so ONLY increment sent (no failed
      //                   decrement). Clamp sent to totalCount defensively.
      if (row.sourceStatus === "failed") {
        await reconcileCancelRaceCounters(broadcast.id, broadcast.workspaceId).catch((err) => {
          console.error(
            `[broadcast-reconciler] cancel-race counter reconcile failed for recipient ${recipient.id}`,
            err,
          );
        });
      } else {
        await withTransientRetry(() =>
          db.$queryRaw<{ sentCount: number; failedCount: number; totalCount: number }[]>`
            UPDATE "Broadcast"
            SET "sentCount" = LEAST("totalCount", "sentCount" + 1)
            WHERE "id" = ${broadcast.id}
            RETURNING "sentCount", "failedCount", "totalCount"
          `,
        )
          .then((rows) => {
            const u = rows[0];
            if (u)
              scheduleProgress(broadcast.id, {
                workspaceId: broadcast.workspaceId,
                sentCount: Number(u.sentCount),
                failedCount: Number(u.failedCount),
                totalCount: Number(u.totalCount),
              });
          })
          .catch((err) => {
            console.error(
              `[broadcast-reconciler] queued→sent counter bump failed for recipient ${recipient.id}`,
              err,
            );
          });
      }
    }
  }
}

/**
 * Resume a team's `paused` broadcasts NOW, without waiting for a process
 * restart. Called when WhatsApp settings are (re)saved: a broadcast parked
 * `paused` because creds were missing/expired at fire time (the config-failure
 * park, or the permanent-error breaker) picks back up the instant the operator
 * reconnects — making the detail page's "fix the connection and it will
 * auto-resume" promise true on a stable box, not just after a deploy.
 *
 * Mirrors reconcileOrphanedBroadcasts step 2 per-row: count queued recipients,
 * CAS paused→queued, re-fire. The per-recipient queued→sent CAS makes resume
 * double-send-safe (already-sent recipients are no-ops). A row with zero queued
 * recipients (a graceful-shutdown park whose sends all completed) is left for
 * the boot reconciler to mark completed — not this credential-recovery path.
 */
export async function resumePausedBroadcastsForTeam(
  workspaceId: string,
): Promise<void> {
  const paused = await db.broadcast.findMany({
    // This path fires on a WhatsApp settings save (a credential fix), which
    // says NOTHING about whether a human reviewed an abuse-flagged campaign —
    // and the query isn't even channel-scoped, so without the exclusion a
    // WhatsApp reconnect resumed a SOCIAL campaign Meta warned about. Same
    // three-valued-logic shape as the reconciler: a bare `not` drops the NULL
    // rows this path exists to resume.
    where: {
      workspaceId,
      status: "paused",
      OR: [
        { pausedReason: null },
        { pausedReason: { not: "abuse_warning" } },
      ],
    },
    select: { id: true },
  });
  for (const row of paused) {
    const queuedRemaining = await db.broadcastRecipient.count({
      where: { broadcastId: row.id, status: "queued" },
    });
    if (queuedRemaining === 0) continue;
    const flipped = await db.broadcast.updateMany({
      where: { id: row.id, status: "paused" },
      data: { status: "queued" },
    });
    if (flipped.count === 0) continue; // raced (cancel / boot reconciler won)
    console.warn(
      `[broadcast] resuming paused broadcast ${row.id} after WhatsApp settings save (${queuedRemaining} recipient(s) remaining)`,
    );
    void startBroadcast(row.id);
  }
}

/**
 * The EXPLICIT operator resume — the one path allowed to lift ANY pause,
 * including `abuse_warning` (which every automatic path now excludes: a human
 * clicking Resume after seeing the pause reason IS the review Meta's warning
 * asks for). Mirrors the reconciler's status transitions: a future-scheduled
 * row re-arms as `scheduled`; anything else flips to `queued` and starts.
 * Returns false when the row isn't paused (already resumed / canceled / raced).
 */
export async function resumeBroadcastManually(
  workspaceId: string,
  broadcastId: string,
): Promise<boolean> {
  const row = await db.broadcast.findFirst({
    where: { id: broadcastId, workspaceId, status: "paused" },
    select: { id: true, scheduledAt: true },
  });
  if (!row) return false;
  if (row.scheduledAt && row.scheduledAt.getTime() > Date.now()) {
    const rescheduled = await db.broadcast.updateMany({
      where: { id: row.id, workspaceId, status: "paused" },
      data: { status: "scheduled" },
    });
    if (rescheduled.count === 0) return false;
    await enqueueScheduledBroadcast(
      row.id,
      row.scheduledAt.getTime() - Date.now(),
    ).catch(() => {
      // The schedule-drift sweeper re-arms stranded `scheduled` rows.
    });
    return true;
  }
  const flipped = await db.broadcast.updateMany({
    where: { id: row.id, workspaceId, status: "paused" },
    data: { status: "queued" },
  });
  if (flipped.count === 0) return false;
  void startBroadcast(row.id);
  return true;
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
    // broadcastTeamSlots + teamRecipientSlots are keyed by workspaceId, and
    // runningBroadcastCount is a bare process counter — none is pruned
    // per-row here. A truly stuck entry would
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
  workspaceId: string,
  templateId: string,
): Promise<{
  bodyText: string;
  variableBindings: Prisma.JsonValue;
  components: Prisma.JsonValue;
  parameterFormat: string;
  /** Needed to spot an authentication template's OTP button, which Meta
   *  rewrites to type `url` and which is otherwise unrecognizable. */
  category: string;
}> {
  const row = await db.messageTemplate.findFirst({
    where: { id: templateId, workspaceId },
    select: {
      bodyText: true,
      variableBindings: true,
      components: true,
      parameterFormat: true,
      category: true,
    },
  });
  return {
    // Falls back to positional for a template row that vanished — the same
    // default the column carries, so a missing row can't flip the wire shape.
    parameterFormat: row?.parameterFormat ?? "positional",
    bodyText: row?.bodyText ?? "",
    variableBindings: row?.variableBindings ?? {},
    components: row?.components ?? [],
    // "" for a vanished row — not "authentication", so a missing template can
    // never make us demand an OTP parameter that isn't there.
    category: row?.category ?? "",
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

/**
 * Run-scoped header-media strategy for a broadcast.
 *
 * `id` mode means Meta already holds the bytes and fetches nothing from us.
 * `disable()` drops the run back to per-recipient presigned links permanently —
 * called the first time an id-mode send fails, so an unusable id costs one
 * retried recipient rather than the whole campaign.
 */
interface BroadcastMediaState {
  mediaId: string | null;
  /**
   * Run-scoped media ids for a carousel's cards, in card order — or null when
   * the run is in link mode. ALL-OR-NOTHING: if any card fails to pre-upload,
   * every card falls back to links. A partly-id/partly-link carousel would
   * double the states the fallback path has to reason about for no gain, since
   * one failed upload almost always means the next will fail too.
   */
  cardMediaIds: string[] | null;
  /** True once an id-mode send has failed and the run fell back to links. */
  fellBack: boolean;
  disable(reason: string, broadcastId: string): void;
  /**
   * Presign an own-storage link with a RUN-SCOPED cache. Link-mode sends used
   * to mint a FRESH signature per recipient, which made every recipient's URL
   * unique — so Meta's documented 10-minute media cache (service-messages doc
   * §media caching) never hit once, and a link-mode campaign fetched our R2
   * bucket once per recipient. Serving the SAME URL keeps Meta's cache warm;
   * the entry is re-minted once it ages past PRESIGN_REUSE_MS so a long
   * campaign can never ride a signature into its 1h expiry. Two lanes racing
   * the first mint may both presign — both URLs are valid, last write wins.
   */
  presignedLink(link: string): Promise<string>;
}

/**
 * Re-mint a cached presigned link after 25 minutes. Presigns carry a 1h TTL
 * (Meta may fetch + retry over minutes), so 25 keeps every URL Meta ever
 * receives at least ~35 minutes from expiry, while staying far above the
 * 10-minute cache window the reuse exists to exploit.
 */
const PRESIGN_REUSE_MS = 25 * 60_000;

/**
 * Per-recipient carousel card values. Mirrors the header-media rule exactly:
 * a run-scoped uploaded id wins (nothing is fetched from our storage at all),
 * otherwise an own-storage link is served from the run-scoped presign cache
 * (stable URL → Meta's 10-minute media cache hits across recipients).
 *
 * Returns undefined when the campaign has no cards, so callers can spread it
 * away rather than putting an empty array on the wire.
 */
async function buildCardsForSend(
  cards: BroadcastVariables["cards"],
  mediaState: BroadcastMediaState,
  // Same narrow shape `resolvePerRecipientVariables` takes — the token
  // resolver reads these five fields and nothing else.
  contact: {
    name: string;
    phoneNumber: string | null;
    email: string | null;
    location: string | null;
    customFields: Prisma.JsonValue;
  },
): Promise<TemplateCardVariables[] | undefined> {
  if (!cards || cards.length === 0) return undefined;
  const runIds = mediaState.cardMediaIds;
  // Card text gets the SAME `$var.…` pass the body and header get. Without it a
  // token typed into a card ships literally — to the whole audience, since the
  // cards are campaign-level. There are no per-card bindings, so this is the
  // token layer only.
  const resolve = (v: string) => resolveFieldTokens(v, contact);
  return Promise.all(
    cards.map(async (card, i) => ({
      headerMedia: runIds?.[i]
        ? { kind: card.kind, id: runIds[i]! }
        : card.id || !card.link
          ? { kind: card.kind, ...(card.id ? { id: card.id } : {}), ...(card.link ? { link: card.link } : {}) }
          : {
              kind: card.kind,
              link: blobStorage.isOwnUrl(card.link)
                ? await mediaState.presignedLink(card.link)
                : card.link,
            },
      ...(card.body ? { body: card.body.map(resolve) } : {}),
      ...(card.buttons
        ? { buttons: card.buttons.map((b) => ({ ...b, text: resolve(b.text) })) }
        : {}),
    })),
  );
}

/**
 * Upload the template's media — the header and every carousel card — to Meta
 * ONCE for this run, so Meta doesn't fetch our storage per recipient.
 *
 * Only OUR OWN storage is uploaded: a foreign link belongs to the customer's
 * server and re-hosting it would change what the recipient receives. Any failure
 * degrades silently to link mode — this is an optimization, never a gate on the
 * campaign going out.
 */
async function prepareBroadcastMedia(
  broadcast: { id: string; channel: Channel; variables: Prisma.JsonValue },
  bindingByChannel: Map<Channel, ChannelBinding>,
): Promise<BroadcastMediaState> {
  const presignCache = new Map<string, { url: string; mintedAt: number }>();
  const state: BroadcastMediaState = {
    mediaId: null,
    cardMediaIds: null,
    fellBack: false,
    disable(reason, broadcastId) {
      if (this.mediaId === null && this.cardMediaIds === null) return;
      this.mediaId = null;
      this.cardMediaIds = null;
      this.fellBack = true;
      console.warn(
        `[broadcast ${broadcastId}] header-media id rejected (${reason}); ` +
          `falling back to per-recipient links for the rest of this run`,
      );
    },
    async presignedLink(link) {
      const hit = presignCache.get(link);
      if (hit && Date.now() - hit.mintedAt < PRESIGN_REUSE_MS) return hit.url;
      const url = await blobStorage.presignGetUrl(link);
      presignCache.set(link, { url, mintedAt: Date.now() });
      return url;
    },
  };

  const parsed = parseVariables(broadcast.variables);
  const binding = bindingByChannel.get(broadcast.channel);
  const upload = binding?.provider.uploadMedia;
  // `config === null` is a FAN-OUT run: there is no run-level account, so there
  // is nothing to upload run-scoped media against. Today's fan-out campaigns are
  // freeform and carry no header media, so this never fires — it is here so that
  // stays true by construction rather than by luck if template fan-out lands.
  if (!binding || binding.config === null || !upload) return state;

  // Carousel cards, same trade as the header — and it matters far more here:
  // a 10-card carousel to 100k recipients is a MILLION fetches of our storage
  // in link mode, versus 10 uploads.
  const cards = parsed.cards ?? [];
  if (cards.length > 0 && cards.every((c) => !c.id && c.link && blobStorage.isOwnUrl(c.link))) {
    try {
      const ids: string[] = [];
      for (const card of cards) {
        const { bytes, mimeType } = await blobStorage.fetch(card.link!);
        const { mediaId } = await upload(
          { bytes, mimeType, filename: `card.${mimeType.split("/")[1] ?? "bin"}` },
          binding.config,
        );
        ids.push(mediaId);
      }
      state.cardMediaIds = ids;
      console.log(
        `[broadcast ${broadcast.id}] ${ids.length} carousel cards uploaded once — ` +
          `Meta will not fetch our storage per recipient`,
      );
    } catch (err) {
      // All-or-nothing: leave every card on links.
      state.cardMediaIds = null;
      console.warn(
        `[broadcast ${broadcast.id}] carousel card pre-upload failed, using per-recipient links:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const media = parsed.headerMedia;
  // Nothing more to optimize: no media header, an id the caller already
  // supplied, or a link we don't own.
  if (!media || media.id || !media.link || !blobStorage.isOwnUrl(media.link)) {
    return state;
  }

  try {
    const { bytes, mimeType } = await blobStorage.fetch(media.link);
    const { mediaId } = await upload(
      {
        bytes,
        mimeType,
        // Meta requires a filename; documents show it to the recipient.
        filename: media.filename ?? `header.${mimeType.split("/")[1] ?? "bin"}`,
      },
      binding.config,
    );
    state.mediaId = mediaId;
    console.log(
      `[broadcast ${broadcast.id}] header media uploaded once as ${mediaId} — ` +
        `Meta will not fetch our storage per recipient`,
    );
  } catch (err) {
    // Not fatal. The per-recipient presigned link is the existing, proven path.
    console.warn(
      `[broadcast ${broadcast.id}] header-media pre-upload failed, using per-recipient links:`,
      err instanceof Error ? err.message : err,
    );
  }
  return state;
}

function parseVariables(v: Prisma.JsonValue): BroadcastVariables {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return { body: [] };
  }
  const obj = v as {
    body?: unknown;
    header?: unknown;
    headerMedia?: unknown;
    headerLocation?: unknown;
    cards?: unknown;
    buttons?: unknown;
    limitedTimeOfferExpiresAtMs?: unknown;
    tapTarget?: unknown;
  };
  const body = Array.isArray(obj.body)
    ? obj.body.filter((x): x is string => typeof x === "string")
    : [];
  const header = typeof obj.header === "string" ? obj.header : undefined;
  let headerMedia: BroadcastVariables["headerMedia"];
  const hm = obj.headerMedia as
    | { kind?: unknown; link?: unknown; id?: unknown; filename?: unknown }
    | undefined;
  if (
    hm &&
    (hm.kind === "image" || hm.kind === "video" || hm.kind === "document") &&
    // Either form is a complete media reference. Requiring `link` would drop a
    // stored id-based header on the floor, and the send would then fail with
    // "header media required" for every recipient.
    (typeof hm.link === "string" || typeof hm.id === "string")
  ) {
    headerMedia = {
      kind: hm.kind,
      ...(typeof hm.id === "string" ? { id: hm.id } : {}),
      ...(typeof hm.link === "string" ? { link: hm.link } : {}),
      ...(typeof hm.filename === "string" ? { filename: hm.filename } : {}),
    };
  }
  let headerLocation: BroadcastVariables["headerLocation"];
  const hl = obj.headerLocation as
    | { latitude?: unknown; longitude?: unknown; name?: unknown; address?: unknown }
    | undefined;
  // Coordinates are the whole pin; the labels are optional decoration.
  if (hl && typeof hl.latitude === "string" && typeof hl.longitude === "string") {
    headerLocation = {
      latitude: hl.latitude,
      longitude: hl.longitude,
      ...(typeof hl.name === "string" && hl.name ? { name: hl.name } : {}),
      ...(typeof hl.address === "string" && hl.address ? { address: hl.address } : {}),
    };
  }
  // Cards are validated at create time; here we only keep the well-formed ones
  // so a hand-edited row can't crash a run mid-send.
  const cards = Array.isArray(obj.cards)
    ? (obj.cards as Array<Record<string, unknown>>).flatMap((c) => {
        if (!c || typeof c !== "object") return [];
        const kind = c.kind === "video" ? "video" : "image";
        if (typeof c.link !== "string" && typeof c.id !== "string") return [];
        return [
          {
            kind: kind as "image" | "video",
            ...(typeof c.id === "string" ? { id: c.id } : {}),
            ...(typeof c.link === "string" ? { link: c.link } : {}),
            ...(Array.isArray(c.body)
              ? { body: c.body.filter((x): x is string => typeof x === "string") }
              : {}),
            ...(Array.isArray(c.buttons)
              ? {
                  buttons: (c.buttons as Array<Record<string, unknown>>).flatMap((b) =>
                    typeof b?.index === "number" &&
                    (b.subType === "url" ||
                      b.subType === "quick_reply" ||
                      b.subType === "copy_code") &&
                    typeof b.text === "string"
                      ? [
                          {
                            index: b.index,
                            subType: b.subType as "url" | "quick_reply" | "copy_code",
                            text: b.text,
                          },
                        ]
                      : [],
                  ),
                }
              : {}),
          },
        ];
      })
    : [];
  const ltoExpiry =
    typeof obj.limitedTimeOfferExpiresAtMs === "number" &&
    Number.isFinite(obj.limitedTimeOfferExpiresAtMs)
      ? obj.limitedTimeOfferExpiresAtMs
      : undefined;
  // Was MISSING when tapTarget shipped: the schema accepted it, the row stored
  // it, and this parse silently dropped it — the campaign sent without its CTA
  // and nothing errored. Every field the create path stores must be read back
  // here, or it never reaches the wire.
  const tt = obj.tapTarget as { url?: unknown; title?: unknown } | undefined;
  const tapTarget =
    tt && typeof tt.url === "string" && typeof tt.title === "string"
      ? { url: tt.url, title: tt.title }
      : undefined;
  // Top-level button values (coupon code / URL suffix), same keep-the-well-
  // formed-ones stance as cards.
  const topButtons = Array.isArray(obj.buttons)
    ? (obj.buttons as Array<Record<string, unknown>>).flatMap((b) =>
        typeof b?.index === "number" &&
        (b.subType === "url" || b.subType === "quick_reply" || b.subType === "copy_code") &&
        typeof b.text === "string"
          ? [
              {
                index: b.index,
                subType: b.subType as "url" | "quick_reply" | "copy_code",
                text: b.text,
              },
            ]
          : [],
      )
    : [];
  return {
    body,
    ...(header ? { header } : {}),
    ...(headerMedia ? { headerMedia } : {}),
    ...(headerLocation ? { headerLocation } : {}),
    ...(cards.length > 0 ? { cards } : {}),
    ...(topButtons.length > 0 ? { buttons: topButtons } : {}),
    ...(ltoExpiry !== undefined ? { limitedTimeOfferExpiresAtMs: ltoExpiry } : {}),
    ...(tapTarget ? { tapTarget } : {}),
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

/**
 * Bounded transient-error retry for the lane-loop control reads (`refill` /
 * `checkCanceled`). A single P2024 pool timeout / P1017 dropped connection /
 * P2034 serialization blip in that window would otherwise reject Promise.all
 * and skip the entire completion tail, stranding the broadcast `running`.
 * Reuses the same `isTransient` classifier (+ exponential backoff with jitter)
 * the idempotent message insert uses; a PERSISTENT error after the retries
 * still throws, so the outer pause-on-throw path can park the row cleanly.
 */
async function withTransientRetry<T>(op: () => Promise<T>): Promise<T> {
  const MAX_ATTEMPTS = 4;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === MAX_ATTEMPTS - 1) throw err;
      const base = 100 * 2 ** attempt;
      const jitter = Math.random() * base * 0.25;
      await sleep(base + jitter);
    }
  }
  throw lastErr ?? new Error("withTransientRetry: retries exhausted");
}
