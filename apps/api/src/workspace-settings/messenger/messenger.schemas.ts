import { z } from "zod";

/**
 * POST /api/workspace/messenger — connect / update the team's Facebook Messenger
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

/**
 * POST /api/workspace/messenger/entry-points — ice breakers + persistent menu.
 *
 * Identical caps to the Instagram twin (`Maximum questions: 4`, menu "limit to
 * 5"), because it is literally the same `messenger_profile` node. Messenger DOES
 * additionally support `phone_number` menu items and nested submenus, which are
 * deliberately not modelled: a nested menu is a tree editor's worth of UI for a
 * feature nobody has asked for, and modelling it later is additive.
 *
 * `accountId` targets one connected Page; omitted = the default. These live on
 * the Page, so a workspace running two Pages configures each separately.
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

export const UpdateMessengerEntryPointsSchema = z.object({
  accountId: z.string().trim().min(1).optional(),
  iceBreakers: z.array(IceBreakerSchema).max(4).default([]),
  menuItems: z.array(MenuItemSchema).max(5).default([]),
});
export type UpdateMessengerEntryPointsInput = z.infer<typeof UpdateMessengerEntryPointsSchema>;

/**
 * POST /api/workspace/messenger/welcome — the Get Started button, greeting and
 * commands menu. MESSENGER-ONLY (Instagram's profile node rejects all three).
 *
 * Caps are Meta's: greeting 160 characters, at most 10 commands, command name 32
 * and description 64. A command `name` is what the customer types after `/`, so
 * it is restricted to the characters Meta accepts there rather than free text —
 * a name with a space is rejected by Graph with an opaque error.
 *
 * `getStartedPayload` null/empty REMOVES the button. That is a real customer-
 * visible state, not a no-op: without it a first-time visitor sees an empty
 * composer and the greeting has nothing to render on.
 */
const CommandSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9_-]+$/i, "letters, digits, hyphen and underscore only"),
  description: z.string().trim().min(1).max(64),
});

export const UpdateMessengerWelcomeSchema = z.object({
  accountId: z.string().trim().min(1).optional(),
  getStartedPayload: z.string().trim().max(1000).nullable().default(null),
  greeting: z.string().trim().max(160).nullable().default(null),
  commands: z.array(CommandSchema).max(10).default([]),
});
export type UpdateMessengerWelcomeInput = z.infer<typeof UpdateMessengerWelcomeSchema>;

/**
 * GET /api/workspace/messenger/stickers — browse or search the first-party
 * sticker catalog. `packId` lists one pack; `q` searches across all of them;
 * neither lists the packs themselves.
 *
 * `locale` is forwarded to Meta and matters more than it looks: without it the
 * search defaults to `en_US` and matches only English tags, so a non-English
 * query returns an empty list rather than an error.
 */
export const StickerCatalogQuerySchema = z.object({
  packId: z.string().trim().min(1).optional(),
  q: z.string().trim().min(2).max(100).optional(),
  locale: z
    .string()
    .trim()
    .regex(/^[a-z]{2}_[A-Z]{2}$/, "expected a locale like en_US")
    .optional(),
});
export type StickerCatalogQuery = z.infer<typeof StickerCatalogQuerySchema>;

/**
 * POST /api/workspace/messenger/thread-control — Handover Protocol.
 *
 * `psid` is the customer whose conversation is being handed over. `action` is
 * Meta's four verbs; only `pass` takes a `targetAppId`, and omitting it hands the
 * thread to Meta's own Page Inbox (the documented constant 263902037430900),
 * which is what "give this back to Business Suite" means.
 *
 * `metadata` is echoed to EVERY app on the Page in the handover webhook, so it is
 * capped and must never be used to carry anything private — it is the one field
 * here that leaves our tenancy boundary.
 */
export const ThreadControlSchema = z.object({
  accountId: z.string().trim().min(1).optional(),
  psid: z.string().trim().min(1),
  action: z.enum(["take", "request", "pass", "release"]),
  targetAppId: z.string().trim().min(1).optional(),
  metadata: z.string().trim().max(1000).optional(),
});
export type ThreadControlInput = z.infer<typeof ThreadControlSchema>;

/**
 * POST /api/workspace/messenger/personas — create a named voice.
 *
 * `name` is capped at Meta's 50 characters. `profilePictureUrl` must be publicly
 * reachable AT CREATE TIME: Meta downloads the image and re-hosts it, so the URL
 * may rot afterwards without consequence but a private URL fails the create.
 */
export const CreatePersonaSchema = z.object({
  accountId: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).max(50),
  profilePictureUrl: z
    .string()
    .trim()
    .url()
    .regex(/^https:\/\//i, "must be https"),
});
export type CreatePersonaInput = z.infer<typeof CreatePersonaSchema>;
