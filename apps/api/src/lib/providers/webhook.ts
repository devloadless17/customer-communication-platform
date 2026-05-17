import "server-only";

import type { ProviderName } from "@prisma/client";

import type { NormalizedEvent } from "@ccp/shared/providers/types";

/**
 * Per-provider webhook adapter — the OTHER half of MessagingProvider, sliced
 * off because the verify+parse pipeline is meaningfully different from the
 * send pipeline and benefits from its own contract.
 *
 * Concerns kept on this interface:
 *   - GET handshake: providers that subscribe via dashboard hand-shake
 *     (Meta's `hub.challenge`) implement {@link verifyChallenge}; others
 *     leave it off (Telegram, generic incoming webhooks).
 *   - POST authentication: signature check on the RAW request body. Each
 *     provider knows its own scheme — Meta uses HMAC-SHA256 in
 *     `X-Hub-Signature-256`, Telegram echoes the bot token in the URL path,
 *     Instagram shares Meta's scheme with a different header name.
 *   - Parse: bytes → normalized events. Pure; shared ingest does the rest.
 *
 * Wiring: `/api/webhooks/[provider]/[teamId]/route.ts` is the dispatcher.
 * It looks up the provider by URL segment, fetches the team's secrets
 * (lib/providers/config.ts), runs verify, runs parse, then hands off to
 * `ingestEvents`. Adding Instagram = drop a new WebhookProvider in this
 * file and an entry in the registry — no route changes.
 */

export interface WebhookProvider {
  name: ProviderName;

  /**
   * Handle the provider's subscription challenge (Meta GET dance with
   * `hub.mode=subscribe` + verify token). Returns the challenge body to
   * echo back, or null if the challenge is invalid for this team / provider
   * (the route returns 403 in that case). Providers without a GET dance
   * omit this method; the dispatcher 405s on GET.
   */
  verifyChallenge?(args: {
    url: URL;
    secrets: ProviderWebhookSecrets;
  }): string | null;

  /**
   * Authenticate a POST. `rawBody` is the EXACT bytes the provider signed
   * (don't re-serialize JSON). Returns true if the signature checks out.
   * Each provider knows where the signature lives (header / query) and what
   * scheme it uses. Constant-time compares are the implementer's
   * responsibility.
   */
  verifyPost(args: {
    rawBody: string;
    headers: Headers;
    secrets: ProviderWebhookSecrets;
  }): boolean;

  /**
   * Pure parser: JSON-parsed payload → normalized events. Same shape used
   * by the `MessagingProvider.parseWebhook` half; kept identical so the
   * ingest pipeline stays one path.
   */
  parse(payload: unknown): NormalizedEvent[];
}

/**
 * Bag of secrets each provider needs to verify+parse. Today only one
 * implementation (Meta) populates it; future providers add their own keys.
 * Loaded by the dispatcher from `lib/providers/config.ts` per teamId.
 */
export interface ProviderWebhookSecrets {
  /** Meta: HMAC secret signed into X-Hub-Signature-256. */
  appSecret?: string;
  /** Meta: subscription verify token, echoed in the GET challenge. */
  verifyToken?: string;
  /** Telegram (future): bot token segment in the URL. */
  telegramBotToken?: string;
}

const registry = new Map<ProviderName, WebhookProvider>();

/** Register a webhook adapter. Call this from the provider's own module. */
export function registerWebhookProvider(provider: WebhookProvider): void {
  registry.set(provider.name, provider);
}

/** Look up a registered adapter by provider name (URL segment). */
export function getWebhookProvider(name: string): WebhookProvider | null {
  return registry.get(name as ProviderName) ?? null;
}
