import { z } from "zod";

/**
 * POST /api/team/instagram — connect / update the team's Instagram DM
 * credentials.
 *
 * Instagram DMs run on the SAME rail as WhatsApp + Messenger: the Instagram
 * Graph API over `graph.facebook.com`, via a Business/Creator account **linked
 * to a Facebook Page** (Facebook-Login path). So onboarding takes the *Page* id
 * and derives the canonical Instagram business-account id from it — the admin
 * never pastes a raw Instagram id, which is exactly how a mismatched
 * Instagram-Login id (graph.instagram.com namespace) used to slip in.
 *
 *   pageId         the Facebook Page the Instagram account is linked to
 *   igAccessToken  Instagram/Page access token (send + read scope)
 *   appSecret      Meta app secret — verifies the inbound webhook HMAC
 *   verifyToken    webhook subscription verify token (optional — pre-minted)
 *   appId          Meta app id (optional, informational)
 */
export const UpdateInstagramConfigSchema = z.object({
  pageId: z.string().trim().min(1),
  // Optional — sourced from the shared Meta App connection when omitted (the
  // Page access token is derived from its system-user token). A pasted token
  // still overrides.
  igAccessToken: z.string().trim().optional(),
  appSecret: z.string().trim().optional(),
  verifyToken: z.string().trim().optional(),
  appId: z.string().trim().optional(),
});
export type UpdateInstagramConfigInput = z.infer<typeof UpdateInstagramConfigSchema>;
