/**
 * `conversationsService` — public surface of the conversations domain.
 *
 * Wraps the analytics tracking helpers (firstResponseAt / closedAt /
 * counters) under a single named import. Routes / subscribers call
 * `conversationsService.trackOnAssigned(...)` instead of the underlying
 * `lib/conversations/analytics.ts` directly so analytics calls stand out
 * in greps and the future NestJS module can re-export from one place.
 */

import {
  trackOnAssigned,
  trackOnStatusChanged,
  trackOnOutboundMessage,
} from "@/lib/conversations/analytics";

export const conversationsService = {
  trackOnAssigned,
  trackOnStatusChanged,
  trackOnOutboundMessage,
} as const;

export { trackOnAssigned, trackOnStatusChanged, trackOnOutboundMessage };
