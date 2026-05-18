// Note: no `server-only` import — pulled in by the BullMQ worker which boots
// from server.ts and worker.ts, outside the Next bundler context.

/**
 * `messagingService` — public surface of the messaging domain.
 *
 * Named home for outbound-send primitives. Routes, workflow steps, and the
 * (future) NestJS service all call `messagingService.X` instead of importing
 * the underlying `*-internal.ts` file directly. Adding a new outbound
 * channel (media send, reaction send) = add a method here + an internal
 * file. No caller refactor.
 */

import {
  sendTextInternal,
  SendTextValidationError,
} from "@/lib/messaging/send-text-internal";
import {
  sendTemplateInternal,
  SendTemplateValidationError,
} from "@/lib/messaging/send-template-internal";

export { SendTextValidationError, SendTemplateValidationError };
export type {
  SendTextInternalArgs as SendTextArgs,
  SendTextInternalResult as SendTextResult,
} from "@/lib/messaging/send-text-internal";
export type {
  SendTemplateInternalArgs as SendTemplateArgs,
  SendTemplateInternalResult as SendTemplateResult,
} from "@/lib/messaging/send-template-internal";

export const messagingService = {
  sendText: sendTextInternal,
  sendTemplate: sendTemplateInternal,
} as const;
