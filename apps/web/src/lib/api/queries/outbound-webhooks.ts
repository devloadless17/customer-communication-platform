import "server-only";



import { api } from "../../api-client";

/**
 * Inline DTOs that the API ships but apps/api defines locally in its
 * service files. Kept here (not in @ccp/shared) because the source-of-truth
 * lives next to the controller; this is just the consumer-side mirror so
 * web pages can name the response shape.
 */
// Outbound webhooks
// ---------------------------------------------------------------------------

export interface OutboundWebhookListItem {
  id: string;
  name: string;
  url: string;
  eventTypes: string[];
  enabled: boolean;
  consecutiveFailures: number;
  createdAt: string;
  lastDeliveredAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  /** Audit trail for auto-disabled subscriptions — null on manual disable. */
  disabledAt: string | null;
  disabledReason: string | null;
}

export async function listOutboundWebhooks(): Promise<OutboundWebhookListItem[]> {
  const { webhooks } = await api<{ webhooks: OutboundWebhookListItem[] }>(
    "/api/workspace/outbound-webhooks",
  );
  return webhooks;
}

// ---------------------------------------------------------------------------
