import { randomBytes } from "node:crypto";

import { Prisma } from "@prisma/client";
import { BadGatewayException, BadRequestException, Injectable, Logger } from "@nestjs/common";

import { decryptSecret, encryptSecret } from "@/lib/crypto/envelope";
import { withAppsecretProof } from "@/lib/providers/appsecret-proof";
import { invalidateInstagramConfig } from "@/lib/providers/instagram-config";
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

import { getInstagramSendConfig } from "@/lib/providers/instagram-config";
import { instagramProvider } from "@/lib/providers/instagram";
import { ProviderNotConfiguredError } from "@/lib/providers/config";
import type { ChannelEntryPoints } from "@ccp/shared/providers/types";
import { SECRET_SAVED_SENTINEL } from "@ccp/shared/dtos";
import {
  channelInboxSources,
  INBOX_SOURCES,
  type InboxSource,
} from "@ccp/shared/providers/capabilities";

import { EventBus } from "../../events/event-bus.module";
import { DbService } from "../../db/db.service";
import type {
  UpdateEntryPointsInput,
  UpdateInboxSourcesInput,
  UpdateInstagramConfigInput,
} from "./instagram.schemas";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v26.0";
const GRAPH_BASE = process.env.META_GRAPH_BASE_URL || "https://graph.facebook.com";
const CHANNEL = "instagram" as const;

interface InstagramChannelConfig {
  igId?: string;
  igUsername?: string;
  /** The Facebook Page the Instagram account is linked to (source of igId). */
  pageId?: string;
  pageName?: string;
  appId?: string;
  verifyToken?: string;
  /** Non-DM sources allowed into the inbox. Absent/empty = DMs only. */
  inboxSources?: InboxSource[];
}
interface InstagramChannelSecrets {
  igAccessToken?: string;
  appSecret?: string;
}

/** Server→browser view for the admin connect form (never client→server). */
export interface InstagramConfigView {
  /** Non-DM sources currently allowed into the inbox (DMs are always on). */
  inboxSources: InboxSource[];
  /** Every non-DM source this channel can offer, so the UI needs no channel map. */
  availableInboxSources: InboxSource[];
  igId: string | null;
  igUsername: string | null;
  pageId: string | null;
  pageName: string | null;
  appId: string | null;
  verifyToken: string | null;
  /** `SECRET_SAVED_SENTINEL` when a value is stored (and decryptable), else
   *  null — never the plaintext. Submitting the sentinel back keeps the stored
   *  value. */
  igAccessToken: string | null;
  appSecret: string | null;
  /** True when the corresponding secret is stored and decryptable. */
  igAccessTokenSet: boolean;
  appSecretSet: boolean;
  credentialsUndecryptable: boolean;
  /** True when a send failed with Graph 190 (token expired/revoked) — drives the
   *  Settings "reconnect" banner. */
  needsReconnect: boolean;
  /** Inbound webhooks we 403'd within the last 24h (bad_signature / no_config)
   *  — see WhatsappConfigView.webhookRejection; same shape, same 24h filter. */
  webhookRejection: { at: string; reason: string } | null;
  /**
   * Live subscription of the LINKED PAGE to the app. Instagram DMs ride the Page,
   * so an unsubscribed Page means no inbound — same failure mode as Messenger.
   * `null` when it couldn't be checked.
   */
  webhookSubscription: {
    receivesMessages: boolean;
    subscribedFields: string[];
    missingFields: string[];
  } | null;
}

function pruneUndefined<T extends object>(o: T): T {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as T;
}

/**
 * Instagram DM connection settings — admin-only. Same credential model as
 * WhatsApp / Messenger (a `ChannelConnection` row keyed (workspaceId, "instagram");
 * `config` non-secret, `secrets` envelope-encrypted) but with IG account fields.
 */
@Injectable()
export class InstagramService {
  private readonly logger = new Logger(InstagramService.name);
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
        `could not decrypt instagram ${label}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Current config for the admin connect form.
   *
   * Secrets are decrypted here only to PROBE (the live Page-subscription read
   * below) and to compute the Set/undecryptable flags — the response carries
   * `SECRET_SAVED_SENTINEL` in their place, never the plaintext, so the
   * long-lived token + App secret are not readable from every admin's devtools.
   * `updateConfig` reads the sentinel as "keep the stored value".
   */
  async getConfig(workspaceId: string): Promise<InstagramConfigView> {
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
    const config = (conn?.config ?? {}) as InstagramChannelConfig;
    const secrets = (conn?.secrets ?? {}) as InstagramChannelSecrets;

    const igAccessToken = this.tryDecrypt(secrets.igAccessToken ?? null, "igAccessToken");
    const appSecret = this.tryDecrypt(secrets.appSecret ?? null, "appSecret");
    const credentialsUndecryptable =
      (secrets.igAccessToken != null && igAccessToken === null) ||
      (secrets.appSecret != null && appSecret === null);

    // Instagram DMs are delivered through the LINKED PAGE, so an unsubscribed
    // Page is the same silent "connected but no inbound" failure as Messenger.
    // Best-effort read; never fatal.
    let webhookSubscription: InstagramConfigView["webhookSubscription"] = null;
    if (config.pageId && igAccessToken) {
      try {
        const status = await getPageSubscription(
          config.pageId,
          igAccessToken,
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
          `[${workspaceId}] could not read instagram page subscription: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

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
              externalAccountId: config.igId ?? "",
            },
          },
          create: {
            workspaceId,
            channel: CHANNEL,
            externalAccountId: config.igId ?? "",
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
          `could not pre-mint instagram verify token: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return {
      inboxSources: Array.isArray(config.inboxSources)
        ? config.inboxSources.filter((v): v is InboxSource =>
            (INBOX_SOURCES as readonly string[]).includes(v),
          )
        : [],
      availableInboxSources: [...channelInboxSources(CHANNEL)],
      igId: config.igId ?? null,
      igUsername: config.igUsername ?? null,
      pageId: config.pageId ?? null,
      pageName: config.pageName ?? null,
      appId: config.appId ?? null,
      verifyToken,
      igAccessToken: igAccessToken !== null ? SECRET_SAVED_SENTINEL : null,
      appSecret: appSecret !== null ? SECRET_SAVED_SENTINEL : null,
      igAccessTokenSet: igAccessToken !== null,
      appSecretSet: appSecret !== null,
      credentialsUndecryptable,
      needsReconnect: conn?.needsReconnect ?? false,
      webhookRejection: recentWebhookRejection(
        conn?.lastWebhookRejectedAt ?? null,
        conn?.lastWebhookRejectReason ?? null,
      ),
      webhookSubscription,
    };
  }

  async updateConfig(
    workspaceId: string,
    input: UpdateInstagramConfigInput,
  ): Promise<{
    config: { igId: string; igUsername: string | null; pageId: string; verifyToken: string };
  }> {
    const { pageId } = input;

    // getConfig ships SECRET_SAVED_SENTINEL in place of stored plaintext, so an
    // untouched form can echo it back. Treat it as "not typed" — the precedence
    // below then keeps this row's own stored secret and re-derives its Page
    // token, exactly as a blank field does. Never let it reach `encryptSecret`.
    const typedIgAccessToken =
      input.igAccessToken === SECRET_SAVED_SENTINEL ? undefined : input.igAccessToken;
    const typedAppSecret =
      input.appSecret === SECRET_SAVED_SENTINEL ? undefined : input.appSecret;

    // Source app-level credentials from the shared Meta App connection unless
    // overridden on this form. The Page access token is derived below.
    const meta = await getMetaConnection(workspaceId);
    // THIS ROW'S OWN stored credentials, found by scanning for the row whose
    // config carries this `pageId` — the row itself is keyed by igId, which
    // only the Graph call below resolves, so the usual keyed lookup can't run
    // yet. Used ONLY at store time to keep an own-app row's coherent
    // token/secret pair — NOT in the sourceToken chain: the stored value is a
    // derived PAGE token, and the `instagram_business_account` field the probe
    // below reads requires a user/system-user token (Page reference), so
    // probing with it made every ordinary re-save fail
    // `instagram_not_linked_to_page` on a perfectly linked account.
    const preExisting = (
      await this.db.channelConnection.findMany({
        where: { workspaceId, channel: CHANNEL },
        select: { config: true, secrets: true },
      })
    ).find((row) => ((row.config ?? {}) as InstagramChannelConfig).pageId === pageId);
    const preOwnSecrets = (preExisting?.secrets ?? {}) as InstagramChannelSecrets;
    const ownIgToken = this.tryDecrypt(preOwnSecrets.igAccessToken ?? null, "igAccessToken");
    const preOwnAppSecret = this.tryDecrypt(preOwnSecrets.appSecret ?? null, "appSecret");
    const sourceToken = typedIgAccessToken?.trim() || meta?.systemUserToken || null;
    const appId = input.appId?.trim() || meta?.appId || undefined;
    // Checked BEFORE the Graph call that resolves `igId` — that call needs the
    // token. The app-secret half of this guard runs after, for the reason in the
    // `ownAppSecret` note below.
    if (!sourceToken) {
      throw new BadRequestException({
        error: "meta_not_configured",
        detail:
          "Set up your Meta App connection first (Settings → Meta App: App secret + system-user token), then connect the channel.",
      });
    }

    // Resolve the Instagram business account FROM the Page. This is the whole
    // point of taking a Page id: `instagram_business_account.id` is the
    // canonical Instagram id in the graph.facebook.com namespace — the same one
    // that arrives on inbound webhooks and that outbound sends must target — so
    // a mismatched Instagram-Login id can't be entered by hand. If the Page has
    // no linked Instagram account, we reject with an actionable error instead of
    // silently connecting something that will never receive a DM.
    let igId: string;
    let igUsername: string | undefined;
    let pageName: string | undefined;
    let derivedPageToken: string | undefined;
    // The proof secret for this call must belong to the app that issued
    // `sourceToken` — pair it BY THE TOKEN'S TIER: a typed token signs only
    // with a typed secret (never mis-signed with a fallback secret — Meta
    // rejects a WRONG proof even when none is required); the shared token
    // signs with the shared secret.
    const proofSecret = typedIgAccessToken?.trim()
      ? typedAppSecret?.trim() || undefined
      : (meta?.appSecret ?? undefined);
    try {
      const res = await fetch(
        withAppsecretProof(
          `${GRAPH_BASE}/${GRAPH_VERSION}/${encodeURIComponent(pageId)}` +
            `?fields=name,access_token,instagram_business_account{id,username}`,
          sourceToken,
          proofSecret,
        ),
        {
          headers: { authorization: `Bearer ${sourceToken}` },
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!res.ok) {
        const body = await res.text();
        throw new BadRequestException({
          error: "instagram_validation_failed",
          detail: body.slice(0, 300),
        });
      }
      const data = (await res.json()) as {
        name?: string;
        access_token?: string;
        instagram_business_account?: { id?: string; username?: string };
      };
      const iba = data.instagram_business_account;
      if (!iba?.id) {
        throw new BadRequestException({
          error: "instagram_not_linked_to_page",
          detail:
            "This Facebook Page has no linked Instagram Business/Creator account. In the Instagram app or Page settings, link a professional Instagram account to this Page, then reconnect.",
        });
      }
      igId = iba.id;
      igUsername = typeof iba.username === "string" ? iba.username : undefined;
      pageName = typeof data.name === "string" ? data.name : undefined;
      // Instagram-via-Facebook-Login sends over graph.facebook.com/{igId}/messages,
      // which — like Messenger — is a Page-scoped call that the New Pages
      // Experience only accepts with a PAGE access token. Derive it from the
      // Page and store THAT, so a pasted system-user token still sends.
      derivedPageToken =
        typeof data.access_token === "string" && data.access_token.length > 0
          ? data.access_token
          : undefined;
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadGatewayException({
        error: "instagram_validation_unreachable",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    // Fail loudly if we couldn't get a Page token and none was pasted — storing
    // the shared system-user token would mark the channel connected but leave it
    // unsendable (New Pages Experience rejects it). See messenger.service.
    if (!derivedPageToken && !typedIgAccessToken?.trim()) {
      throw new BadRequestException({
        error: "page_token_derivation_failed",
        detail:
          "Couldn't get a Page access token for this Page from your Meta App system-user token. Assign the system user to this Page (Business Settings → Pages → Add People) with a messaging task, or paste a Page access token directly.",
      });
    }
    // STORE-time pair coherence — same rule as messenger.service: an own-app
    // row re-saved without a typed token keeps its stored token, so the newly
    // derived shared-app token can't land beside the row's own appSecret (the
    // mis-pair that mis-signs every later Graph call). Moving the account
    // between apps is signalled by pasting a token.
    const ownAppRow = Boolean(
      preOwnAppSecret && meta?.appSecret && preOwnAppSecret !== meta.appSecret,
    );
    const tokenToStore =
      !typedIgAccessToken?.trim() && ownAppRow && ownIgToken
        ? ownIgToken
        : (derivedPageToken ?? sourceToken);

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
        externalAccountId: igId ?? "",
      },
      select: { config: true, secrets: true },
    });
    const existingConfig = (existing?.config ?? {}) as InstagramChannelConfig;

    // Precedence: operator input → THIS ROW'S OWN stored secret → the shared Meta
    // App. The middle term protects an account deliberately living on a DIFFERENT
    // Meta app: the webhook HMAC check already tries every account's own secret for
    // that reason, and without this any re-save silently replaced it with the shared
    // app's — after which Meta signs that account's webhooks with a secret we no
    // longer hold and every inbound is dropped as forged.
    //
    // Read HERE, keyed on `igId`, not earlier keyed on `pageId`. An Instagram row's
    // `externalAccountId` is the IG professional-account id — that is what Meta puts
    // in `entry[].id` on an `object:"instagram"` webhook, so it is what the row is
    // keyed on. This lookup was copied from `messenger.service`, where the Page id
    // IS the account key; on Instagram it matched nothing, so `ownAppSecret` was
    // permanently null and the middle term of the precedence above did not exist.
    // The failure it was written to prevent therefore still happened in full.
    const ownSecrets = (existing?.secrets ?? {}) as InstagramChannelSecrets;
    const ownAppSecret = this.tryDecrypt(ownSecrets.appSecret ?? null, "appSecret");
    const appSecret = typedAppSecret?.trim() || ownAppSecret || meta?.appSecret || null;
    if (!appSecret) {
      throw new BadRequestException({
        error: "meta_not_configured",
        detail:
          "Set up your Meta App connection first (Settings → Meta App: App secret + system-user token), then connect the channel.",
      });
    }

    const verifyToken =
      input.verifyToken?.trim() ||
      meta?.verifyToken ||
      existingConfig.verifyToken ||
      randomBytes(24).toString("hex");

    const newConfig = pruneUndefined({
      igId,
      igUsername,
      pageId,
      pageName,
      appId,
      verifyToken,
    });
    const newSecrets: InstagramChannelSecrets = {
      igAccessToken: encryptSecret(tokenToStore),
      appSecret: encryptSecret(appSecret),
    };

    // Account-keyed: a workspace may hold several accounts on this channel, so
    // re-pasting one account's credentials must not overwrite a sibling.
    await this.db.channelConnection.upsert({
      where: {
        workspaceId_channel_externalAccountId: {
          workspaceId,
          channel: CHANNEL,
          externalAccountId: igId ?? "",
        },
      },
      create: {
        workspaceId,
        channel: CHANNEL,
        externalAccountId: igId ?? "",
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

    await normalizeDefaultAccount(workspaceId, CHANNEL, igId);

    invalidateInstagramConfig(workspaceId);

    // Instagram DMs ride the linked Page, so the Page must be subscribed to the
    // app. The helper posts the UNION of existing + required fields — critical
    // here, because a plain replace would unsubscribe Messenger from the SAME
    // Page. Best-effort; `getConfig` surfaces the truth.
    const sub = await ensurePageSubscribedToMessaging(
      pageId,
      tokenToStore,
      GRAPH_VERSION,
      appId,
      appSecret,
    );
    if (!sub.ok) {
      this.logger.warn(
        `[${workspaceId}] instagram connected but page subscription failed for page=${pageId}: ${sub.error}`,
      );
    }

    await this.bus.publish({ type: "team.catalog_changed", workspaceId, scope: "channels" });

    return { config: { igId, igUsername: igUsername ?? null, pageId, verifyToken } };
  }

  /**
   * Read this account's conversation entry points straight from Meta.
   *
   * Deliberately NOT cached or mirrored into our DB. Meta is the authority here —
   * the ice breakers can also be edited in Business Suite, and a local copy would
   * start lying the moment someone did. The panel reads through, writes through,
   * and re-reads; there is no state for the two to disagree about.
   *
   * `null` means we could not ask (not connected, or Graph refused) — the caller
   * renders "couldn't load" rather than an empty editor that would silently CLEAR
   * a live configuration on its next save.
   */
  async getEntryPoints(
    workspaceId: string,
    accountId?: string,
  ): Promise<ChannelEntryPoints | null> {
    const read = instagramProvider.getEntryPoints;
    if (!read) return null;
    try {
      const config = await getInstagramSendConfig(workspaceId, accountId ?? null);
      return await read(config);
    } catch (err) {
      if (err instanceof ProviderNotConfiguredError) return null;
      this.logger.warn(
        `[${workspaceId}] could not read instagram entry points: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /** Replace this account's entry points. An empty list CLEARS that field. */
  async setEntryPoints(
    workspaceId: string,
    input: UpdateEntryPointsInput,
  ): Promise<ChannelEntryPoints | null> {
    const write = instagramProvider.setEntryPoints;
    if (!write) {
      throw new BadRequestException({
        error: "entry_points_not_supported",
        detail: "This channel has no ice breakers or persistent menu.",
      });
    }
    let config;
    try {
      config = await getInstagramSendConfig(workspaceId, input.accountId ?? null);
    } catch (err) {
      if (err instanceof ProviderNotConfiguredError) {
        throw new BadRequestException({
          error: "instagram_not_connected",
          detail: "Connect this Instagram account before setting its entry points.",
        });
      }
      throw err;
    }
    try {
      await write(
        { iceBreakers: input.iceBreakers, menuItems: input.menuItems },
        config,
      );
    } catch (err) {
      // Meta's own rejection is the useful message here (a bad URL, a missing
      // permission) — surface it rather than a generic 500.
      throw new BadGatewayException({
        error: "entry_points_update_failed",
        detail: err instanceof Error ? err.message.slice(0, 300) : String(err),
      });
    }
    // Re-read rather than echo the intent: Meta silently ignores parts it will
    // not apply, and the panel must show what is actually live.
    return this.getEntryPoints(workspaceId, input.accountId);
  }

  /**
   * Set which NON-DM sources one account lets into the inbox.
   *
   * The whole set is replaced, so an absent member is turned OFF — the caller
   * states the desired world rather than a delta, which is the only shape a
   * checkbox list can send without a read-modify-write race between two admins.
   *
   * Stored on `ChannelConnection.config` (no migration, same place every other
   * per-account channel preference lives) and MERGED into the existing object, so
   * this can never drop the igId/pageId/verifyToken sitting beside it.
   */
  async setInboxSources(
    workspaceId: string,
    input: UpdateInboxSourcesInput,
  ): Promise<{ sources: InboxSource[] }> {
    const row = await this.db.channelConnection.findFirst({
      where: input.accountId
        ? { id: input.accountId, workspaceId, channel: CHANNEL }
        : { workspaceId, channel: CHANNEL, isDefault: true },
      select: { id: true, config: true },
    });
    if (!row) {
      throw new BadRequestException({
        error: "instagram_not_connected",
        detail: "Connect an Instagram account first.",
      });
    }
    // Only sources this CHANNEL can actually offer. The schema already rejects
    // unknown values; this rejects a known source that Instagram has no surface
    // for, so the stored set can never promise something the gate ignores.
    const offered = new Set(channelInboxSources(CHANNEL));
    const sources = [...new Set(input.sources)].filter((s) => offered.has(s));
    const config = (row.config ?? {}) as InstagramChannelConfig;
    await this.db.channelConnection.update({
      where: { id: row.id },
      data: {
        config: pruneUndefined({ ...config, inboxSources: sources }) as Prisma.InputJsonValue,
      },
    });
    invalidateInstagramConfig(workspaceId);
    return { sources };
  }

  async disconnect(workspaceId: string, confirmAll?: boolean): Promise<void> {
    // Refuse an ambiguous blast radius; see the helper.
    await assertChannelDisconnectConfirmed(workspaceId, CHANNEL, confirmAll);
    // Read before deleting — the Page id and the token both die with the row.
    const rows = await this.db.channelConnection.findMany({
      where: { workspaceId, channel: CHANNEL },
      select: { id: true, config: true, secrets: true },
    });
    await this.db.channelConnection.deleteMany({ where: { workspaceId, channel: CHANNEL } });
    // A saved view scoped to one of these accounts now names an id nothing can
    // carry — it would render empty forever (lib/inbox-views/scrub.ts).
    await scrubViewReferences(this.db, workspaceId, {
      channelAccountIds: rows.map((r) => r.id),
    });
    invalidateInstagramConfig(workspaceId);
    // Same gap as the Messenger channel-wide disconnect: the per-account removal
    // path releases the Page subscription, this route never did, so Meta kept
    // delivering a disconnected account's DMs and ingest dropped them as
    // `unknown_account`.
    await this.releasePages(workspaceId, rows);
    await this.bus.publish({ type: "team.catalog_changed", workspaceId, scope: "channels" });
  }

  /**
   * Best-effort `DELETE /{page-id}/subscribed_apps` for every Page this channel
   * held. KEPT when the Messenger channel still uses that Page: the subscription
   * is one shared union of fields across both channels (see meta-page-subscription
   * property 1), so releasing it would take Messenger's inbound dark. Never throws;
   * a failed DELETE leaves a `PendingSubscriptionRelease` IOU for the retry sweeper.
   */
  private async releasePages(
    workspaceId: string,
    rows: { config: Prisma.JsonValue; secrets: Prisma.JsonValue }[],
  ): Promise<void> {
    const seen = new Set<string>();
    for (const row of rows) {
      const pageId = ((row.config ?? {}) as InstagramChannelConfig).pageId;
      const secrets = (row.secrets ?? {}) as InstagramChannelSecrets;
      const cipher = secrets.igAccessToken;
      if (!pageId || !cipher || seen.has(pageId)) continue;
      seen.add(pageId);
      const token = this.tryDecrypt(cipher, "igAccessToken");
      if (!token) continue;
      // GLOBAL, and deliberately not workspace-scoped — same rule as the
      // per-account path and the Messenger twin: a Page subscription is an
      // APP-level object, so releasing it takes inbound dark for EVERY
      // workspace on that Page. A workspace-scoped count let one tenant's
      // disconnect silently stop a sibling tenant's messages. This workspace's
      // rows are already deleted above, so the count sees the post-delete world.
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
