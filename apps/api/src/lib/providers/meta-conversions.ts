/**
 * Meta Conversions API for BUSINESS MESSAGING — the wire half of the
 * `send_conversions_event` workflow step (CTWA / click-to-Messenger ad
 * optimization).
 *
 * Two Graph calls, both on the channel's OWN access token:
 *
 *   1. `POST /{host-id}/dataset` — resolve (or lazily create) the dataset that
 *      collects the channel identity's conversion events. The host id is the
 *      WABA (WhatsApp), the Page (Messenger) or the IG professional account
 *      (Instagram). Meta documents the edge as idempotent: "if there is
 *      already an existing dataset_id associated, it will return that id".
 *   2. `POST /{dataset-id}/events` — the event itself, with
 *      `action_source: "business_messaging"` + a per-channel `user_data`.
 *
 * Wire fields we deliberately DO NOT send:
 *   - `partner_agent` — we have no Meta-assigned partner name.
 *   - `messaging_outcome_data` — documented for Meta's AUTOMATIC events only.
 *
 * Retry posture mirrors the send path (`meta-graph.ts` header): the events
 * POST is non-idempotent on Meta's side — Meta does NOT dedupe
 * business-messaging events even when `event_id` is present ("we highly
 * encourage advertisers to perform deduplication before sending") — so there
 * is no in-module retry; BullMQ redelivery + the runner's irreversible-step
 * journal own that (see the step handler).
 */

import type { Channel } from "@ccp/shared/types";

import { db } from "@/lib/db";

import { invalidateProviderConfig } from "./config";
import { TtlCache } from "./config-cache";
import { invalidateInstagramConfig } from "./instagram-config";
import { invalidateMessengerConfig } from "./messenger-config";
import { GRAPH_BASE, graphPostJson } from "./meta-graph";

/** The three channels Meta's business-messaging Conversions API covers. */
export type ConversionsChannel = "whatsapp" | "messenger" | "instagram";

export function isConversionsChannel(c: Channel): c is ConversionsChannel {
  return c === "whatsapp" || c === "messenger" || c === "instagram";
}

/**
 * The Graph permission the connected app needs before the dataset / events
 * edges answer — a BYO-app token may lack it, and the actionable fix is a
 * dashboard grant, not a reconnect. Surfaced verbatim in step failures.
 */
export function conversionsPermissionHint(channel: ConversionsChannel): string {
  switch (channel) {
    case "whatsapp":
      return "grant whatsapp_business_management + whatsapp_business_manage_events to the connected app";
    case "messenger":
      return "grant page_events to the connected app";
    case "instagram":
      return "grant instagram_manage_events to the connected app";
  }
}

/** `ChannelConnection.config` key the resolved dataset id is persisted under. */
const CONFIG_DATASET_KEY = "capiDatasetId";

// Dataset ids are permanent once minted, so the TTL exists only to bound how
// long a stale in-memory copy could outlive a config wipe — 24h is plenty and
// a miss costs one idempotent Graph POST. Keyed by (workspace, channel, host
// id) rather than connection id because the id belongs to the Meta-side
// identity, and a thread with a nulled `channelConnectionId` still resolves.
const datasetCache = new TtlCache<string>(24 * 60 * 60 * 1000);

function datasetKey(workspaceId: string, channel: ConversionsChannel, hostId: string): string {
  return `${workspaceId}::${channel}::${hostId}`;
}

/**
 * Resolve the Conversions API dataset id for one channel identity.
 *
 * Read-through order: in-process cache → `ChannelConnection.config.capiDatasetId`
 * (when the caller knows which connection row the thread is bound to) →
 * `POST /{host-id}/dataset`. A freshly minted id is persisted back into the
 * connection's config opportunistically — CAS-guarded on `updatedAt`, because
 * a settings save replaces the WHOLE config JSON and a blind read-modify-write
 * spanning the Graph round-trip would revert it. On a lost race the save wins
 * and the id is simply re-resolved next send (the `/dataset` edge is
 * idempotent). Never a schema column (CLAUDE.md: config JSON is the home for
 * per-connection non-secret facts).
 */
export async function resolveConversionsDatasetId(args: {
  workspaceId: string;
  channel: ConversionsChannel;
  /** The thread's `ChannelConnection` id, when known. Null = cache/Graph only. */
  connectionId: string | null;
  /** WABA id / Page id / IG professional-account id — the dataset host node. */
  hostId: string;
  accessToken: string;
  graphVersion: string;
  appSecret?: string;
}): Promise<string> {
  const key = datasetKey(args.workspaceId, args.channel, args.hostId);
  const hit = datasetCache.get(key);
  if (hit) return hit;

  // SECURITY: workspaceId stays in the WHERE — same rule as the config
  // loaders; a mis-stamped connection id must not read another tenant's row.
  const conn = args.connectionId
    ? await db.channelConnection.findFirst({
        where: { id: args.connectionId, workspaceId: args.workspaceId },
        select: { id: true, config: true },
      })
    : null;
  const config = (conn?.config ?? {}) as Record<string, unknown>;
  const stored = config[CONFIG_DATASET_KEY];
  if (typeof stored === "string" && stored.length > 0) {
    datasetCache.set(key, stored);
    return stored;
  }

  const res = await graphPostJson(
    `${GRAPH_BASE}/${args.graphVersion}/${args.hostId}/dataset`,
    args.accessToken,
    {},
    args.appSecret,
  );
  const datasetId = typeof res.id === "string" ? res.id : "";
  if (!datasetId) {
    throw new Error(
      `conversions dataset resolve returned no id for ${args.channel} host ${args.hostId}`,
    );
  }
  datasetCache.set(key, datasetId);

  if (conn) {
    // Opportunistic persist so the id survives a restart. CAS on `updatedAt`
    // (same style as the sweepers' config writes): the Graph POST above is a
    // window a concurrent settings save can land in, and merging into the copy
    // read BEFORE it would silently revert that save. Re-read, merge, and only
    // write if nobody else did — on a lost race the id re-resolves next send.
    try {
      const row = await db.channelConnection.findFirst({
        where: { id: conn.id, workspaceId: args.workspaceId },
        select: { config: true, updatedAt: true },
      });
      if (row) {
        const won = await db.channelConnection.updateMany({
          where: { id: conn.id, workspaceId: args.workspaceId, updatedAt: row.updatedAt },
          data: {
            config: {
              ...((row.config ?? {}) as Record<string, unknown>),
              [CONFIG_DATASET_KEY]: datasetId,
            },
          },
        });
        if (won.count > 0) {
          // The cached send config snapshots this row — drop it the same way
          // the settings path does, per channel.
          if (args.channel === "whatsapp") invalidateProviderConfig(args.workspaceId);
          else if (args.channel === "messenger") invalidateMessengerConfig(args.workspaceId);
          else invalidateInstagramConfig(args.workspaceId);
        }
      }
    } catch {
      // Row deleted / DB blip — nothing to reconcile; the cache carries this
      // process and the edge re-answers the same id.
    }
  }
  return datasetId;
}

/**
 * Build the `POST /{dataset-id}/events` body. Pure — unit-tested per channel.
 *
 * `event_time` is unix SECONDS and must be ≤7 days old; callers stamp "now" at
 * step run time. `event_id` is accepted by Meta but NOT used to dedupe
 * business-messaging events — it is a harmless belt on top of our own
 * journaling. `test_event_code` routes the event to Events Manager's Test
 * Events tab as a plumbing check, but Meta still USES those events for
 * delivery ("not dropped") — it is not a sandbox.
 */
export function buildConversionsEventBody(args: {
  channel: ConversionsChannel;
  eventName: string;
  /** Unix seconds. */
  eventTime: number;
  eventId: string;
  userData: Record<string, string>;
  currency?: string;
  value?: number;
  testEventCode?: string;
}): Record<string, unknown> {
  return {
    data: [
      {
        event_name: args.eventName,
        event_time: args.eventTime,
        event_id: args.eventId,
        action_source: "business_messaging",
        messaging_channel: args.channel,
        user_data: args.userData,
        ...(args.value !== undefined
          ? { custom_data: { currency: args.currency, value: args.value } }
          : {}),
      },
    ],
    ...(args.testEventCode ? { test_event_code: args.testEventCode } : {}),
  };
}

/**
 * Per-channel `user_data`. WhatsApp is keyed by the WABA + the contact's
 * `ctwa_clid` (REQUIRED there, and never hashed); the social channels are
 * keyed by the account + the account-scoped user id (PSID / IGSID).
 *
 * NOTE (Instagram): Meta's parameters REFERENCE names the account field
 * `ig_account_id`, while one payload sample shows `instagram_business_account_id`.
 * The reference wins — we send `ig_account_id`.
 */
export function conversionsUserData(
  args:
    | { channel: "whatsapp"; wabaId: string; ctwaClid: string }
    | { channel: "messenger"; pageId: string; psid: string }
    | { channel: "instagram"; igId: string; igsid: string },
): Record<string, string> {
  switch (args.channel) {
    case "whatsapp":
      return { whatsapp_business_account_id: args.wabaId, ctwa_clid: args.ctwaClid };
    case "messenger":
      return { page_id: args.pageId, page_scoped_user_id: args.psid };
    case "instagram":
      return { ig_account_id: args.igId, ig_sid: args.igsid };
  }
}

/** POST the event. Throws `MetaSendError` on non-2xx (see meta-graph.ts). */
export async function postConversionsEvent(args: {
  datasetId: string;
  body: Record<string, unknown>;
  accessToken: string;
  graphVersion: string;
  appSecret?: string;
}): Promise<Record<string, unknown>> {
  return graphPostJson(
    `${GRAPH_BASE}/${args.graphVersion}/${args.datasetId}/events`,
    args.accessToken,
    args.body,
    args.appSecret,
  );
}
