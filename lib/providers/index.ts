import type { MetaSendConfig } from "@/lib/providers/config";
import { metaProvider, metaWebhookProvider } from "@/lib/providers/meta";
import type { MessagingProvider } from "@/lib/providers/types";
import { registerWebhookProvider } from "@/lib/providers/webhook";

// Side-effect registration. The webhook dispatcher route looks providers up
// by URL segment via getWebhookProvider("meta_cloud" | …); they must be in
// the registry before the route handler runs, so we register on module
// load. Importing `getMetaProvider` from anywhere pulls this file in early
// (the index re-exports from lib/providers/meta which side-effects too).
registerWebhookProvider(metaWebhookProvider);

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

export type { MessagingProvider } from "@/lib/providers/types";
