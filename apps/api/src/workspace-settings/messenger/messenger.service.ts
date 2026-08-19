import { randomBytes } from "node:crypto";

import { Prisma } from "@prisma/client";
import { BadGatewayException, BadRequestException, Injectable, Logger } from "@nestjs/common";

import { decryptSecret, encryptSecret } from "@/lib/crypto/envelope";
import { withAppsecretProof } from "@/lib/providers/appsecret-proof";
import { invalidateMessengerConfig } from "@/lib/providers/messenger-config";
import { normalizeDefaultAccount } from "@/lib/providers/normalize-default-account";
import {
  ensurePageSubscribedToMessaging,
  getPageSubscription,
  releasePageSubscription,
} from "@/lib/providers/meta-page-subscription";
import { recentWebhookRejection } from "@/lib/providers/channel-health";
import { getMetaConnection } from "@/lib/providers/meta-connection";
import { assertChannelDisconnectConfirmed } from "@/lib/providers/assert-channel-disconnect";
import {
  enqueuePendingRelease,
  resolvePendingRelease,
} from "@/lib/sweepers/subscription-release-retry";
import { scrubViewReferences } from "@/lib/inbox-views/scrub";

import {
  blocksMessaging,
  getPageIntegrity,
  messagingRestrictionExpiry,
} from "@/lib/providers/messenger-integrity";
import { ProviderNotConfiguredError } from "@/lib/providers/config";
import { getMessengerSendConfig, type MessengerSendConfig } from "@/lib/providers/messenger-config";
import { messengerProvider } from "@/lib/providers/messenger";
import { messengerBroadcastReach } from "@/lib/providers/messenger-broadcast-reach";
import {
  listStickerPacks,
  listStickersInPack,
  searchStickers,
  type MessengerSticker,
  type MessengerStickerPack,
} from "@/lib/providers/messenger-stickers";
import type {
  ChannelEntryPoints,
  ChannelPersona,
  ChannelWelcomeScreen,
} from "@ccp/shared/providers/types";
import { SECRET_SAVED_SENTINEL } from "@ccp/shared/dtos";

import { EventBus } from "../../events/event-bus.module";
import { DbService } from "../../db/db.service";
import type {
  StickerCatalogQuery,
  UpdateMessengerConfigInput,
  UpdateMessengerEntryPointsInput,
  UpdateMessengerWelcomeInput,
  ThreadControlInput,
  CreatePersonaInput,
} from "./messenger.schemas";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v26.0";
const GRAPH_BASE = process.env.META_GRAPH_BASE_URL || "https://graph.facebook.com";
const CHANNEL = "messenger" as const;

/** Shape of `ChannelConnection.config` (non-secret) for Messenger. */
interface MessengerChannelConfig {
  pageId?: string;
  pageName?: string;
  appId?: string;
  verifyToken?: string;
}
/** Shape of `ChannelConnection.secrets` — envelope-encrypted ciphertext per field. */
interface MessengerChannelSecrets {
  pageAccessToken?: string;
  appSecret?: string;
}

/** Server→browser view for the admin connect form (never client→server). */
export interface MessengerConfigView {
  pageId: string | null;
  pageName: string | null;
  appId: string | null;
  verifyToken: string | null;
  /** `SECRET_SAVED_SENTINEL` when a value is stored (and decryptable), else
   *  null — never the plaintext. Submitting the sentinel back keeps the stored
   *  value. */
  pageAccessToken: string | null;
  appSecret: string | null;
  /** True when the corresponding secret is stored and decryptable. */
  pageAccessTokenSet: boolean;
  appSecretSet: boolean;
  /** True when secrets exist but decrypt failed (key rotated / corrupt). */
  credentialsUndecryptable: boolean;
  /** True when a send failed with Graph 190 — the token expired/was revoked and
   *  the channel must be reconnected. Drives the Settings "reconnect" banner. */
  needsReconnect: boolean;
  /** Inbound webhooks we 403'd within the last 24h (bad_signature / no_config)
   *  — see WhatsappConfigView.webhookRejection; same shape, same 24h filter. */
  webhookRejection: { at: string; reason: string } | null;
  /**
   * Live Page↔app webhook subscription, read from Graph. `null` when we can't
   * check (not connected yet, or Graph unreachable). When `receivesMessages` is
   * false the channel is "connected" but Meta will never deliver a single
   * inbound message — the settings page must say so loudly.
   */
  webhookSubscription: {
    receivesMessages: boolean;
    subscribedFields: string[];
    missingFields: string[];
  } | null;
  /**
   * Live Page integrity (`GET /{page-id}/page_status`). `null` when we can't
   * check — needs `pages_manage_metadata`, and MANY installs won't have granted
   * it, so an unreadable status is genuinely "unknown". It is deliberately NOT
   * reported as healthy: claiming a Page is fine because we couldn't ask is the
   * cry-wolf mistake in reverse, and this is the one signal that explains why
   * every send is about to start failing.
   */
  integrity: {
    status: string | null;
    /** True when a `page_messaging`/`page_messaging_api` restriction is active. */
    blocksMessaging: boolean;
    /** ISO — when the messaging restriction lifts. Null = none, or indefinite. */
    restrictedUntil: string | null;
    violations: { type: string; description: string | null; url: string | null }[];
    restrictions: { feature: string; description: string | null; expiresAt: string | null }[];
    /** Meta's own next steps, including the appeal link. We can't author these. */
    recommendedActions: { actionType: string; url: string | null }[];
    appeals: { type: string; status: string }[];
  } | null;
}

function pruneUndefined<T extends object>(o: T): T {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as T;
}

/**
 * Facebook Messenger connection settings — admin-only. Same credential model as
 * WhatsApp (a `ChannelConnection` row keyed (workspaceId, "messenger"); `config`
 * non-secret, `secrets` envelope-encrypted) but with Page fields instead of
 * phone/WABA. Kept as its own module so the stable WhatsApp onboarding is
 * untouched.
 */
@Injectable()
export class MessengerService {
  private readonly logger = new Logger(MessengerService.name);
  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

  private tryDecrypt(cipher: string | null, label: string): string | null {
    if (cipher == null) return null;
    try {
      return decryptSecret(cipher);
    } catch (err) {
      this.logger.warn(
        `could not decrypt messenger ${label}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Current config for the admin connect form.
   *
   * Secrets are decrypted here only to PROBE (the live subscription + integrity
   * reads below) and to compute the Set/undecryptable flags — the response
   * carries `SECRET_SAVED_SENTINEL` in their place, never the plaintext, so the
   * long-lived Page token + App secret are not readable from every admin's
   * devtools. `updateConfig` reads the sentinel as "keep the stored value".
   */
  async getConfig(workspaceId: string): Promise<MessengerConfigView> {
    const conn = await this.db.channelConnection.findFirst({
      where: { workspaceId, channel: CHANNEL, isDefault: true },
      select: {
        config: true,
        secrets: true,
        needsReconnect: true,
        lastWebhookRejectedAt: true,
        lastWebhookRejectReason: true,
      },
    });
    const config = (conn?.config ?? {}) as MessengerChannelConfig;
    const secrets = (conn?.secrets ?? {}) as MessengerChannelSecrets;

    const pageAccessToken = this.tryDecrypt(secrets.pageAccessToken ?? null, "pageAccessToken");
    const appSecret = this.tryDecrypt(secrets.appSecret ?? null, "appSecret");
    const credentialsUndecryptable =
      (secrets.pageAccessToken != null && pageAccessToken === null) ||
      (secrets.appSecret != null && appSecret === null);

    // Pre-mint a verify token on first read so the onboarding UI can show
    // "paste this into Meta" before any credentials are saved. Row created
    // inactive; updateConfig flips isActive. Same posture as WhatsApp.
    let verifyToken = config.verifyToken ?? null;
    if (verifyToken == null) {
      const minted = randomBytes(24).toString("hex");
      try {
        const mergedConfig = pruneUndefined({ ...config, verifyToken: minted });
        await this.db.channelConnection.upsert({
          where: {
            workspaceId_channel_externalAccountId: {
              workspaceId,
              channel: CHANNEL,
              externalAccountId: config.pageId ?? "",
            },
          },
          create: {
            workspaceId,
            channel: CHANNEL,
            externalAccountId: config.pageId ?? "",
            isDefault: true,
            config: mergedConfig as Prisma.InputJsonValue,
            secrets: {},
            isActive: false,
          },
          update: { config: mergedConfig as Prisma.InputJsonValue },
        });
        verifyToken = minted;
      } catch (err) {
        this.logger.warn(
          `could not pre-mint messenger verify token: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Best-effort webhook health. A Page can be "connected" with perfect
    // credentials and still receive nothing, because Meta only delivers to Pages
    // subscribed to the app for `messages` — and a re-save in Meta's dashboard
    // silently resets that set. Read the truth from Graph so the settings page
    // can say it out loud. Never fatal: a Graph blip must not break the page.
    let webhookSubscription: MessengerConfigView["webhookSubscription"] = null;
    if (config.pageId && pageAccessToken) {
      try {
        const status = await getPageSubscription(
          config.pageId,
          pageAccessToken,
          GRAPH_VERSION,
          config.appId,
          appSecret ?? undefined,
        );
        webhookSubscription = {
          receivesMessages: status.receivesMessages,
          subscribedFields: status.subscribedFields,
          missingFields: status.missingFields,
        };
      } catch (err) {
        this.logger.warn(
          `[${workspaceId}] could not read messenger page subscription: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Page integrity, read live for the same reason the subscription above is:
    // it changes on Meta's side without telling our database, and a cached copy
    // would keep saying "healthy" through an enforcement. Never fatal — a Graph
    // blip or a missing `pages_manage_metadata` leaves it null (= unknown).
    let integrity: MessengerConfigView["integrity"] = null;
    if (config.pageId && pageAccessToken) {
      try {
        const snapshot = await getPageIntegrity({
          accountId: config.pageId,
          accessToken: pageAccessToken,
          graphVersion: GRAPH_VERSION,
          label: CHANNEL,
          ...(appSecret ? { appSecret } : {}),
        });
        integrity = {
          status: snapshot.status,
          blocksMessaging: blocksMessaging(snapshot),
          restrictedUntil: messagingRestrictionExpiry(snapshot),
          violations: snapshot.violations.map((v) => ({
            type: v.type,
            description: v.description,
            url: v.url,
          })),
          restrictions: snapshot.restrictions.map((r) => ({
            feature: r.feature,
            description: r.description,
            expiresAt: r.expiresAt,
          })),
          recommendedActions: snapshot.recommendedActions.map((a) => ({
            actionType: a.actionType,
            url: a.url,
          })),
          appeals: snapshot.appeals.map((a) => ({ type: a.type, status: a.status })),
        };
      } catch (err) {
        this.logger.warn(
          `[${workspaceId}] could not read messenger page integrity: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return {
      pageId: config.pageId ?? null,
      pageName: config.pageName ?? null,
      appId: config.appId ?? null,
      verifyToken,
      pageAccessToken: pageAccessToken !== null ? SECRET_SAVED_SENTINEL : null,
      appSecret: appSecret !== null ? SECRET_SAVED_SENTINEL : null,
      pageAccessTokenSet: pageAccessToken !== null,
      appSecretSet: appSecret !== null,
      credentialsUndecryptable,
      needsReconnect: conn?.needsReconnect ?? false,
      webhookRejection: recentWebhookRejection(
        conn?.lastWebhookRejectedAt ?? null,
        conn?.lastWebhookRejectReason ?? null,
      ),
      webhookSubscription,
      integrity,
    };
  }

  async updateConfig(
    workspaceId: string,
    input: UpdateMessengerConfigInput,
  ): Promise<{ config: { pageId: string; pageName: string | null; verifyToken: string } }> {
    const { pageId } = input;

    // getConfig ships SECRET_SAVED_SENTINEL in place of stored plaintext, so an
    // untouched form can echo it back. Treat it as "not typed" — the precedence
    // below then keeps this row's own stored secret and re-derives its Page
    // token, exactly as a blank field does. Never let it reach `encryptSecret`.
    const typedPageAccessToken =
      input.pageAccessToken === SECRET_SAVED_SENTINEL ? undefined : input.pageAccessToken;
    const typedAppSecret =
      input.appSecret === SECRET_SAVED_SENTINEL ? undefined : input.appSecret;

    // Source the app-level credentials from the shared Meta App connection,
    // unless the admin overrode them on this form. The Page access token is
    // derived below from whichever token we resolve here.
    const meta = await getMetaConnection(workspaceId);
    // Precedence: operator input → THIS ROW'S OWN stored secret → the shared Meta
    // App. The middle term protects an account deliberately living on a DIFFERENT
    // Meta app: the webhook HMAC check already tries every account's own secret for
    // that reason, and without this any re-save silently replaced it with the shared
    // app's — after which Meta signs that account's webhooks with a secret we no
    // longer hold and every inbound is dropped as forged.
    const ownSecrets = ((
      await this.db.channelConnection.findUnique({
        where: {
          workspaceId_channel_externalAccountId: {
            workspaceId,
            channel: CHANNEL,
            externalAccountId: pageId ?? "",
          },
        },
        select: { secrets: true },
      })
    )?.secrets ?? {}) as MessengerChannelSecrets;
    const ownAppSecret = this.tryDecrypt(ownSecrets.appSecret ?? null, "appSecret");
    const appSecret = typedAppSecret?.trim() || ownAppSecret || meta?.appSecret || null;
    // The row's own stored Page token — used ONLY at store time (below) to keep
    // an own-app row's coherent token/secret pair. It must NOT join the
    // sourceToken chain: a stored Page token cannot derive a fresh Page token
    // or read Page metadata the way a user/system-user token can, and putting
    // it first broke the advertised reconnect path (hit Save after a Graph 190
    // and the stale revoked token won over the freshly rotated shared token).
    const ownPageToken = this.tryDecrypt(ownSecrets.pageAccessToken ?? null, "pageAccessToken");
    const sourceToken = typedPageAccessToken?.trim() || meta?.systemUserToken || null;
    const appId = input.appId?.trim() || meta?.appId || undefined;
    if (!appSecret || !sourceToken) {
      throw new BadRequestException({
        error: "meta_not_configured",
        detail:
          "Set up your Meta App connection first (Settings → Meta App: App secret + system-user token), then connect the channel.",
      });
    }

    // Validate the Page + token against Graph before persisting, so a typo
    // surfaces here instead of silently failing every send later. We ALSO ask
    // for `access_token`: Meta's "New Pages Experience" rejects user /
    // system-user tokens on Page-scoped calls (send, subscribe, profile) with
    // "A Page access token is required", so we derive the Page-scoped token
    // here and store THAT — the shared system-user token is fine and outbound
    // still works. This mirrors the Embedded-Signup user→Page token exchange.
    let pageName: string | undefined;
    let derivedPageToken: string | undefined;
    try {
      // Signed with `appsecret_proof`, paired BY THE TOKEN'S TIER (same ladder
      // as instagram.service): a typed token signs only with a typed secret,
      // the shared token with the shared secret. NOT the fully-resolved
      // `appSecret` — that chain includes the row's OWN secret, and signing the
      // shared token with an own-app secret is a wrong proof Meta rejects even
      // when none is required, failing every own-app re-save probe.
      const probeProofSecret = typedPageAccessToken?.trim()
        ? typedAppSecret?.trim() || undefined
        : (meta?.appSecret ?? undefined);
      const res = await fetch(
        withAppsecretProof(
          `${GRAPH_BASE}/${GRAPH_VERSION}/${encodeURIComponent(pageId)}?fields=name,access_token`,
          sourceToken,
          probeProofSecret,
        ),
        {
          headers: { authorization: `Bearer ${sourceToken}` },
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!res.ok) {
        const body = await res.text();
        throw new BadRequestException({
          error: "messenger_validation_failed",
          detail: body.slice(0, 300),
        });
      }
      const data = (await res.json()) as { name?: string; access_token?: string };
      pageName = typeof data.name === "string" ? data.name : undefined;
      derivedPageToken =
        typeof data.access_token === "string" && data.access_token.length > 0
          ? data.access_token
          : undefined;
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadGatewayException({
        error: "messenger_validation_unreachable",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    // Prefer the derived Page token. If Graph didn't return one AND the admin
    // didn't paste a Page token, the only thing left is the shared system-user
    // token — which the New Pages Experience rejects on every send. Storing it
    // would mark the channel "connected" but leave it permanently unsendable, so
    // fail loudly at connect instead of silently later.
    if (!derivedPageToken && !typedPageAccessToken?.trim()) {
      throw new BadRequestException({
        error: "page_token_derivation_failed",
        detail:
          "Couldn't get a Page access token for this Page from your Meta App system-user token. Assign the system user to this Page (Business Settings → Pages → Add People) with a messaging task, or paste a Page access token directly.",
      });
    }
    // STORE-time pair coherence: a Page living on its OWN Meta app, re-saved
    // without a typed token, must keep its stored token — the freshly derived
    // one was issued via the SHARED app's system-user token, and persisting it
    // beside the row's own appSecret is the app-A-token/app-B-secret mis-pair
    // that mis-signs every later Graph call and webhook check. The derivation
    // above still ran (it validates the Page + refreshes pageName); only the
    // persisted credential is pinned. An operator deliberately moving the Page
    // between apps signals it by pasting a token (or the matching secret).
    const ownAppRow = Boolean(
      ownAppSecret && meta?.appSecret && ownAppSecret !== meta.appSecret,
    );
    const tokenToStore =
      !typedPageAccessToken?.trim() && ownAppRow && ownPageToken
        ? ownPageToken
        : (derivedPageToken ?? sourceToken);

    // Verify token: prefer the shared Meta App token (one callback for all
    // channels), then the channel's existing one, else mint.
    // The row we are ABOUT TO WRITE, not the channel default. Reading the
    // default's config meant connecting a SECOND Page/account inherited the
    // first one's verify token instead of keeping its own — the same class of bug
    // the WhatsApp path already fixed and commented (see whatsapp.service's
    // two-read note). `??` on the account key so a first connect (no row yet)
    // correctly falls through to minting a fresh token.
    const existing = await this.db.channelConnection.findFirst({
      where: {
        workspaceId,
        channel: CHANNEL,
        externalAccountId: pageId ?? "",
      },
      select: { config: true },
    });
    const existingConfig = (existing?.config ?? {}) as MessengerChannelConfig;
    const verifyToken =
      input.verifyToken?.trim() ||
      meta?.verifyToken ||
      existingConfig.verifyToken ||
      randomBytes(24).toString("hex");

    const newConfig = pruneUndefined({
      pageId,
      pageName,
      appId,
      verifyToken,
    });
    const newSecrets: MessengerChannelSecrets = {
      pageAccessToken: encryptSecret(tokenToStore),
      appSecret: encryptSecret(appSecret),
    };

    // Account-keyed: a workspace may hold several accounts on this channel, so
    // re-pasting one account's credentials must not overwrite a sibling.
    await this.db.channelConnection.upsert({
      where: {
        workspaceId_channel_externalAccountId: {
          workspaceId,
          channel: CHANNEL,
          externalAccountId: pageId ?? "",
        },
      },
      create: {
        workspaceId,
        channel: CHANNEL,
        externalAccountId: pageId ?? "",
        isDefault: !(await this.db.channelConnection.count({
          where: { workspaceId, channel: CHANNEL },
        })),
        config: newConfig as Prisma.InputJsonValue,
        secrets: newSecrets as Prisma.InputJsonValue,
        isActive: true,
      },
      update: {
        config: newConfig as Prisma.InputJsonValue,
        secrets: newSecrets as Prisma.InputJsonValue,
        isActive: true,
        // A fresh token clears any prior expired-token (Graph 190) flag.
        needsReconnect: false,
        lastAuthErrorAt: null,
      },
    });

    await normalizeDefaultAccount(workspaceId, CHANNEL, pageId);

    invalidateMessengerConfig(workspaceId);

    // Subscribe the Page to the messaging webhook fields. Without this Meta never
    // sends a single `object:"page"` event — the silent "connected but no inbound"
    // failure. Best-effort: the credentials are already persisted and valid, so a
    // Graph hiccup or a missing permission must not fail the connect. `getConfig`
    // re-reads the real subscription and warns if `messages` is still absent.
    const sub = await ensurePageSubscribedToMessaging(
      pageId,
      tokenToStore,
      GRAPH_VERSION,
      appId,
      appSecret,
    );
    if (!sub.ok) {
      this.logger.warn(
        `[${workspaceId}] messenger connected but page subscription failed for page=${pageId}: ${sub.error}`,
      );
    }

    // NOTE: Messenger calling is intentionally DISABLED (see
    // CHANNEL_CAPABILITIES.messenger.calling === false) — the product only offers
    // WhatsApp calling for now, so onboarding does NOT enable call routing/audio
    // on the Page. Re-add the `enableSocialCalling` step here when calling is
    // turned back on.

    await this.bus.publish({ type: "team.catalog_changed", workspaceId, scope: "channels" });

    return { config: { pageId, pageName: pageName ?? null, verifyToken } };
  }

  // ── Messenger Profile API (entry points + welcome screen) ────────────────
  //
  // These read and write META, not our database, and there is deliberately no
  // local mirror: both are editable in Business Suite too, so a cached copy would
  // start lying the moment someone edited it there. The panel reads through,
  // writes through, and re-reads.
  //
  // Meta's rate limit is the constraint that shapes this: "10 API calls per 10
  // minute interval… enforced per Page". So a read fetches every field in ONE
  // request, and nothing here is called on a hot path.
  //
  // `null` from a read means we could not ask (not connected, or Graph refused).
  // The caller must render "couldn't load" rather than an empty editor — an empty
  // editor's next save would CLEAR a live configuration.

  async getEntryPoints(
    workspaceId: string,
    accountId?: string,
  ): Promise<ChannelEntryPoints | null> {
    const read = messengerProvider.getEntryPoints;
    if (!read) return null;
    try {
      return await read(await getMessengerSendConfig(workspaceId, accountId ?? null));
    } catch (err) {
      if (err instanceof ProviderNotConfiguredError) return null;
      this.logger.warn(
        `[${workspaceId}] could not read messenger entry points: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  async setEntryPoints(
    workspaceId: string,
    input: UpdateMessengerEntryPointsInput,
  ): Promise<ChannelEntryPoints | null> {
    const write = messengerProvider.setEntryPoints;
    if (!write) {
      throw new BadRequestException({
        error: "entry_points_not_supported",
        detail: "This channel has no ice breakers or persistent menu.",
      });
    }
    const config = await this.sendConfigOrThrow(workspaceId, input.accountId);
    try {
      await write({ iceBreakers: input.iceBreakers, menuItems: input.menuItems }, config);
    } catch (err) {
      // Meta's own rejection is the useful message (a bad URL, a missing
      // permission, the profile rate limit) — surface it, not a generic 500.
      throw new BadGatewayException({
        error: "entry_points_update_failed",
        detail: err instanceof Error ? err.message.slice(0, 300) : String(err),
      });
    }
    // Re-read rather than echo the intent: Meta silently ignores parts it won't
    // apply, and the panel must show what is actually live.
    return this.getEntryPoints(workspaceId, input.accountId);
  }

  async getWelcome(
    workspaceId: string,
    accountId?: string,
  ): Promise<ChannelWelcomeScreen | null> {
    const read = messengerProvider.getWelcomeScreen;
    if (!read) return null;
    try {
      return await read(await getMessengerSendConfig(workspaceId, accountId ?? null));
    } catch (err) {
      if (err instanceof ProviderNotConfiguredError) return null;
      this.logger.warn(
        `[${workspaceId}] could not read messenger welcome screen: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  async setWelcome(
    workspaceId: string,
    input: UpdateMessengerWelcomeInput,
  ): Promise<ChannelWelcomeScreen | null> {
    const write = messengerProvider.setWelcomeScreen;
    if (!write) {
      throw new BadRequestException({
        error: "welcome_screen_not_supported",
        detail: "This channel has no Get Started button or greeting.",
      });
    }
    const config = await this.sendConfigOrThrow(workspaceId, input.accountId);
    try {
      await write(
        {
          getStartedPayload: input.getStartedPayload || null,
          greeting: input.greeting || null,
          commands: input.commands,
        },
        config,
      );
    } catch (err) {
      throw new BadGatewayException({
        error: "welcome_screen_update_failed",
        detail: err instanceof Error ? err.message.slice(0, 300) : String(err),
      });
    }
    return this.getWelcome(workspaceId, input.accountId);
  }

  /**
   * Sticker catalog. The three catalog endpoints authenticate with an APP access
   * token (`app_id|app_secret`), not the Page token every other call here uses —
   * so this resolves the app credentials off the connection rather than reusing
   * the send config wholesale. A connection stored before `appId` was captured
   * simply can't browse; that is reported as `null`, not an error, because the
   * picker degrades to the always-sendable like sticker.
   */
  async stickers(
    workspaceId: string,
    query: StickerCatalogQuery,
  ): Promise<
    | { packs: MessengerStickerPack[]; stickers?: undefined }
    | { stickers: MessengerSticker[]; packs?: undefined }
    | null
  > {
    let config: MessengerSendConfig;
    try {
      config = await getMessengerSendConfig(workspaceId, null);
    } catch (err) {
      if (err instanceof ProviderNotConfiguredError) return null;
      throw err;
    }
    if (!config.appId || !config.appSecret) return null;
    const auth = {
      appId: config.appId,
      appSecret: config.appSecret,
      graphVersion: config.graphVersion,
    };
    try {
      if (query.q) return { stickers: await searchStickers(query.q, auth, query.locale) };
      if (query.packId) {
        return { stickers: await listStickersInPack(query.packId, auth, query.locale) };
      }
      return { packs: await listStickerPacks(auth, query.locale) };
    } catch (err) {
      this.logger.warn(
        `[${workspaceId}] sticker catalog read failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /**
   * Handover Protocol — change who may answer a conversation.
   *
   * Explicit, never automatic. A reply that fails with Meta's `2018300` is
   * classified `thread_control_lost` and left for a human to resolve with this,
   * because taking a thread away from a bot mid-flow is a decision about the
   * customer's experience, not an error-recovery detail. See the header of
   * `messenger-handover.ts`.
   *
   * The returned `ownerAppId` is RE-READ from Meta, not inferred. That matters
   * most for `request`: the primary receiver may ignore it, so a 200 here does
   * not mean the thread is ours and the caller must check.
   */
  async threadControl(
    workspaceId: string,
    input: ThreadControlInput,
  ): Promise<{ ownerAppId: string | null }> {
    const act = messengerProvider.threadControl;
    if (!act) {
      throw new BadRequestException({
        error: "thread_control_not_supported",
        detail: "This channel has no handover protocol.",
      });
    }
    const config = await this.sendConfigOrThrow(workspaceId, input.accountId);
    try {
      return await act(
        {
          to: input.psid,
          action: input.action,
          ...(input.targetAppId ? { targetAppId: input.targetAppId } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
        config,
      );
    } catch (err) {
      // Meta's own rejection is the useful text: "not the primary receiver",
      // "no app has control", etc. A generic 500 would send an operator hunting.
      throw new BadGatewayException({
        error: "thread_control_failed",
        detail: err instanceof Error ? err.message.slice(0, 300) : String(err),
      });
    }
  }

  /** Which app currently owns a conversation. Null = unknown (see the provider). */
  async threadOwner(
    workspaceId: string,
    psid: string,
    accountId?: string,
  ): Promise<string | null> {
    const read = messengerProvider.threadOwner;
    if (!read) return null;
    try {
      return await read(psid, await getMessengerSendConfig(workspaceId, accountId ?? null));
    } catch (err) {
      if (err instanceof ProviderNotConfiguredError) return null;
      throw err;
    }
  }

  // ── Personas + utility templates ─────────────────────────────────────────
  // Both read Meta live and keep no local mirror, for the reason spelled out in
  // each module: Meta owns the record, both are editable elsewhere, and a cached
  // copy would be a second truth needing a reconciler.

  async personas(workspaceId: string, accountId?: string): Promise<ChannelPersona[] | null> {
    const read = messengerProvider.listPersonas;
    if (!read) return null;
    try {
      return await read(await getMessengerSendConfig(workspaceId, accountId ?? null));
    } catch (err) {
      if (err instanceof ProviderNotConfiguredError) return null;
      this.logger.warn(
        `[${workspaceId}] could not list messenger personas: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  async createPersona(
    workspaceId: string,
    input: CreatePersonaInput,
  ): Promise<ChannelPersona> {
    const create = messengerProvider.createPersona;
    if (!create) {
      throw new BadRequestException({
        error: "personas_not_supported",
        detail: "This channel has no personas.",
      });
    }
    const config = await this.sendConfigOrThrow(workspaceId, input.accountId);
    try {
      return await create(
        { name: input.name, profilePictureUrl: input.profilePictureUrl },
        config,
      );
    } catch (err) {
      // Meta DOWNLOADS the image at create time, so "your URL is unreachable" is
      // by far the most common failure and its own message is the useful one.
      throw new BadGatewayException({
        error: "persona_create_failed",
        detail: err instanceof Error ? err.message.slice(0, 300) : String(err),
      });
    }
  }

  async deletePersona(
    workspaceId: string,
    personaId: string,
    accountId?: string,
  ): Promise<void> {
    const del = messengerProvider.deletePersona;
    if (!del) {
      throw new BadRequestException({
        error: "personas_not_supported",
        detail: "This channel has no personas.",
      });
    }
    const config = await this.sendConfigOrThrow(workspaceId, accountId);
    try {
      // SOFT delete on Meta's side: history is preserved, only future sends are
      // blocked. Safe to call when an agent leaves.
      await del(personaId, config);
    } catch (err) {
      throw new BadGatewayException({
        error: "persona_delete_failed",
        detail: err instanceof Error ? err.message.slice(0, 300) : String(err),
      });
    }
  }

  /**
   * The Page's approved UTILITY templates — the only way to message a customer
   * outside the 24h window since Meta retired the three update tags.
   *
   * `null` means we could not read them (not connected, or Graph refused), which
   * must NOT be shown as "this Page has no templates": the difference decides
   * whether an operator creates one or goes looking for a permission problem.
   */
  async utilityTemplates(workspaceId: string, accountId?: string): Promise<unknown[] | null> {
    const read = messengerProvider.fetchUtilityTemplates;
    if (!read) return null;
    try {
      return await read(await getMessengerSendConfig(workspaceId, accountId ?? null));
    } catch (err) {
      if (err instanceof ProviderNotConfiguredError) return null;
      this.logger.warn(
        `[${workspaceId}] could not list messenger utility templates: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /**
   * Reach for a Messenger template campaign, per Page.
   *
   * A PSID belongs to ONE Page (Meta: "a unique page-scoped ID for each Facebook
   * Page they start a conversation with"), so a campaign's sending account is a
   * per-RECIPIENT fact, not a campaign-level choice. This is what lets the
   * composer say so honestly — total reach, the split by Page, and which Pages
   * are missing the chosen template — before anyone schedules a send.
   */
  async broadcastReach(workspaceId: string, templateName?: string) {
    return messengerBroadcastReach(workspaceId, templateName);
  }

  /** Load the send config, turning "not connected" into a 400 the UI can read. */
  private async sendConfigOrThrow(
    workspaceId: string,
    accountId?: string,
  ): Promise<MessengerSendConfig> {
    try {
      return await getMessengerSendConfig(workspaceId, accountId ?? null);
    } catch (err) {
      if (err instanceof ProviderNotConfiguredError) {
        throw new BadRequestException({
          error: "messenger_not_connected",
          detail: "Connect this Page before configuring its Messenger profile.",
        });
      }
      throw err;
    }
  }

  async disconnect(workspaceId: string, confirmAll?: boolean): Promise<void> {
    // Refuse an ambiguous blast radius; see the helper.
    await assertChannelDisconnectConfirmed(workspaceId, CHANNEL, confirmAll);
    // Read the rows BEFORE deleting them: releasing the subscription needs the
    // Page id and a token, and both die with the row.
    const rows = await this.db.channelConnection.findMany({
      where: { workspaceId, channel: CHANNEL },
      select: { id: true, config: true, secrets: true },
    });
    await this.db.channelConnection.deleteMany({ where: { workspaceId, channel: CHANNEL } });
    // A saved view scoped to one of these Pages now names an id nothing can
    // carry — it would render empty forever (lib/inbox-views/scrub.ts).
    await scrubViewReferences(this.db, workspaceId, {
      channelAccountIds: rows.map((r) => r.id),
    });
    invalidateMessengerConfig(workspaceId);
    // Tell Meta to stop delivering. The per-ACCOUNT removal path has released
    // the Page subscription since multi-account shipped; this channel-wide route
    // — which is strictly more destructive — never did, so Meta kept posting a
    // disconnected Page's customer messages forever and ingest dropped them as
    // `unknown_account`. "We drop it" is not "we don't receive it": the Page
    // still looks connected in Meta's dashboard, and reconnecting elsewhere
    // silently competes with a subscription nobody remembers granting.
    await this.releasePages(workspaceId, rows);
    await this.bus.publish({ type: "team.catalog_changed", workspaceId, scope: "channels" });
  }

  /**
   * Best-effort `DELETE /{page-id}/subscribed_apps` for every Page this channel
   * held, honouring the one rule that makes it safe: Messenger and Instagram can
   * share ONE Page and `meta-page-subscription` deliberately keeps a SINGLE union
   * of fields across both, with no per-channel subset to subtract. So a Page the
   * Instagram channel still uses is KEPT — releasing it would take that channel's
   * inbound dark, which is the exact failure the union exists to prevent.
   *
   * Never throws: this runs AFTER the rows are gone, so a failure leaves exactly
   * the pre-existing behaviour rather than half-completing a removal the operator
   * asked for — but it is no longer the end of the story either: a failed DELETE
   * leaves a `PendingSubscriptionRelease` IOU for the retry sweeper.
   */
  private async releasePages(
    workspaceId: string,
    rows: { config: Prisma.JsonValue; secrets: Prisma.JsonValue }[],
  ): Promise<void> {
    const seen = new Set<string>();
    for (const row of rows) {
      const pageId = ((row.config ?? {}) as MessengerChannelConfig).pageId;
      const secrets = (row.secrets ?? {}) as MessengerChannelSecrets;
      const cipher = secrets.pageAccessToken;
      if (!pageId || !cipher || seen.has(pageId)) continue;
      seen.add(pageId);
      const token = this.tryDecrypt(cipher, "pageAccessToken");
      if (!token) continue; // undecryptable — nothing to authenticate the call with
      // GLOBAL, and deliberately not workspace-scoped — the same rule the
      // per-account path states (channel-accounts.service.ts): a Page
      // subscription is an APP-level object, so releasing it takes inbound dark
      // for EVERY workspace on that Page, not just this one. A workspace-scoped
      // count answered "is anyone HERE still using it", which let one tenant's
      // disconnect silently stop a sibling tenant's messages. The rows for this
      // workspace are already deleted above, so this sees the post-delete world.
      // The read answers a boolean about an app-level object and returns no
      // tenant data.
      const stillInUse =
        (await this.db.channelConnection.count({
          where: {
            channel: { in: ["messenger", "instagram"] },
            config: { path: ["pageId"], equals: pageId },
          },
        })) > 0;
      // Sign the DELETE with `appsecret_proof`. A customer app with "Require app
      // secret" ON rejects the unsigned call outright, so an unsigned release
      // releases NOTHING and Meta keeps delivering — the row's own secret first,
      // then the workspace's shared app, the same order the per-account path
      // resolves them in (channel-accounts.service.ts).
      const appSecret =
        this.tryDecrypt(secrets.appSecret ?? null, "appSecret") ??
        (await getMetaConnection(workspaceId))?.appSecret ??
        undefined;
      // IOU only when the call will actually DELETE — a kept (still-in-use)
      // subscription owes Meta nothing. Written BEFORE the attempt, settled on
      // success, otherwise owned by the subscription-release-retry sweeper.
      const pendingId = stillInUse
        ? null
        : await enqueuePendingRelease({
            workspaceId,
            channel: CHANNEL,
            externalObjectId: pageId,
            secrets: {
              accessToken: cipher,
              ...(secrets.appSecret ? { appSecret: secrets.appSecret } : {}),
            },
          });
      const res = await releasePageSubscription(pageId, token, GRAPH_VERSION, {
        stillInUse,
        ...(appSecret ? { appSecret } : {}),
      });
      if (res.ok) await resolvePendingRelease(pendingId);
      else
        this.logger.warn(
          `[${workspaceId}] could not release page subscription for page=${pageId} (retry sweeper owns it): ${res.error}`,
        );
    }
  }
}
