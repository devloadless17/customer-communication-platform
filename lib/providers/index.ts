import { metaProvider } from "@/lib/providers/meta";
import type { MessagingProvider } from "@/lib/providers/types";
import type { ProviderName } from "@/lib/types";

/**
 * Provider registry. Today there's only one (Meta WhatsApp Cloud), but the
 * indirection stays — when a second channel lands (SMS, Instagram DM,
 * whatever) it plugs in here without touching ingest or routes.
 */
export const providers: Record<ProviderName, MessagingProvider> = {
  meta_cloud: metaProvider,
};

export function getProvider(name: ProviderName): MessagingProvider {
  return providers[name];
}

export type { MessagingProvider } from "@/lib/providers/types";
