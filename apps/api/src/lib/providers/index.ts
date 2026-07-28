import { getMetaSendConfig, type MetaSendConfig } from "@/lib/providers/config";
import { db } from "@/lib/db";
import { metaProvider } from "@/lib/providers/meta";
import { messengerProvider } from "@/lib/providers/messenger";
import { getMessengerSendConfig } from "@/lib/providers/messenger-config";
import { instagramProvider } from "@/lib/providers/instagram";
import { getInstagramSendConfig } from "@/lib/providers/instagram-config";
import { webchatwidgetProvider } from "@/lib/providers/webchatwidget";
import { getWebchatwidgetSendConfig } from "@/lib/providers/webchatwidget-config";
import { LIVE_CHANNELS } from "@ccp/shared/providers/capabilities";
import type { Channel } from "@ccp/shared/types";
import type { MessagingProvider } from "@ccp/shared/providers/types";

/**
 * Provider registry. Three live channels are registered below — WhatsApp,
 * Messenger, and Instagram (all Meta Graph, distinct channels) — and the
 * indirection is real: every per-contact send selects its provider from the
 * contact's channel (see `resolveContactChannel`) and looks it up here, instead
 * of hard-referencing Meta. Adding a designed-for channel (Telegram / SMS /
 * Email) later is:
 *
 *   1. implement `MessagingProvider<TheirConfig>` (a sibling of meta.ts),
 *   2. add a `<channel>-config.ts` with a `get…SendConfig(workspaceId)` loader,
 *   3. register a `ProviderBinding` below and add it to `LIVE_CHANNELS`,
 *   4. add a webhook controller that calls `provider.parseWebhook` and hands
 *      off to the SAME `ingestEvents(workspaceId, provider, events)`.
 *
 * Nothing in ingest, the send orchestration, or business logic changes.
 * See `lib/providers/README.md` for the full recipe.
 */

/**
 * Couples a provider with its config loader so the two never drift apart. The
 * generic `C` is erased to `unknown` at the registry boundary (different
 * providers have different config shapes), but the pairing guarantees the
 * config a binding hands out is exactly what that binding's provider methods
 * accept — sound at runtime because both come from the same binding. Send
 * sites treat the config as opaque (none of them read its fields; verified
 * 2026-05-21), so the erasure costs nothing.
 */
export interface ProviderBinding<C = unknown> {
  provider: MessagingProvider<C>;
  /**
   * Credentials for ONE account.
   *
   * `accountId` names a specific `ChannelConnection`; omitting it falls back to
   * the workspace's default account for this channel (compose-new, and every
   * pre-multi-account caller). `workspaceId` is always required and always in
   * the query's WHERE — an account id alone must never be able to reach across
   * tenants.
   */
  getSendConfig(workspaceId: string, accountId?: string | null): Promise<C>;
}

/**
 * The account a conversation sends from.
 *
 * Throws rather than falling back to "the channel's default account". A wrong
 * account is not a cosmetic bug: WhatsApp thread affinity and the 24h customer
 * service window both belong to the ACCOUNT, so replying from a sibling number
 * breaks the thread and can push a free-form reply outside the window that was
 * opened on the other number (Meta then rejects it, or bills a template).
 * Refusing loudly gives the composer something actionable to show instead.
 */
export class SendAccountUnresolvedError extends Error {
  constructor(readonly conversationId: string) {
    super(
      `Conversation ${conversationId} is not bound to a channel account; ` +
        `refusing to guess which account to send from.`,
    );
    this.name = "SendAccountUnresolvedError";
  }
}

export function resolveSendAccount(conversation: {
  id: string;
  channelConnectionId: string | null;
}): string {
  if (!conversation.channelConnectionId) {
    throw new SendAccountUnresolvedError(conversation.id);
  }
  return conversation.channelConnectionId;
}

/** Thrown when a send is routed to a channel that has no registered provider. */
export class UnsupportedProviderError extends Error {
  readonly provider: string;
  constructor(provider: string) {
    super(`No messaging provider registered for channel "${provider}".`);
    this.name = "UnsupportedProviderError";
    this.provider = provider;
  }
}

/**
 * Thrown when a provider doesn't implement an optional capability the caller
 * needs (e.g. SMS has no `sendInteractive`). Distinct from
 * UnsupportedProviderError — the channel exists, the operation doesn't.
 */
export class UnsupportedProviderOperationError extends Error {
  readonly provider: string;
  readonly operation: string;
  constructor(provider: string, operation: string) {
    super(`Provider "${provider}" does not support "${operation}".`);
    this.name = "UnsupportedProviderOperationError";
    this.provider = provider;
    this.operation = operation;
  }
}

// Partial: a Channel enum value can exist before its provider ships (e.g. a
// migration widens the enum ahead of the provider impl). getProviderBinding
// throws UnsupportedProviderError for any channel not registered here.
const REGISTRY: Partial<Record<Channel, ProviderBinding>> = {
  whatsapp: {
    provider: metaProvider,
    getSendConfig: getMetaSendConfig,
  } as ProviderBinding,
  messenger: {
    provider: messengerProvider,
    getSendConfig: getMessengerSendConfig,
  } as ProviderBinding,
  instagram: {
    provider: instagramProvider,
    getSendConfig: getInstagramSendConfig,
  } as ProviderBinding,
  // First-party website chat widget. Its provider does no vendor I/O — sends are
  // delivered to the visitor's browser by the realtime fanout (see
  // apps/api/src/webchatwidget/). getSendConfig still gates on a connected row so
  // preflight fails with channel_not_connected when the widget isn't set up.
  webchatwidget: {
    provider: webchatwidgetProvider,
    getSendConfig: getWebchatwidgetSendConfig,
  } as ProviderBinding,
};

/**
 * Look up the provider + config loader for a channel. Throws
 * UnsupportedProviderError for an unregistered channel — callers that resolve
 * the channel from a contact row (via `resolveContactChannel`) will only ever
 * pass a value the schema allows, but a stale/forged row shouldn't crash with
 * an undefined-method TypeError.
 */
export function getProviderBinding(provider: Channel): ProviderBinding {
  const binding = REGISTRY[provider];
  if (!binding) throw new UnsupportedProviderError(provider);
  return binding;
}

/**
 * Narrow an optional provider method (sendMedia, sendInteractive, …) to a
 * callable, throwing UnsupportedProviderOperationError when the provider
 * doesn't implement it. Replaces the scattered `provider.sendMedia!(…)`
 * non-null assertions with a typed, channel-aware failure.
 */
export function requireProviderMethod<K extends keyof MessagingProvider>(
  provider: MessagingProvider,
  method: K,
  providerName: Channel,
): NonNullable<MessagingProvider[K]> {
  const fn = provider[method];
  if (!fn) throw new UnsupportedProviderOperationError(providerName, String(method));
  return fn as NonNullable<MessagingProvider[K]>;
}

/**
 * Typed convenience for genuinely Meta-only call sites — the WhatsApp settings
 * surfaces (template catalog sync/create/delete, header-media upload) and the
 * Meta webhook controller (parseWebhook, fetchMedia). These are NOT per-contact
 * sends; they're channel-specific admin ops that legitimately know they're
 * talking to Meta. Per-contact sends must use `getProviderBinding` instead.
 */
export function getMetaProvider(): MessagingProvider<MetaSendConfig> {
  return metaProvider;
}

/**
 * The set of live channels this team can actually SEND on right now — a
 * registered provider AND a loadable send config (a connected `ChannelConnection`
 * with valid creds). A channel with a provider but no/expired connection would
 * otherwise be ranked "best" for a person by `bestChannelForCustomer` and then
 * dropped at send, reaching nobody. Shared by the person-targeting callers
 * (broadcast customer-mode + workflow customer/trigger_customer targets) so the
 * connected-set logic never drifts between them.
 */
export async function teamConnectedChannels(workspaceId: string): Promise<Set<Channel>> {
  // Probe a CONCRETE account per channel, not the workspace-only fallback.
  //
  // "Can we send on this channel?" is a channel-level question, but it can only
  // be answered by loading a real account's credentials — and passing no account
  // means the loader refuses with `account-unresolved` the moment the workspace
  // has two live accounts on that channel. So a workspace with two healthy
  // WhatsApp numbers reported WhatsApp as NOT connected, `bestChannelForCustomer`
  // could never pick it, and a workflow targeting a person failed with "target
  // customer has no reachable channel" while both numbers worked fine.
  //
  // ONE query for every channel rather than one per channel: this runs on a
  // workflow step, and four round-trips to answer "which channels are live"
  // is three more than the question needs. Ordered so the reduce below keeps
  // the DEFAULT account when a channel has several — any loadable account
  // proves the channel is usable, and the default is the least surprising pick.
  const accounts = await db.channelConnection.findMany({
    where: { workspaceId, channel: { in: [...LIVE_CHANNELS] }, isActive: true },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    select: { id: true, channel: true },
  });
  const accountByChannel = new Map<Channel, string>();
  for (const a of accounts) if (!accountByChannel.has(a.channel)) accountByChannel.set(a.channel, a.id);

  const connected = new Set<Channel>();
  await Promise.all(
    [...LIVE_CHANNELS].map(async (ch) => {
      try {
        // `webchatwidget` is first-party and keeps its config outside
        // ChannelConnection, so it legitimately has no row here — its loader
        // takes no account and has no ambiguous fallback to guard against.
        await getProviderBinding(ch).getSendConfig(workspaceId, accountByChannel.get(ch));
        connected.add(ch);
      } catch {
        // Not connected / creds expired — exclude from best-channel resolution.
      }
    }),
  );
  return connected;
}

export type { MessagingProvider } from "@ccp/shared/providers/types";
