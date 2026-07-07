import { z } from "zod";

/**
 * POST /api/team/instagram — connect / update the team's Instagram DM
 * credentials.
 *
 *   igId           the Instagram business account id that messages
 *   igAccessToken  Instagram access token (send + read scope)
 *   appSecret      Meta app secret — verifies the inbound webhook HMAC
 *   verifyToken    webhook subscription verify token (optional — pre-minted)
 *   appId          Meta app id (optional, informational)
 */
export const UpdateInstagramConfigSchema = z.object({
  igId: z.string().trim().min(1),
  igAccessToken: z.string().trim().min(1),
  appSecret: z.string().trim().min(1),
  verifyToken: z.string().trim().optional(),
  appId: z.string().trim().optional(),
});
export type UpdateInstagramConfigInput = z.infer<typeof UpdateInstagramConfigSchema>;
