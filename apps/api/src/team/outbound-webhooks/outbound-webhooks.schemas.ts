import { z } from "zod";

import { PUBLIC_EVENT_TYPES } from "@ccp/shared/outbound-webhooks/public-events";

const URL_MAX = 2048;
const NAME_MAX = 80;

/**
 * URL accepted on create/update. The schema allows http OR https syntactically;
 * the SERVICE then rejects plain http in production (only allowed behind the
 * INTEGRATIONS_ALLOW_PRIVATE_HOSTS=1 dev escape hatch, so a developer can point
 * the webhook at a local receiver). Receiver-side IP / SSRF guarding lives in
 * the worker (private-IP blocklist, host header sanity).
 */
const WebhookUrlSchema = z
  .string()
  .trim()
  .url({ message: "url must be a valid absolute URL" })
  .max(URL_MAX)
  .refine((u) => u.startsWith("http://") || u.startsWith("https://"), {
    message: "url must be http or https",
  });

const PublicEventEnum = z.enum(PUBLIC_EVENT_TYPES);

export const CreateOutboundWebhookSchema = z.object({
  name: z.string().trim().min(1).max(NAME_MAX),
  url: WebhookUrlSchema,
  eventTypes: z.array(PublicEventEnum).min(1).max(PUBLIC_EVENT_TYPES.length),
  enabled: z.boolean().optional().default(true),
});
export type CreateOutboundWebhookInput = z.infer<typeof CreateOutboundWebhookSchema>;

export const UpdateOutboundWebhookSchema = z
  .object({
    name: z.string().trim().min(1).max(NAME_MAX).optional(),
    url: WebhookUrlSchema.optional(),
    eventTypes: z.array(PublicEventEnum).min(1).max(PUBLIC_EVENT_TYPES.length).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to update" });
export type UpdateOutboundWebhookInput = z.infer<typeof UpdateOutboundWebhookSchema>;

export const ListDeliveriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});
export type ListDeliveriesQueryInput = z.infer<typeof ListDeliveriesQuerySchema>;
