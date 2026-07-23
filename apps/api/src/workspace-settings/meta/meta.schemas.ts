import { z } from "zod";

/**
 * POST /api/workspace/meta — set/update the team's shared Meta-app credentials, used
 * by every Meta channel (WhatsApp, Messenger, Instagram).
 *
 *   appSecret        Meta app secret — verifies inbound webhook HMAC (all channels)
 *   systemUserToken  the system-user access token; WhatsApp sends with it and
 *                    Messenger/Instagram Page tokens are derived from it
 *   appId            Meta app id (optional, informational)
 *   verifyToken      webhook verify token (optional — getConfig pre-mints one)
 */
export const UpdateMetaConnectionSchema = z.object({
  appSecret: z.string().trim().min(1),
  systemUserToken: z.string().trim().min(1),
  appId: z.string().trim().optional(),
  verifyToken: z.string().trim().optional(),
});
export type UpdateMetaConnectionInput = z.infer<typeof UpdateMetaConnectionSchema>;
