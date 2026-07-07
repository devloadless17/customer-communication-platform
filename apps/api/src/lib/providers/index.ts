import { getMetaSendConfig, type MetaSendConfig } from "@/lib/providers/config";
import { metaProvider } from "@/lib/providers/meta";
import { messengerProvider } from "@/lib/providers/messenger";
import { getMessengerSendConfig } from "@/lib/providers/messenger-config";
import { instagramProvider } from "@/lib/providers/instagram";
import { getInstagramSendConfig } from "@/lib/providers/instagram-config";
import type { Channel } from "@ccp/shared/types";
import type { MessagingProvider } from "@ccp/shared/providers/types";

/**
 * Provider registry. Today there's only one channel (Meta WhatsApp Cloud), but
 * the indirection is real: every per-contact send selects its provider from the
 * contact's channel (see `resolveContactChannel`) and looks it up here, instead
 * of hard-referencing Meta. Adding Instagram DM / Telegram / SMS later is:
 *
 *   1. implement `MessagingProvider<TheirConfig>` (a sibling of meta.ts),
 *   2. add a `<channel>-config.ts` with a `get…SendConfig(teamId)` loader,
 *   3. register a `ProviderBinding` below,
 *   4. add a webhook controller that calls `provider.parseWebhook` and hands
 *      off to the SAME `ingestEvents(teamId, provider, events)`.
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
  getSendConfig(teamId: string): Promise<C>;
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

export type { MessagingProvider } from "@ccp/shared/providers/types";
