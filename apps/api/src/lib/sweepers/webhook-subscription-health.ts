// Note: no `server-only` import — the NestJS api process loads this on boot
// via @swc-node/register, outside the Next bundler context.

import { db } from "@/lib/db";
import { pickWabaProbe } from "@/lib/providers/waba-probe";
import { flagChannelNeedsReconnect } from "@/lib/providers/channel-health";
import { getMetaSendConfig } from "@/lib/providers/config";
import { getInstagramSendConfig } from "@/lib/providers/instagram-config";
import { getMessengerSendConfig } from "@/lib/providers/messenger-config";
import { GRAPH_BASE, graphGetJson } from "@/lib/providers/meta-graph";
import {
  ensurePageSubscribedToMessaging,
  getPageSubscription,
} from "@/lib/providers/meta-page-subscription";
import {
  ensureWabaSubscribed,
  isAppSubscribedToWaba,
} from "@/lib/providers/meta-waba-subscription";
import { ProviderNotConfiguredError } from "@/lib/providers/config";
import { isPoolClosedError } from "@/lib/sweepers/_mutex";
import type { Channel } from "@ccp/shared/types";

/**
 * Inbound-webhook GAP DETECTION — the one hole where customer data used to
 * disappear with no signal anywhere (ops audit 2026-07-28).
 *
 * Inbound needs two things to keep working, and neither failure produces an
 * error on our side:
 *
 *   1. The app must stay SUBSCRIBED to the WABA / Page. A Meta-dashboard
 *      re-save silently resets this — exactly what took Messenger dark in prod
 *      on 2026-07-10 (meta-page-subscription.ts). Valid credentials, zero
 *      inbound, no error.
 *   2. The connection's TOKEN must stay alive. A dead token doesn't break
 *      inbound directly (webhook delivery needs no token) but it is the
 *      leading indicator of a revoked/expired integration, and today it is
 *      only discovered when a SEND fails (channel-health.ts) — a receive-only
 *      workspace could run for days on a corpse.
 *
 * Every 30 min, for every active Meta-backed connection: read the actual
 * subscription state from Graph; if missing, SELF-HEAL first (the existing
 * idempotent ensure* helpers used at connect time), and only when healing
 * fails: flag `needsReconnect` (drives the existing Settings reconnect banner
 * the workspace admin sees) + log a greppable BROKEN line. Token-dead
 * (Graph 190/OAuthException) flags + logs the same way.
 *
 * Logging discipline: in-memory per-connection state so BROKEN/RECOVERED log
 * on TRANSITION, not per tick. Transient network/Graph-5xx failures never
 * change state — the next tick retries, and a flapping signal trains the
 * reader to ignore the real one.
 */

const SWEEP_INTERVAL_MS = 30 * 60_000;
/** Independent Graph GETs — keep the burst small. */
const CHECK_CONCURRENCY = 4;

type ConnState = "ok" | "broken";
/** connectionId → last definitive state (process-local; a restart re-logs
 *  a still-broken connection once, which is acceptable — arguably correct). */
const lastState = new Map<string, ConnState>();

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

/**
 * Opt-out for local dev. The sweeper probes REAL `graph.facebook.com` with
 * whatever credentials the DB holds, and a dev box holds expired tokens and
 * seeded fixtures — so 30 minutes after boot it flags every connection and every
 * thread grows a "reconnect this account" banner that is true of the fixture and
 * useless to the developer. Prod is unaffected: absent the variable this stays
 * on, and it is refused outright under NODE_ENV=production so a stray value in a
 * deploy env can never silently disable inbound-gap detection.
 */
function sweeperDisabled(): boolean {
  if (process.env.WEBHOOK_HEALTH_SWEEP !== "0") return false;
  if (process.env.NODE_ENV === "production") {
    console.warn(
      "[webhook-subscription-health] WEBHOOK_HEALTH_SWEEP=0 ignored in production — " +
        "inbound-gap detection stays on",
    );
    return false;
  }
  return true;
}

export function startWebhookSubscriptionHealthSweeper(): void {
  if (timer) return;
  if (sweeperDisabled()) {
    console.log("[webhook-subscription-health] WEBHOOK_HEALTH_SWEEP=0 — sweeper not started");
    return;
  }
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    sweepWebhookSubscriptionHealthOnce()
      .catch((err) => {
        if (isPoolClosedError(err)) {
          stopWebhookSubscriptionHealthSweeper();
          return;
        }
        console.warn(
          "[webhook-subscription-health] iteration failed:",
          err instanceof Error ? err.message : err,
        );
      })
      .finally(() => {
        inFlight = false;
      });
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopWebhookSubscriptionHealthSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

interface CheckResult {
  /** Definitive verdicts only; transient errors return null (no state change). */
  state: ConnState | null;
  /** Human detail for the alert/log line. */
  detail: string;
  /** True when the missing subscription was re-established this tick. */
  healed?: boolean;
}

/** Graph 190 / OAuthException = the token itself is dead (vs a transient failure). */
function isTokenError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('"code":190') || msg.includes("OAuthException");
}

async function checkWhatsapp(
  workspaceId: string,
  connectionId: string,
  wabaId: string,
): Promise<CheckResult> {
  let config;
  try {
    config = await getMetaSendConfig(workspaceId, connectionId);
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      return { state: null, detail: "not configured — skipped" };
    }
    throw err;
  }
  const url = `${GRAPH_BASE}/${config.graphVersion}/${encodeURIComponent(wabaId)}/subscribed_apps`;
  try {
    const res = await graphGetJson(url, config.accessToken, { retry: true });
    // OUR app, not just any app — see isAppSubscribedToWaba. A WABA shared with
    // another BSP reads back non-empty while we receive nothing.
    if (isAppSubscribedToWaba(res, config.appId)) return { state: "ok", detail: "subscribed" };
    const others = Array.isArray(res.data) ? res.data.length : 0;
    const missing =
      others > 0
        ? `this app is not subscribed (${others} other app(s) are)`
        : "WABA not subscribed";
    // Missing — self-heal with the same idempotent helper onboarding uses.
    const healed = await ensureWabaSubscribed(
      wabaId,
      config.accessToken,
      config.graphVersion,
      config.appId,
    );
    if (healed.ok) {
      return { state: "ok", detail: `${missing} — re-subscribed`, healed: true };
    }
    return { state: "broken", detail: `${missing} and re-subscribe failed: ${healed.error}` };
  } catch (err) {
    if (isTokenError(err)) {
      return { state: "broken", detail: "access token dead (Graph 190) — reconnect required" };
    }
    return { state: null, detail: `transient: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function checkPageChannel(
  channel: "messenger" | "instagram",
  workspaceId: string,
  connectionId: string,
): Promise<CheckResult> {
  let pageId: string;
  let token: string;
  let graphVersion: string;
  let appId: string | undefined;
  try {
    if (channel === "messenger") {
      const cfg = await getMessengerSendConfig(workspaceId, connectionId);
      pageId = cfg.pageId;
      token = cfg.pageAccessToken;
      graphVersion = cfg.graphVersion;
      appId = cfg.appId;
    } else {
      // Instagram-via-Facebook-Login rides the linked PAGE for webhooks, same
      // as sends — the subscription that matters lives on the Page node.
      const cfg = await getInstagramSendConfig(workspaceId, connectionId);
      pageId = cfg.pageId;
      token = cfg.igAccessToken;
      graphVersion = cfg.graphVersion;
      appId = cfg.appId;
    }
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      return { state: null, detail: "not configured — skipped" };
    }
    throw err;
  }
  try {
    // Scoped to our app id when we have one: a Page shared with another app
    // otherwise reported that app's `messages` subscription as ours.
    const sub = await getPageSubscription(pageId, token, graphVersion, appId);
    if (sub.receivesMessages) return { state: "ok", detail: "subscribed" };
    const healed = await ensurePageSubscribedToMessaging(pageId, token, graphVersion, appId);
    if (healed.ok) {
      return { state: "ok", detail: "Page `messages` subscription was MISSING — re-subscribed", healed: true };
    }
    return { state: "broken", detail: `Page not subscribed to messages and re-subscribe failed: ${healed.error}` };
  } catch (err) {
    if (isTokenError(err)) {
      return { state: "broken", detail: "access token dead (Graph 190) — reconnect required" };
    }
    return { state: null, detail: `transient: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function sweepWebhookSubscriptionHealthOnce(): Promise<void> {
  const connections = await db.channelConnection.findMany({
    where: {
      isActive: true,
      channel: { in: ["whatsapp", "messenger", "instagram"] },
    },
    select: {
      id: true,
      workspaceId: true,
      channel: true,
      label: true,
      isDefault: true,
      // `pickWabaProbe` breaks an isDefault tie by age, so it needs this.
      createdAt: true,
      wabaAccount: { select: { externalWabaId: true } },
      workspace: { select: { name: true } },
    },
  });
  if (connections.length === 0) return;

  // Drop tracking for connections that no longer exist/are inactive so the
  // map can't grow without bound across reconnect cycles.
  const liveIds = new Set(connections.map((c) => c.id));
  for (const id of lastState.keys()) {
    if (!liveIds.has(id)) lastState.delete(id);
  }

  // One unit of WORK per subscription, not per connection.
  //
  // A WhatsApp webhook subscription lives on the WABA (`/{WABA_ID}/subscribed_apps`)
  // and every number under it shares that one subscription. Checking per connection
  // asked Graph the same question once per number — on a rate-limited API, for an
  // answer that cannot differ — and a WABA with four numbers burned four calls a
  // tick to learn one fact.
  //
  // The RESULT still fans out to every connection under the WABA, so the Settings
  // reconnect banner and the state transitions are byte-for-byte what they were.
  // That fan-out is correct precisely because the resource is shared: if the WABA
  // subscription is gone, every number under it loses inbound together. (Contrast
  // `channel-health.ts`, where flagging siblings was a BUG — a dead access token is
  // per number, so one number's failure says nothing about the next.)
  //
  // Social stays per connection: there the subscription is per PAGE, and a Page is
  // reached through its own connection.
  const units: Array<{ probe: (typeof connections)[number]; applyTo: typeof connections }> = [];
  const byWaba = new Map<string, typeof connections>();
  for (const conn of connections) {
    if (conn.channel === "whatsapp" && conn.wabaAccount) {
      const key = conn.wabaAccount.externalWabaId;
      const group = byWaba.get(key);
      if (group) group.push(conn);
      else byWaba.set(key, [conn]);
    } else {
      units.push({ probe: conn, applyTo: [conn] });
    }
  }
  for (const group of byWaba.values()) {
    // Prefer the default number as the probe — it is the one most likely to hold
    // working credentials, and `getMetaSendConfig` prefers the WABA's own token
    // anyway when it has one.
    // Same rule as the DB-side probes (default first, then oldest). The previous
    // `find(isDefault) ?? group[0]` agreed on the default but fell back to an
    // ARBITRARY row when a WABA has none — the same non-determinism reached a
    // different way.
    const probe = pickWabaProbe(group);
    if (!probe) continue; // unreachable — a group exists only once something is in it
    units.push({ probe, applyTo: group });
  }

  // Small rolling window of concurrent checks.
  const queue = [...units];
  const workers = Array.from({ length: Math.min(CHECK_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const unit = queue.shift();
      if (!unit) return;
      const conn = unit.probe;
      try {
        const result =
          conn.channel === "whatsapp"
            ? conn.wabaAccount
              ? await checkWhatsapp(
                  conn.workspaceId,
                  conn.id,
                  conn.wabaAccount.externalWabaId,
                )
              : { state: null as ConnState | null, detail: "no WABA linked — skipped" }
            : await checkPageChannel(
                conn.channel as "messenger" | "instagram",
                conn.workspaceId,
                conn.id,
              );
        for (const target of unit.applyTo) await applyResult(target, result);
      } catch (err) {
        if (isPoolClosedError(err)) throw err;
        console.warn(
          `[webhook-subscription-health] check failed for connection=${conn.id}: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }
  });
  await Promise.all(workers);
}

async function applyResult(
  conn: {
    id: string;
    workspaceId: string;
    channel: Channel;
    label: string | null;
    workspace: { name: string };
  },
  result: CheckResult,
): Promise<void> {
  const who = `${conn.channel} "${conn.label ?? conn.id}" (workspace "${conn.workspace.name}")`;

  if (result.healed) {
    // Self-healed: inbound was silently OFF until this tick. Not urgent (it's
    // fixed) but a repeating pattern means something keeps resetting the
    // subscription — keep it visible.
    console.warn(`[webhook-subscription-health] HEALED ${who}: ${result.detail}`);
  }

  if (result.state === null) return; // transient / skipped — no transition

  const prev = lastState.get(conn.id);
  lastState.set(conn.id, result.state);

  if (result.state === "broken") {
    // Drive the existing Settings reconnect banner so the workspace admin
    // sees it in-product, not just in the logs.
    await flagChannelNeedsReconnect(conn.workspaceId, conn.channel, conn.id);
    if (prev !== "broken") {
      console.error(`[webhook-subscription-health] BROKEN — INBOUND AT RISK ${who}: ${result.detail}`);
    }
  } else if (prev === "broken") {
    console.log(`[webhook-subscription-health] RECOVERED ${who}`);
  }
}
