import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { createOutboundMessageIdempotent } from "@/lib/messages/idempotent-create";
import { getMetaProvider } from "@/lib/providers";
import { getMetaSendConfig, ProviderNotConfiguredError } from "@/lib/providers/config";
import {
  countTemplatePlaceholders,
  MetaSendError,
  normalizeMetaSendError,
  renderTemplateBody,
} from "@/lib/providers/meta";
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
 * Tradeoff: this runs in-process on the Next.js server. server.ts has a boot
 * reconciler that flips orphaned `running` rows to `failed` so a restart
 * mid-broadcast doesn't leave them dangling — but in-flight Meta sends from
 * the dead process are not retried (we don't know if they landed).
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
const MAX_RECIPIENTS_IN_PROCESS = 10_000;

interface BroadcastVariables {
  body: string[];
  header?: string;
}

export async function startBroadcast(broadcastId: string): Promise<void> {
  // Fire-and-forget — the caller doesn't await this; we explicitly catch so
  // the unhandled rejection doesn't crash the server.
  void runBroadcast(broadcastId).catch((err) => {
    console.error(`[broadcast ${broadcastId}] runner crashed`, err);
  });
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

  let config;
  try {
    config = await getMetaSendConfig(broadcast.teamId);
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

  const provider = getMetaProvider();
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
  // top of every iteration (cheap: one indexed `select` per recipient).
  // Recipients already sent stay sent (Meta can't be unsent); the loop
  // simply stops pulling more queued rows.
  //
  // The status check is co-located with the queue refill so a long-running
  // broadcast picks up cancellation between pages rather than waiting until
  // a lane idles.
  let canceled = false;
  async function checkCanceled(): Promise<boolean> {
    if (canceled) return true;
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

  // Skip the completed transition if the operator already flipped the row
  // to `canceled` mid-flight — the cancel endpoint will (or already did)
  // publish its own `broadcast.status_changed`. updateMany scoped to
  // status="running" keeps this race-safe even without the if-guard.
  if (!canceled) {
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
  provider: ReturnType<typeof getMetaProvider>,
  config: Awaited<ReturnType<typeof getMetaSendConfig>>,
  bindings: VariableBindings,
  variables: BroadcastVariables,
  templateBody: string,
  pendingBumps: Set<Promise<unknown>>,
): Promise<void> {
  if (!provider.sendTemplate) {
    await markRecipientFailed(recipient.id, "provider does not support templates");
    bumpCountersFireAndForget(broadcast.id, broadcast.teamId, { failed: 1 }, pendingBumps);
    return;
  }
  // Per-recipient conversation resolution. Outside the send try because a
  // DB error here means we DIDN'T touch Meta — safe to mark `failed` and
  // let the user retry.
    let conversationId: string;
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
        conversation = await db.conversation.create({
          data: {
            teamId: broadcast.teamId,
            contactId: recipient.contactId,
            status: "pending",
            lastMessagePreview: "",
          },
        });
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

    // The send itself. Anything that throws here counts as a failed recipient
    // — Meta either rejected us or the network died, no message went out.
    let send: Awaited<ReturnType<typeof provider.sendTemplate>>;
    try {
      send = await provider.sendTemplate(
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
        await sleep(3_000 + Math.floor(Math.random() * 1_000));
        try {
          send = await provider.sendTemplate(
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
        provider: "meta_cloud",
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

      const messagePayload: Message = {
        id: created.id,
        teamId: broadcast.teamId,
        conversationId,
        externalId: send.externalId,
        senderUserId: broadcast.createdById,
        body: renderedBody,
        direction: "out",
        provider: "meta_cloud",
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
        preview,
        lastMessageAt: send.timestamp.toISOString(),
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
 * Boot-time reconciler. Flips any broadcast still marked `running` to
 * `failed` — by definition orphaned, because the api process is the only
 * thing that drives the runner and we just started.
 *
 * Recipients aren't touched: they only have queued/sent/failed (no running
 * state — the CAS at send time goes queued→sent atomically), so a recipient
 * stuck at `queued` under an orphaned broadcast just stays orphaned. We
 * don't auto-resume because in-flight Meta sends from the dead process
 * aren't idempotent on this end — we don't know which ones landed.
 *
 * Called from BroadcastsService.onModuleInit so it fires once per boot.
 *
 * ─── OPS RUNBOOK: recovering a crashed mid-flight broadcast ─────────────
 *
 * Symptoms after a crash + restart:
 *   - One or more rows in `Broadcast` now show `status = "failed"` with
 *     `lastError = "process restarted mid-broadcast; resume not supported"`.
 *   - `BroadcastRecipient` rows for these broadcasts split into:
 *       sent     — message already went out on Meta (irreversible).
 *       queued   — never attempted; safe to re-send.
 *       failed   — attempted but Meta rejected; re-sending may or may not
 *                  succeed depending on the failure code.
 *
 * Recommended manual recovery:
 *
 *   1. Identify the crashed broadcast(s) — query above.
 *
 *   2. Decide whether to retry. If the `queued` set is small (<50) and
 *      time-sensitive, manually create a new broadcast targeted at JUST
 *      those contacts:
 *
 *        SELECT "contactId" FROM "BroadcastRecipient"
 *        WHERE "broadcastId" = '<crashed-id>' AND status = 'queued';
 *
 *      Pipe the result into the contactIds field of a new broadcast via
 *      the UI's "send to specific contacts" path. Use the same template,
 *      audience-substitute with these ids only.
 *
 *   3. For `failed` recipients, investigate per-row `errorDetail`. Most
 *      common: 24h window closed (template was used outside the window)
 *      or contact's phone became invalid. These usually shouldn't be
 *      retried automatically.
 *
 * Future-proof: a proper resume button would need each recipient to
 * record `attemptedAt` BEFORE the Meta call so a recovery can ask Meta
 * (GET /v?/messages?fields=) whether the message ID exists. Out of
 * scope for pilot; documented here for whoever picks it up.
 * ─────────────────────────────────────────────────────────────────────────
 */
export async function reconcileOrphanedBroadcasts(): Promise<void> {
  const orphans = await db.broadcast.findMany({
    where: { status: "running" },
    select: { id: true, teamId: true },
  });
  if (orphans.length === 0) return;

  console.warn(
    `[broadcast-reconciler] flipping ${orphans.length} orphaned running broadcast(s) to failed`,
  );

  const errorMessage = "process restarted mid-broadcast; resume not supported";
  await db.broadcast.updateMany({
    where: { id: { in: orphans.map((o) => o.id) } },
    data: {
      status: "failed",
      lastError: errorMessage,
      completedAt: new Date(),
    },
  });

  for (const o of orphans) {
    await publish({
      type: "broadcast.status_changed",
      teamId: o.teamId,
      broadcastId: o.id,
      status: "failed",
      error: errorMessage,
    });
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
