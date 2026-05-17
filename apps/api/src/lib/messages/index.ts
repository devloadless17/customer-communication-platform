// Note: no `server-only` import — pulled in by the BullMQ worker which boots
// from server.ts and worker.ts, outside the Next bundler context.

/**
 * `messagesService` — public surface for message persistence primitives.
 *
 * Routes, workflow steps, ingest, and (future) AI service all go through
 * this surface so idempotent-create / dedup / status helpers can evolve
 * without a 50-file caller refactor.
 */

import { createOutboundMessageIdempotent } from "@/lib/messages/idempotent-create";

export const messagesService = {
  createOutboundIdempotent: createOutboundMessageIdempotent,
} as const;

export { createOutboundMessageIdempotent };
