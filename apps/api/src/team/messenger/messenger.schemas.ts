import { z } from "zod";

/**
 * POST /api/team/messenger — connect / update the team's Facebook Messenger
 * connection. Only the Page id is required: the App secret, verify token, and
 * access token are sourced from the shared Meta App connection (the Page access
 * token is derived from its system-user token). `pageAccessToken` remains an
 * optional escape hatch to paste a Page token directly.
 *
 *   pageId          the Facebook Page id the business messages from (required)
 *   pageAccessToken optional — overrides the token derived from the Meta App
 *   appSecret       optional — defaults to the Meta App connection's secret
 *   verifyToken     optional — defaults to the Meta App connection's token
 *   appId           optional — informational
 */
export const UpdateMessengerConfigSchema = z.object({
  pageId: z.string().trim().min(1),
  pageAccessToken: z.string().trim().optional(),
  appSecret: z.string().trim().optional(),
  verifyToken: z.string().trim().optional(),
  appId: z.string().trim().optional(),
});
export type UpdateMessengerConfigInput = z.infer<typeof UpdateMessengerConfigSchema>;
