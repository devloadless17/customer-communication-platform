import type { MessageStatus, ProviderName } from "@/lib/types";

/**
 * Provider-agnostic shapes the ingest pipeline consumes.
 *
 * Each `MessagingProvider` is responsible for turning its own webhook payload
 * into one of these. App code never sees Evolution or Meta wire shapes — only
 * NormalizedEvent values. CLAUDE.md rule #1.
 */

export interface NormalizedInboundMessage {
  kind: "message";
  /** Provider-assigned id; the dedupe key. */
  externalId: string;
  /** E.164 digits, no '+'. e.g. "5511999999999". */
  contactPhone: string;
  /** Display name from the provider, if any. We fall back to the phone number. */
  contactName: string | null;
  /** Plain text body. Media-only messages are dropped at the parser for now. */
  body: string;
  timestamp: Date;
  rawPayload: Record<string, unknown>;
}

export interface NormalizedStatusUpdate {
  kind: "status";
  /** externalId of the message whose status is changing. */
  externalId: string;
  status: MessageStatus;
  timestamp: Date;
  rawPayload: Record<string, unknown>;
}

export type NormalizedEvent = NormalizedInboundMessage | NormalizedStatusUpdate;

export interface SendTextArgs {
  /** E.164 digits, no '+'. */
  to: string;
  body: string;
}

export interface SendTextResult {
  externalId: string;
  timestamp: Date;
}

export interface MessagingProvider {
  name: ProviderName;
  /**
   * Pure parser: webhook JSON → normalized events. Throws on malformed input;
   * the route handler decides whether to 200 or 4xx based on the throw.
   * Auth/signature verification is the route's responsibility, not the parser's.
   */
  parseWebhook(payload: unknown): NormalizedEvent[];
  /** Outbound text. Stubbed until we wire real send paths. */
  sendText(args: SendTextArgs): Promise<SendTextResult>;
  /**
   * Acknowledge an inbound message as read on the provider so the customer
   * sees blue ticks. Optional — providers that don't support read receipts
   * (or don't expose them via API) leave this off. Best-effort: a failure
   * here must not break the agent's view, so callers should swallow errors.
   */
  markIncomingRead?(externalId: string): Promise<void>;
}
