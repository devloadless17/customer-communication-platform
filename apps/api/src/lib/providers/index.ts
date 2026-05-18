import type { MetaSendConfig } from "@/lib/providers/config";
import { metaProvider } from "@/lib/providers/meta";
import type { MessagingProvider } from "@ccp/shared/providers/types";

/**
 * Provider registry. Today there's only one (Meta WhatsApp Cloud), but the
 * indirection stays — when a second channel lands (SMS, Instagram DM,
 * whatever) it plugs in here without touching ingest or routes.
 *
 * Typed lookups keep the per-provider config shape attached: callers of
 * `getMetaProvider()` get a provider whose `sendText` already knows it
 * needs a MetaSendConfig.
 */
export function getMetaProvider(): MessagingProvider<MetaSendConfig> {
  return metaProvider;
}

export type { MessagingProvider } from "@ccp/shared/providers/types";
