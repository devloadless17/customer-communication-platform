import { z } from "zod";

import { INBOX_SOURCES } from "@ccp/shared/providers/capabilities";

/**
 * POST /api/workspace/instagram — connect / update the team's Instagram DM
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

/**
 * PUT /api/workspace/instagram/entry-points — the ice breakers + persistent menu
 * a customer sees before typing.
 *
 * Caps are Meta's, enforced here so an over-long set fails with a field-level 400
 * instead of an opaque Graph error: "Maximum questions: 4 per configuration" for
 * ice breakers, and "limit to 5 for optimal user experience" for the menu. Only
 * `web_url` and `postback` menu items are supported ("Specifies the item is a URL
 * button" / "a postback button") — no `phone_number`, no nested submenus, and
 * `composer_input_disabled` / `webview_height_ratio` are explicitly unavailable
 * on Instagram, so they are not modelled at all.
 *
 * `accountId` targets one connected Instagram account; omitted = the default.
 * Entry points are per-ACCOUNT (they live on that handle's linked Page), so a
 * workspace running two handles configures each separately.
 */
const IceBreakerSchema = z.object({
  question: z.string().trim().min(1).max(80),
  payload: z.string().trim().min(1).max(1000),
});

const MenuItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("web_url"),
    title: z.string().trim().min(1).max(30),
    url: z.string().trim().url().max(2000).regex(/^https?:\/\//i, "must be http(s)"),
  }),
  z.object({
    type: z.literal("postback"),
    title: z.string().trim().min(1).max(30),
    payload: z.string().trim().min(1).max(1000),
  }),
]);

export const UpdateEntryPointsSchema = z.object({
  accountId: z.string().trim().min(1).optional(),
  iceBreakers: z.array(IceBreakerSchema).max(4).default([]),
  menuItems: z.array(MenuItemSchema).max(5).default([]),
});
export type UpdateEntryPointsInput = z.infer<typeof UpdateEntryPointsSchema>;

/**
 * POST /api/workspace/instagram/inbox-sources — which NON-DM sources this
 * account lets into the inbox.
 *
 * Direct messages are the core and are not listed: they ARE the inbox and are
 * never gated. This is the switch for everything else, and it defaults to none.
 *
 * Its own tiny route rather than a field on the credential form: an admin
 * flipping a preference must not have to re-enter a Page id. Per ACCOUNT, because
 * a workspace can reasonably want comments on its support handle and not on its
 * brand handle.
 */
export const UpdateInboxSourcesSchema = z.object({
  accountId: z.string().trim().min(1).optional(),
  /** The full desired set — absent members are turned OFF. */
  sources: z.array(z.enum(INBOX_SOURCES)).default([]),
});
export type UpdateInboxSourcesInput = z.infer<typeof UpdateInboxSourcesSchema>;
