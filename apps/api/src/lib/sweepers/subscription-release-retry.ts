// Note: no `server-only` import — the NestJS api process loads this on boot
// via @swc-node/register, outside the Next bundler context.

import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto/envelope";
import { getMetaConnection } from "@/lib/providers/meta-connection";
import { releasePageSubscription } from "@/lib/providers/meta-page-subscription";
import { releaseWabaSubscription } from "@/lib/providers/meta-waba-subscription";
import { isPoolClosedError } from "@/lib/sweepers/_mutex";
import type { Channel } from "@ccp/shared/types";
import type { Prisma } from "@prisma/client";

/**
 * Retry ledger for webhook-subscription RELEASES owed to Meta (2026-08-13).
 *
 * Removing an account (or disconnecting a channel) must tell Meta to stop
 * delivering its webhooks. That release used to be ONE fire-and-forget Graph
 * call: a blip, and the removed customer's message content kept arriving
 * forever — dropped fail-soft as `unknown_account`, but "we drop it" is not
 * "we don't receive it". The `PendingSubscriptionRelease` row is written
 * BEFORE the inline attempt and deleted on success, so a failure leaves a
 * durable IOU this sweeper settles.
 *
 * A row OUTLIVES the workspace it was owed for (`workspaceId` is nullable,
 * SetNull): deleting a workspace or an organization is the loudest case of an
 * owed release, and a cascading FK would have destroyed the IOU for exactly
 * the tenant nobody is left to notice.
 *
 * Retry discipline mirrors outbound webhooks: exponential backoff, a loud
 * give-up at 7 attempts (the worst case is the documented status quo ante).
 * Before each retry the sweeper re-checks whether any ACTIVE connection uses
 * the WABA/Page again — a reconnect that raced the removal makes the release
 * moot (releasing then would take the LIVE account's inbound dark), so the
 * row is dropped without calling Graph.
 */

const SWEEP_INTERVAL_MS = 30 * 60_000;
const MAX_PER_TICK = 20;
const MAX_ATTEMPTS = 7;
const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v26.0";
// 30min, 1h, 2h, 4h, 8h, 16h — capped at 24h.
const backoffMs = (attempts: number): number =>
  Math.min(30 * 60_000 * 2 ** attempts, 24 * 60 * 60_000);

/** The removed row's OWN ciphertexts, copied into the ledger. */
export interface PendingReleaseSecrets {
  accessToken?: string;
  appSecret?: string;
}

/**
 * Write the IOU. Called BEFORE the inline release attempt so a crash between
 * attempt and verdict still leaves the row. Best-effort: `null` (write
 * failed) degrades to the pre-2026-08-13 behavior — one inline attempt.
 */
export async function enqueuePendingRelease(args: {
  /**
   * `null` when the workspace itself was just deleted — the FK is SetNull for
   * exactly that case, so the IOU survives the tenant it was owed for. Every
   * credential the retry needs is copied into `secrets` below.
   */
  workspaceId: string | null;
  channel: Channel;
  externalObjectId: string;
  secrets: PendingReleaseSecrets;
}): Promise<string | null> {
  try {
    const row = await db.pendingSubscriptionRelease.create({
      data: {
        workspaceId: args.workspaceId,
        channel: args.channel,
        externalObjectId: args.externalObjectId,
        secrets: args.secrets as Prisma.InputJsonObject,
      },
      select: { id: true },
    });
    return row.id;
  } catch (err) {
    console.warn(
      "[subscription-release] could not write the retry ledger row:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** The inline attempt succeeded — settle the IOU. */
export async function resolvePendingRelease(id: string | null): Promise<void> {
  if (!id) return;
  await db.pendingSubscriptionRelease.delete({ where: { id } }).catch(() => undefined);
}

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

export function startSubscriptionReleaseRetrySweeper(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    sweepSubscriptionReleasesOnce()
      .catch((err) => {
        if (isPoolClosedError(err)) {
          stopSubscriptionReleaseRetrySweeper();
          return;
        }
        console.warn(
          "[subscription-release-retry] iteration failed:",
          err instanceof Error ? err.message : err,
        );
      })
      .finally(() => {
        inFlight = false;
      });
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopSubscriptionReleaseRetrySweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Is the WABA/Page in active use again? Then the release is moot. */
async function objectBackInUse(
  workspaceId: string | null,
  channel: Channel,
  externalObjectId: string,
): Promise<boolean> {
  if (channel === "whatsapp") {
    return (
      (await db.channelConnection.count({
        where: {
          // Null = the workspace was deleted with the account, so ask the
          // question globally. `externalWabaId` is globally unique, which is
          // what makes the unscoped read answer the same question.
          ...(workspaceId ? { workspaceId } : {}),
          channel: "whatsapp",
          isActive: true,
          wabaAccount: { externalWabaId: externalObjectId },
        },
      })) > 0
    );
  }
  // Social: the Page is shared by messenger AND instagram — either keeps it,
  // and so does a SIBLING WORKSPACE connected to the same Page, because the
  // subscription this release would delete is the APP's, not the workspace's.
  // Same reasoning (and the same deliberate absence of workspaceId) as
  // `releaseSubscription` in channel-accounts.service.ts.
  return (
    (await db.channelConnection.count({
      where: {
        channel: { in: ["messenger", "instagram"] },
        isActive: true,
        config: { path: ["pageId"], equals: externalObjectId },
      },
    })) > 0
  );
}

// Exported for the spec — production entry is the interval above.
export async function sweepSubscriptionReleasesOnce(): Promise<void> {
  const due = await db.pendingSubscriptionRelease.findMany({
    where: { nextAttemptAt: { lte: new Date() } },
    orderBy: { nextAttemptAt: "asc" },
    take: MAX_PER_TICK,
  });
  for (const row of due) {
    try {
      if (await objectBackInUse(row.workspaceId, row.channel, row.externalObjectId)) {
        await db.pendingSubscriptionRelease.delete({ where: { id: row.id } }).catch(() => undefined);
        console.log(
          `[subscription-release-retry] ${row.channel} object ${row.externalObjectId} is in use again — release moot, row dropped`,
        );
        continue;
      }
      const secrets = (row.secrets ?? {}) as PendingReleaseSecrets;
      let accessToken: string | null = null;
      try {
        accessToken = secrets.accessToken ? decryptSecret(secrets.accessToken) : null;
      } catch {
        accessToken = null;
      }
      let appSecret: string | undefined;
      if (secrets.appSecret) {
        try {
          appSecret = decryptSecret(secrets.appSecret);
        } catch {
          appSecret = undefined;
        }
      }
      if (!appSecret && row.workspaceId) {
        // Same fallback the inline path uses: the workspace's shared app. A null
        // workspace has no row to read — the enqueuer copied the shared app's
        // ciphertext into the ledger for exactly that case.
        appSecret = (await getMetaConnection(row.workspaceId))?.appSecret ?? undefined;
      }
      const result = !accessToken
        ? { ok: false as const, error: "no decryptable access token in ledger" }
        : row.channel === "whatsapp"
          ? await releaseWabaSubscription(row.externalObjectId, accessToken, GRAPH_VERSION, appSecret)
          : await releasePageSubscription(row.externalObjectId, accessToken, GRAPH_VERSION, {
              stillInUse: false,
              ...(appSecret ? { appSecret } : {}),
            });
      if (result.ok) {
        await db.pendingSubscriptionRelease.delete({ where: { id: row.id } }).catch(() => undefined);
        console.log(
          `[subscription-release-retry] released ${row.channel} subscription on ${row.externalObjectId} (attempt ${row.attempts + 1})`,
        );
        continue;
      }
      const attempts = row.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        // Give up LOUDLY — the worst case is the documented status quo ante
        // (Meta keeps POSTing; ingest drops as `unknown_account`), but an
        // operator should know the DELETE never landed.
        console.error(
          `[subscription-release-retry] GIVING UP after ${attempts} attempts — could not release ` +
            `${row.channel} subscription on ${row.externalObjectId} (workspace ${row.workspaceId ?? "deleted"}): ${result.error}. ` +
            "Meta will keep delivering this object's webhooks; remove the app's subscription in the Meta dashboard.",
        );
        await db.pendingSubscriptionRelease.delete({ where: { id: row.id } }).catch(() => undefined);
        continue;
      }
      await db.pendingSubscriptionRelease
        .update({
          where: { id: row.id },
          data: {
            attempts,
            lastError: result.error.slice(0, 500),
            nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
          },
        })
        .catch(() => undefined);
    } catch (err) {
      if (isPoolClosedError(err)) throw err;
      console.warn(
        `[subscription-release-retry] row ${row.id} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
