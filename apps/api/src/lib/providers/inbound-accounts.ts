/**
 * Which of OUR accounts is each inbound event about — and what to do when we
 * can't tell.
 *
 * ## Why this module exists
 *
 * Meta's webhook contract is explicit: `entry` is "an array containing an object
 * describing the changes", and "multiple changes from DIFFERENT OBJECTS that are
 * of the same type may be batched together", up to 1000 updates per POST, with
 * batching guaranteed in neither direction. A workspace holding two WhatsApp
 * numbers (or two Pages, or two IG accounts) can therefore receive ONE POST
 * carrying traffic for both.
 *
 * The route used to resolve a single account for the whole body — the first
 * `metadata.phone_number_id` / `entry[].id` it found — and stamp every event with
 * it. The damage was not cosmetic:
 *
 *   - `Conversation.channelConnectionId` is re-stamped on every inbound, so the
 *     second number's threads were re-pointed at the FIRST number. The agent's
 *     next reply then went out an account the customer had never messaged, where
 *     no 24-hour customer-service window exists — so it either hard-failed or
 *     silently demanded a template.
 *   - `Message.channelConnectionId`, the immutable historical stamp, was wrong,
 *     so per-account analytics, CSV exports and outbound-webhook `channel`
 *     blocks all misreported which number carried the message.
 *   - The per-account inbox filter filed threads under the wrong account.
 *
 * So attribution is PER-EVENT. Parsers stamp the vendor's own id onto each
 * `NormalizedEvent` (`NormalizedEventSource.externalAccountId`); this module maps
 * those ids to `ChannelConnection` rows, tenant-scoped, and owns the policy for
 * the events that name no account. HMAC verification is unaffected and untouched
 * — it already tries every active account's secret (`getMetaWebhookConfig`).
 *
 * ## The policy, in one table
 *
 * | the event carries                                  | outcome                                    |
 * |----------------------------------------------------|--------------------------------------------|
 * | an id this workspace owns                          | that account's group                       |
 * | an id NO connection owns                           | dropped — that group only, never the batch |
 * | no id, and its ingest path CONSUMES an account     | the sole active account, else dropped      |
 * | no id, and it is account-agnostic                  | the UNATTRIBUTED group (per-event resolve) |
 *
 * The unattributed group passes `channelConnectionId: undefined` to
 * `ingestEvents`, which is exactly the pre-existing "account-level" contract:
 * WhatsApp's `phone_number_quality_update`, `business_capability_update`,
 * `account_update`, `account_alerts` and template lifecycle events name their own
 * subject inside the body, and ingest resolves it via
 * `resolveWhatsappHealthAccount` / the WABA-scoped template match. That behaviour
 * is preserved deliberately — it is more specific than "the account this arrived
 * on", not less.
 *
 * @see apps/api/src/webhooks/meta/meta.controller.ts — the only caller
 * @see packages/shared/src/providers/types.ts — `NormalizedEventSource`
 */

import { db } from "@/lib/db";
import type { Channel } from "@ccp/shared/types";
import type { NormalizedEvent } from "@ccp/shared/providers/types";

/** One account's slice of a (possibly batched) webhook POST. */
export interface InboundAccountGroup {
  /**
   * Our `ChannelConnection.id`, or `undefined` for the UNATTRIBUTED group.
   * Passed straight through as `ingestEvents`' 4th argument, so `undefined`
   * keeps the established account-level semantics.
   */
  channelConnectionId: string | undefined;
  /** The provider id this group was keyed on; undefined when unattributed. */
  externalAccountId: string | undefined;
  events: NormalizedEvent[];
}

export interface DroppedInboundEvents {
  externalAccountId: string | undefined;
  count: number;
  /**
   * `unknown_account` — the payload named an account no connection in this
   * workspace claims (a foreign or already-removed number/Page).
   * `unattributable` — the event needs an account, named none, and the workspace
   * holds zero or several active ones, so there is no unambiguous answer.
   */
  reason: "unknown_account" | "unattributable";
}

export interface GroupedInboundEvents {
  /** Ingestable groups in payload order. Callers MUST ingest sequentially. */
  groups: InboundAccountGroup[];
  dropped: DroppedInboundEvents[];
}

/**
 * True when the event's ingest path CONSUMES the receiving account — i.e. it
 * creates or re-stamps a conversation, so guessing wrong actively corrupts
 * state. Everything else is account-agnostic: a status/watermark/reaction/edit
 * resolves its target by message id, and the account-level notifications resolve
 * their own subject. Those must NOT be dropped for want of an account, or a
 * degenerate payload would lose read receipts and delivery ticks.
 */
export function isAccountBoundEvent(evt: NormalizedEvent): boolean {
  return evt.kind === "message" || evt.kind === "echo" || evt.kind === "call";
}

/**
 * Map provider account ids → our `ChannelConnection.id`, in one indexed query
 * (served by `@@index([channel, externalAccountId])`).
 *
 * `workspaceId` is always in the `where` (CLAUDE.md §7): an account id alone must
 * never reach across tenants. Deliberately NOT filtered on `isActive` — this
 * matches the behaviour it replaces, so a number that was deactivated in the UI
 * still attributes its in-flight inbound instead of silently losing it.
 */
export async function resolveInboundAccounts(
  workspaceId: string,
  channel: Channel,
  externalAccountIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(externalAccountIds)].filter((id) => id.length > 0);
  if (ids.length === 0) return new Map();
  const rows = await db.channelConnection.findMany({
    where: { workspaceId, channel, externalAccountId: { in: ids } },
    select: { id: true, externalAccountId: true },
  });
  return new Map(rows.map((r) => [r.externalAccountId, r.id]));
}

/**
 * The workspace's ONE active account on a channel — null at zero or several.
 *
 * This is the honest fallback for an account-bound event that names no account,
 * and it deliberately replaces the old `isDefault: true` fallback. `isDefault` is
 * a SEND preference ("which number do we compose from"); using it to attribute
 * INBOUND binds a thread to a Page the customer never messaged, which is the very
 * bug this module exists to kill. With one active account the answer is
 * unambiguous; with several, refuse rather than guess. `loadSendCipher` already
 * reasons exactly this way for outbound — same rule, same reason.
 */
export async function soleActiveAccountId(
  workspaceId: string,
  channel: Channel,
): Promise<string | null> {
  const rows = await db.channelConnection.findMany({
    where: { workspaceId, channel, isActive: true },
    select: { id: true },
    take: 2,
  });
  return rows.length === 1 ? rows[0]!.id : null;
}

/**
 * Partition a parsed batch by the account each event actually arrived on.
 *
 * The result is a STRICT partition: every event lands in exactly one group or is
 * counted in `dropped`. Nothing is duplicated and no `externalId` is derived from
 * the account, so message dedup (`@@unique([workspaceId, channel, externalId])`)
 * is unaffected and a 503 → Meta redelivery re-runs every group idempotently.
 *
 * Groups come back in payload order and MUST be ingested SEQUENTIALLY. That is
 * load-bearing, not caution: one customer messaging two of your numbers in the
 * same POST is the same `Contact`, and `ingestEvents`' contact-bucketing only
 * serialises within a single call — running groups concurrently would reintroduce
 * the competing `contact.update()` writes (P2034) that the bucketing exists to
 * prevent. Payload order also means a thread touched by two accounts in one POST
 * ends up stamped with the last account Meta listed, which is the same
 * last-writer-wins rule a sequence of separate POSTs would produce.
 */
export async function groupEventsByInboundAccount(
  workspaceId: string,
  channel: Channel,
  events: readonly NormalizedEvent[],
): Promise<GroupedInboundEvents> {
  if (events.length === 0) return { groups: [], dropped: [] };

  const named = events.flatMap((e) => (e.externalAccountId ? [e.externalAccountId] : []));
  const resolved = await resolveInboundAccounts(workspaceId, channel, named);

  // Resolved lazily and at most once: a single-account workspace (the common
  // case) only pays for it if some event genuinely arrived without an id.
  let soleLookup: Promise<string | null> | undefined;
  const sole = (): Promise<string | null> => {
    soleLookup ??= soleActiveAccountId(workspaceId, channel);
    return soleLookup;
  };

  // Keyed by externalAccountId, with a fixed key for the unattributed bucket so
  // it can never collide with a real provider id.
  const UNATTRIBUTED = " unattributed";
  const byAccount = new Map<string, InboundAccountGroup>();
  const dropped = new Map<string, DroppedInboundEvents>();

  const push = (key: string, group: Omit<InboundAccountGroup, "events">, evt: NormalizedEvent) => {
    const existing = byAccount.get(key);
    if (existing) existing.events.push(evt);
    else byAccount.set(key, { ...group, events: [evt] });
  };
  const drop = (reason: DroppedInboundEvents["reason"], externalAccountId?: string) => {
    const key = `${reason}:${externalAccountId ?? ""}`;
    const existing = dropped.get(key);
    if (existing) existing.count += 1;
    else dropped.set(key, { externalAccountId, count: 1, reason });
  };

  for (const evt of events) {
    const wireId = evt.externalAccountId;

    if (wireId) {
      const connectionId = resolved.get(wireId);
      if (!connectionId) {
        // The payload names an account we don't hold. Drop THIS event only —
        // dropping the whole POST is what silently lost a sibling's inbound.
        drop("unknown_account", wireId);
        continue;
      }
      push(wireId, { channelConnectionId: connectionId, externalAccountId: wireId }, evt);
      continue;
    }

    if (!isAccountBoundEvent(evt)) {
      // Account-agnostic: goes in unattributed, where `ingestEvents` receives
      // `undefined` and each branch resolves its own subject.
      push(UNATTRIBUTED, { channelConnectionId: undefined, externalAccountId: undefined }, evt);
      continue;
    }

    const fallback = await sole();
    if (!fallback) {
      drop("unattributable");
      continue;
    }
    push(fallback, { channelConnectionId: fallback, externalAccountId: undefined }, evt);
  }

  return { groups: [...byAccount.values()], dropped: [...dropped.values()] };
}

/** Distinct provider account ids named anywhere in a parsed batch, in order. */
export function distinctExternalAccountIds(events: readonly NormalizedEvent[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const evt of events) {
    const id = evt.externalAccountId;
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
