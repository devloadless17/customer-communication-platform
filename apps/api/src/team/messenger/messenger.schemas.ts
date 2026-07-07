import { z } from "zod";

/**
 * POST /api/team/messenger — connect / update the team's Facebook Messenger
 * credentials. Mirrors the WhatsApp connect shape but with Page fields:
 *
 *   pageId          the Facebook Page id the business messages from
 *   pageAccessToken long-lived Page access token (send + read scope)
 *   appSecret       Meta app secret — verifies the inbound webhook HMAC
 *   verifyToken     webhook subscription verify token (optional — the GET
 *                   getConfig pre-mints one if absent)
 *   appId           Meta app id (optional, informational)
 */
export const UpdateMessengerConfigSchema = z.object({
  pageId: z.string().trim().min(1),
  pageAccessToken: z.string().trim().min(1),
  appSecret: z.string().trim().min(1),
  verifyToken: z.string().trim().optional(),
  appId: z.string().trim().optional(),
});
export type UpdateMessengerConfigInput = z.infer<typeof UpdateMessengerConfigSchema>;
