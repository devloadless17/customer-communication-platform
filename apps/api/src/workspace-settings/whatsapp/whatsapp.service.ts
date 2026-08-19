import { randomBytes } from "node:crypto";

import { Prisma } from "@prisma/client";
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";

import {
  resumeBroadcastsForTemplate,
  resumePausedBroadcastsForTeam,
} from "@/lib/broadcast-runner";
import { decryptSecret, encryptSecret } from "@/lib/crypto/envelope";
import { withAppsecretProof } from "@/lib/providers/appsecret-proof";
import { getMetaProvider } from "@/lib/providers";
import { getRedisConnection } from "@/lib/workflows/queue";
import {
  getMetaSendConfig,
  invalidateProviderConfig,
  ProviderNotConfiguredError,
} from "@/lib/providers/config";
import { invalidateWabaAnalytics } from "@/lib/analytics/waba-analytics";
import { getMetaConnection } from "@/lib/providers/meta-connection";
import {
  fetchWhatsappHealthFromGraph,
  gcOrphanWhatsappPortfolios,
  getWhatsappHealth,
} from "@/lib/providers/meta-health";
import {
  ensureWabaSubscribed,
  fetchTokenAppId,
  isAppSubscribedToWaba,
  listWabaPhoneNumberIds,
  releaseWabaSubscription,
} from "@/lib/providers/meta-waba-subscription";
import {
  enqueuePendingRelease,
  resolvePendingRelease,
} from "@/lib/sweepers/subscription-release-retry";
import { graphGetJson } from "@/lib/providers/meta-graph";
import { recentWebhookRejection } from "@/lib/providers/channel-health";
import { normalizeDefaultAccount } from "@/lib/providers/normalize-default-account";
import {
  readTemplateAnalytics,
  refreshTemplateAnalytics,
  templateAnalyticsAccountContext,
} from "@/lib/analytics/template-analytics";
import {
  MetaSendError,
  MissingAppIdError,
  MissingWabaIdError,
} from "@/lib/providers/meta";
import { SECRET_SAVED_SENTINEL, type WhatsappConfigView } from "@ccp/shared/dtos";
import type {
  AuthTemplatePreview,
  LibraryTemplate,
  LibraryTemplateBodyInput,
  LibraryTemplateButtonInput,
  TemplateLibraryFilters,
  TemplateCategory,
  TemplateComponent,
  TemplateParameterFormat,
} from "@ccp/shared/providers/types";
import type { TemplateDto } from "@ccp/shared/types";
import {
  TEMPLATE_NAME_PATTERN,
  detectParameterFormat,
  validateTemplateComponents,
  validateTemplateTtl,
} from "@ccp/shared/template-render";
import { checkWhatsappUsername } from "@ccp/shared/whatsapp/username";
import { syncTemplateCatalog } from "@/lib/templates/catalog-sync";
import {
  normalizeTemplateLabels,
  templateIdsWithLabel,
} from "@/lib/templates/labels";
import { assertChannelDisconnectConfirmed } from "@/lib/providers/assert-channel-disconnect";

import { EventBus } from "../../events/event-bus.module";
import { DbService } from "../../db/db.service";
import type {
  UpdateTemplateBindingsInput,
  UpdateWhatsappConfigInput,
  UpdateBusinessProfileInput,
  CreateQrCodeInput,
  UpdateQrCodeInput,
  SetWhatsappUsernameInput,
} from "./whatsapp.schemas";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v26.0";
/**
 * Graph origin, honouring `META_GRAPH_BASE_URL` exactly like every sibling
 * service (`meta`, `messenger`, `instagram`) and the two providers.
 *
 * This file previously built three URLs against a hardcoded
 * `https://graph.facebook.com`, which meant the e2e mock-Graph server could not
 * intercept connect-validation, the WABA phone-number ownership assertion, or
 * `/register` — i.e. the three multi-account ONBOARDING calls, leaving them the
 * least-tested real Graph requests in the system.
 */
const GRAPH_BASE = process.env.META_GRAPH_BASE_URL || "https://graph.facebook.com";

/**
 * Lookback windows Meta's template-comparison endpoint accepts. Not a clamp — a
 * window outside this set returns an EMPTY result, which would read as "no
 * difference between these templates" rather than "bad request".
 */
const COMPARISON_WINDOWS = [7, 30, 60, 90] as const;

/**
 * Meta's formats for a one-tap / zero-tap authentication button's target app.
 * Both are unforgiving and both fail as an unlabelled `#100`, so they are
 * checked before the call.
 */
const ANDROID_PACKAGE_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
/** Exactly 11 characters from `[a-zA-Z0-9+/=]`. */
const SIGNATURE_HASH_PATTERN = /^[a-zA-Z0-9+/=]{11}$/;
const MAX_SUPPORTED_APPS = 5;
const UPLOAD_MAX_BYTES = 16 * 1024 * 1024;

const UPLOAD_ALLOWED_MIME = new Set<string>([
  "image/jpeg",
  "image/png",
  "video/mp4",
  "video/3gpp",
  "application/pdf",
]);

// Credentials live on a `ChannelConnection` row keyed by (workspaceId, provider).
// `config` = non-secret fields; `secrets` = envelope-encrypted ciphertext.
const META_PROVIDER = "whatsapp" as const;
interface MetaChannelConfig {
  phoneNumberId?: string;
  displayPhoneNumber?: string;
  wabaId?: string;
  appId?: string;
  verifyToken?: string;
}
interface MetaChannelSecrets {
  accessToken?: string;
  appSecret?: string;
}
/** Drop undefined keys so the stored JSON stays clean (mirrors backfill). */
function pruneUndefined<T extends object>(o: T): T {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as T;
}

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

  // -------------------------------------------------------------------------
  // Settings (admin only)
  // -------------------------------------------------------------------------

  /**
   * Current config for the admin settings form.
   *
   * Secrets are decrypted here only to PROBE (the live subscription read
   * below) and to compute the Set/undecryptable flags — the response carries
   * `SECRET_SAVED_SENTINEL` in their place, never the plaintext, so the
   * long-lived token + App secret are not readable from every admin's
   * devtools. `updateConfig` treats the sentinel as "keep the stored value".
   */
  async getConfig(workspaceId: string): Promise<WhatsappConfigView> {
    const conn = await this.db.channelConnection.findFirst({
      where: { workspaceId, channel: META_PROVIDER, isDefault: true },
      select: {
        config: true,
        secrets: true,
        isActive: true,
        needsReconnect: true,
        lastWebhookRejectedAt: true,
        lastWebhookRejectReason: true,
        // Messaging limit is portfolio-scoped (Meta, 2025-10-07), and the portfolio
        // hangs off the WABA (`owner_business_info` is a field on the WABA node).
        wabaAccount: {
          select: {
            externalWabaId: true,
            portfolio: { select: { messagingTier: true, messagingDailyCap: true } },
          },
        },
        qualityRating: true,
        throughputLevel: true,
        registrationStatus: true,
      },
    });
    const config = (conn?.config ?? {}) as MetaChannelConfig;
    const secrets = (conn?.secrets ?? {}) as MetaChannelSecrets;

    // Tolerate decrypt failure here (key rotated, value corrupt, wrong env):
    // surface it via the `credentialsUndecryptable` flag so the page can ask
    // the admin to re-paste. The send path in lib/providers/config.ts stays
    // strict — there, a failed decrypt is loud (silent send-nothing is worse).
    const accessToken = this.tryDecrypt(secrets.accessToken ?? null, "accessToken");
    const appSecret = this.tryDecrypt(secrets.appSecret ?? null, "appSecret");
    const credentialsUndecryptable =
      (secrets.accessToken != null && accessToken === null) ||
      (secrets.appSecret != null && appSecret === null);

    // Pre-mint a verify token on first read so the onboarding UI can show
    // "Step 1 — paste this into Meta" before any credentials are saved. The
    // row is created inactive (no creds yet); updateConfig flips isActive.
    // Concurrent first-loads can mint twice — benign before any Meta
    // subscription exists. Failure degrades to "shown next load".
    let verifyToken = config.verifyToken ?? null;
    if (verifyToken == null) {
      const minted = randomBytes(24).toString("hex");
      try {
        const mergedConfig = pruneUndefined({ ...config, verifyToken: minted });
        // Mints the verify token on the DEFAULT account for this channel (or
        // creates the first, credential-less one). Account-keyed like every
        // other write now that a channel can hold several.
        await this.db.channelConnection.upsert({
          where: {
            workspaceId_channel_externalAccountId: {
              workspaceId,
              channel: META_PROVIDER,
              externalAccountId: config.phoneNumberId ?? "",
            },
          },
          create: {
            workspaceId,
            channel: META_PROVIDER,
            externalAccountId: config.phoneNumberId ?? "",
            // NOT hardcoded true. `ChannelConnection_one_default_per_channel` is a
            // partial unique index on (workspaceId, channel) WHERE isDefault, so
            // pre-minting a second default collides — the failure was swallowed as
            // a warn and the verify token silently never appeared. Only the FIRST
            // row on the channel claims the flag.
            isDefault: !(await this.db.channelConnection.count({
              where: { workspaceId, channel: META_PROVIDER },
            })),
            config: mergedConfig as Prisma.InputJsonValue,
            secrets: {},
            isActive: false,
          },
          update: { config: mergedConfig as Prisma.InputJsonValue },
        });
        verifyToken = minted;
      } catch (err) {
        this.logger.warn(
          `could not pre-mint verify token: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Best-effort webhook health, mirroring the Messenger/Instagram getConfig
    // reads: a number can be "connected" with perfect credentials and still
    // receive nothing, because the WABA↔app subscription lives on Meta's side
    // and a dashboard re-save silently resets it. Read the truth live so the
    // settings page can replace its static "final check" hint with a verdict.
    // Never fatal — a Graph blip leaves it null (= unknown, keep the hint);
    // the 30-min sweeper independently self-heals a genuinely missing one.
    let subscription: WhatsappConfigView["subscription"] = null;
    const subWabaId = conn?.wabaAccount?.externalWabaId;
    if (conn?.isActive && subWabaId && accessToken) {
      try {
        const res = await graphGetJson(
          `${GRAPH_BASE}/${GRAPH_VERSION}/${encodeURIComponent(subWabaId)}/subscribed_apps`,
          accessToken,
          undefined,
          appSecret ?? undefined,
        );
        subscription = {
          subscribed: isAppSubscribedToWaba(res, config.appId),
          // any-app fallback when no appId is stored — an honest "probably"
          // rather than a firm "yes"; see isAppSubscribedToWaba.
          scopedToApp: Boolean(config.appId),
        };
      } catch (err) {
        this.logger.warn(
          `[${workspaceId}] could not read WABA subscription: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return {
      phoneNumberId: config.phoneNumberId ?? null,
      displayPhoneNumber: config.displayPhoneNumber ?? null,
      // Meta's own WABA id, never our internal cuid — this is a public DTO.
      // `null` (not `""`) when unlinked: the empty string used to mean "unknown"
      // and made every downstream guard treat it as "no opinion".
      wabaId: conn?.wabaAccount?.externalWabaId ?? null,
      appId: config.appId ?? null,
      verifyToken,
      accessToken: accessToken !== null ? SECRET_SAVED_SENTINEL : null,
      appSecret: appSecret !== null ? SECRET_SAVED_SENTINEL : null,
      accessTokenSet: accessToken !== null,
      appSecretSet: appSecret !== null,
      credentialsUndecryptable,
      needsReconnect: conn?.needsReconnect ?? false,
      messagingTier: conn?.wabaAccount?.portfolio?.messagingTier ?? null,
      messagingDailyCap: conn?.wabaAccount?.portfolio?.messagingDailyCap ?? null,
      qualityRating: conn?.qualityRating ?? null,
      throughputLevel: conn?.throughputLevel ?? null,
      registrationStatus: conn?.registrationStatus ?? null,
      subscription,
      webhookRejection: recentWebhookRejection(
        conn?.lastWebhookRejectedAt ?? null,
        conn?.lastWebhookRejectReason ?? null,
      ),
    };
  }

  private tryDecrypt(value: string | null, field: string): string | null {
    if (!value) return null;
    try {
      return decryptSecret(value);
    } catch (err) {
      // GCM auth-tag mismatch or malformed envelope — most often ENCRYPTION_KEY
      // changed between write and read. Logged at warn (not error) because the
      // UI handles this gracefully (auto-opens the credentials form).
      this.logger.warn(
        `could not decrypt ${field}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Validate credentials against Meta, then encrypt + persist + bust the
   * in-process credential cache so the next webhook / send picks up the
   * new values immediately instead of waiting out the TTL.
   *
   * Field choice on the validation call:
   *   `whatsapp_business_account_id` is NOT a field on the phone-number node
   *   and asking for it makes Meta reject the entire request with
   *   `(#100) Tried accessing nonexisting field`. WABA isn't needed for send
   *   or webhook receive; admins paste it separately for template management.
   */
  async updateConfig(
    workspaceId: string,
    input: UpdateWhatsappConfigInput,
  ): Promise<{
    config: {
      phoneNumberId: string;
      displayNumber: string | null;
      verifyToken: string;
    };
    /**
     * Non-fatal problems found while connecting — credentials that work but a
     * setup that will bite later (unverified WABA ownership, unregistered
     * number, declined display name, unsubscribed WABA). Each used to be a
     * silent server-side log line; the admin filling the form is the one
     * person who can act on them, so they go in the response.
     */
    warnings: string[];
  }> {
    const { phoneNumberId } = input;
    const warnings: string[] = [];

    // getConfig ships SECRET_SAVED_SENTINEL in place of stored plaintext, so an
    // untouched form can echo it back. Treat it as "not typed": the own-row →
    // shared precedence below then keeps what is already stored.
    const typedAccessToken =
      input.accessToken === SECRET_SAVED_SENTINEL ? undefined : input.accessToken;
    const typedAppSecret =
      input.appSecret === SECRET_SAVED_SENTINEL ? undefined : input.appSecret;

    // Source the access token (system-user) + App secret from the shared Meta
    // App connection unless overridden on this form.
    const meta = await getMetaConnection(workspaceId);
    // Precedence: what the operator typed → THIS ROW'S OWN stored credentials →
    // the shared Meta App.
    //
    // The middle term is load-bearing for multi-app workspaces. A workspace may
    // hold one number on the shared Meta app and another on a DIFFERENT app (the
    // webhook HMAC check already tries every account's own secret for exactly that
    // reason). Without it, ANY re-save of that second number — changing a label,
    // re-running the WABA check — silently overwrote its own app secret and token
    // with the shared app's. Meta then signs that account's webhooks with a secret
    // we no longer hold, so every inbound is dropped as forged, and its sends fail
    // on a token issued by the wrong app.
    const ownSecrets = ((
      await this.db.channelConnection.findUnique({
        where: {
          workspaceId_channel_externalAccountId: {
            workspaceId,
            channel: META_PROVIDER,
            externalAccountId: phoneNumberId,
          },
        },
        select: { secrets: true },
      })
    )?.secrets ?? {}) as MetaChannelSecrets;
    const ownAccessToken = this.tryDecrypt(ownSecrets.accessToken ?? null, "accessToken");
    const ownAppSecret = this.tryDecrypt(ownSecrets.appSecret ?? null, "appSecret");
    const accessToken =
      typedAccessToken?.trim() || ownAccessToken || meta?.systemUserToken || null;
    const appSecret = typedAppSecret?.trim() || ownAppSecret || meta?.appSecret || null;
    if (!accessToken || !appSecret) {
      throw new BadRequestException({
        error: "meta_not_configured",
        detail:
          "Set up your Meta App connection first (Settings → Meta App: App secret + system-user token), then connect WhatsApp.",
      });
    }

    let displayNumber: string | undefined;
    let verifiedName: string | undefined;
    let nameStatus: string | undefined;
    // Persisted alongside the identity fields below — the 2026-08-11 incident:
    // this was read, warned about once, and DROPPED, so the settings page said
    // "Connected" forever over a number whose every send failed.
    let registrationStatus: string | undefined;
    try {
      // One node read validates the credentials AND captures the number's
      // identity + readiness: `verified_name`/`name_status` (a NONE/EXPIRED
      // name voids the certificate) and `status`/`code_verification_status`
      // (an unregistered number saves cleanly but fails every send).
      // Signed with `appsecret_proof` (an app with "Require app secret" ON
      // rejects unsigned server calls); token and secret resolve through the
      // same typed → own-row → shared precedence, so the pair always belongs
      // to one app in a coherent setup.
      const res = await fetch(
        withAppsecretProof(
          `${GRAPH_BASE}/${GRAPH_VERSION}/${encodeURIComponent(phoneNumberId)}` +
            `?fields=display_phone_number,verified_name,name_status,code_verification_status,status`,
          accessToken,
          appSecret,
        ),
        {
          headers: { authorization: `Bearer ${accessToken}` },
          // Hard per-call timeout — the only outbound api fetch that doesn't go
          // through metaFetch/safeFetch. Without it, a Graph endpoint that
          // connects but never responds would pin a connection + pg pool slot
          // until the 300s server requestTimeout reaps it. AbortError surfaces
          // via the catch below as a clean BadGateway.
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!res.ok) {
        const body = await res.text();
        throw new BadRequestException({
          error: "meta_rejected_credentials",
          status: res.status,
          detail: body.slice(0, 500),
        });
      }
      const data = (await res.json()) as {
        display_phone_number?: string;
        verified_name?: string;
        name_status?: string;
        code_verification_status?: string;
        status?: string;
      };
      displayNumber = data.display_phone_number;
      verifiedName = data.verified_name;
      nameStatus = data.name_status;
      // Registration readiness. `status` must be CONNECTED to message; a number
      // never registered for Cloud API reads DISCONNECTED/PENDING here. Warn,
      // don't block: the admin may be mid-setup, and the guarded /register
      // endpoint below is the fix — UNLESS the number hasn't completed OTP
      // ownership verification yet. Meta: "Before you can register your
      // business phone number you must first verify its ownership", so telling
      // a NOT_VERIFIED admin to press Register sent them into guaranteed
      // failures that each burn one of Meta's 10-per-72h registration
      // attempts (doc-review 2026-08-11; the field was fetched and dropped).
      const status = data.status?.toUpperCase();
      registrationStatus = status;
      const codeVerification = data.code_verification_status?.toUpperCase();
      if (status && status !== "CONNECTED") {
        if (codeVerification === "NOT_VERIFIED") {
          warnings.push(
            `This number's Cloud API status is ${status} and it has NOT completed ownership ` +
              `verification. FIRST verify it in WhatsApp Manager → Phone numbers (SMS or ` +
              `voice code to the number) — registering before that fails and wastes one of ` +
              `Meta's 10 registration attempts per 72h. Then use "Register number".`,
          );
        } else {
          warnings.push(
            `This number's Cloud API status is ${status} — sends will fail until it is ` +
              `registered. Use "Register number" (two-step PIN) or register it in WhatsApp Manager.`,
          );
        }
      }
      const ns = nameStatus?.toUpperCase();
      if (ns === "DECLINED" || ns === "EXPIRED" || ns === "NONE") {
        warnings.push(
          `The display name for this number is ${ns} at Meta — without an approved ` +
            `name the number has no certificate and cannot be (re)registered. Fix it in ` +
            `WhatsApp Manager → Phone numbers.`,
        );
      }
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error("meta validation failed", err);
      throw new BadGatewayException({
        error: "could_not_reach_meta_to_validate",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    // TWO reads, because the fields here have two different scopes and one
    // read cannot serve both:
    //   - verifyToken / appId are WORKSPACE-shared (one Meta App, one callback
    //     URL), so the default account is a fine fallback source.
    //   - wabaId is PER-ACCOUNT. Sourcing its "leave unchanged" value from the
    //     default account cross-contaminates every other number: `resyncChannels`
    //     (meta.service.ts) re-saves EVERY connected number with only its
    //     phoneNumberId after a Meta App credential change, so a workspace with
    //     number A (WABA-1, default) + number B (WABA-2) would stamp WABA-1 onto
    //     B — pointing B's template catalog at A's account. Read it from the row
    //     actually being written.
    const [existing, self] = await Promise.all([
      this.db.channelConnection.findFirst({
        where: { workspaceId, channel: META_PROVIDER, isDefault: true },
        select: { config: true },
      }),
      this.db.channelConnection.findUnique({
        where: {
          workspaceId_channel_externalAccountId: {
            workspaceId,
            channel: META_PROVIDER,
            externalAccountId: phoneNumberId,
          },
        },
        select: { config: true, wabaAccount: { select: { externalWabaId: true } } },
      }),
    ]);
    const existingConfig = (existing?.config ?? {}) as MetaChannelConfig;
    // "Leave unchanged" must read the row we are ABOUT TO WRITE, never the
    // default's — re-saving number B with only its phoneNumberId would otherwise
    // stamp number A's WABA onto B and point B's template catalog at A's catalog.
    const selfWabaId = self?.wabaAccount?.externalWabaId ?? null;

    // Verify-token resolution order:
    //   1. Explicit value from input (legacy callers / future re-rotate UI).
    //   2. Existing connection value (pre-minted by getConfig on first load,
    //      or set on a prior save). Stable across re-saves — critical so
    //      Meta's stored verify token stays valid when an admin clicks
    //      "Validate & save" again.
    //   3. Fresh random (defensive — getConfig pre-mints, so this branch
    //      shouldn't fire in practice).
    const verifyToken =
      input.verifyToken ||
      meta?.verifyToken ||
      existingConfig.verifyToken ||
      randomBytes(24).toString("hex");

    // Phone-number uniqueness across WORKSPACES. A WhatsApp number can only be
    // connected once platform-wide: Meta delivers its webhooks to whichever app
    // is subscribed, so two workspaces claiming one number means one of them
    // silently receives nothing.
    //
    // Matched on `externalAccountId` — the promoted, indexed column that IS the
    // account identity — with the legacy `config.phoneNumberId` JSON path kept
    // as a second arm. The JSON path alone (what this used to be) missed any row
    // where only the column was set, which would have let the same number be
    // connected twice and produced exactly the silent-drop failure above. The
    // column alone would miss pre-multi-account rows. Both arms, until a
    // backfill makes the legacy one provably empty.
    const clash = await this.db.channelConnection.findFirst({
      where: {
        channel: META_PROVIDER,
        workspaceId: { not: workspaceId },
        OR: [
          { externalAccountId: phoneNumberId },
          { config: { path: ["phoneNumberId"], equals: phoneNumberId } },
        ],
      },
      select: { id: true, workspace: { select: { name: true, organizationId: true } } },
    });
    if (clash) {
      // Name the workspace ONLY when it belongs to the caller's own
      // organization. Same-org is the overwhelmingly common case and the
      // message is otherwise unactionable — you cannot disconnect a number you
      // can't find. Across orgs it stays deliberately vague: which tenant holds
      // a number is another tenant's configuration.
      const caller = await this.db.workspace.findUnique({
        where: { id: workspaceId },
        select: { organizationId: true },
      });
      const sameOrg =
        !!caller && clash.workspace?.organizationId === caller.organizationId;
      throw new ConflictException({
        error: "phone_number_already_connected",
        detail: sameOrg
          ? `This number is already connected to the "${clash.workspace?.name}" workspace. ` +
            `Disconnect it there first, or connect a different number.`
          : "This phone number is already connected to another account on this platform.",
      });
    }

    // WABA-ownership guard. `wabaId` drives template sync (fetchTemplates hits
    // `/{wabaId}/message_templates`), so a wabaId that doesn't own this phone
    // number silently imports the WRONG account's templates — the exact failure
    // where a real customer connection showed Meta's shared `jaspers_market_*`
    // sample templates from a test WABA. Optional-update semantics mean a stale
    // wabaId can also survive a phone-number/token change untouched, so we
    // validate the RESOLVED value on every save that carries one, not just when
    // the field itself changed.
    // `selfWabaId`, not the default's — see the two-read note above. On a first
    // connect `self` is null, so an omitted wabaId correctly stays unset rather
    // than inheriting a sibling number's.
    const nextWabaId =
      input.wabaId === undefined ? (selfWabaId ?? undefined) : input.wabaId || undefined;
    if (nextWabaId) {
      const wabaWarning = await this.assertWabaOwnsNumber(
        nextWabaId,
        phoneNumberId,
        accessToken,
        appSecret,
      );
      if (wabaWarning) warnings.push(wabaWarning);
    }

    // Upsert the WABA row and point this number at it. `externalWabaId` is
    // GLOBALLY unique — Meta delivers a WABA's webhooks to whichever app is
    // subscribed, so two workspaces claiming one WABA means one silently receives
    // nothing, and under the app-level callback it would route one tenant's
    // messages into another tenant's inbox. So a cross-workspace claim is refused
    // outright rather than silently accepted.
    let wabaAccountId: string | null = null;
    if (nextWabaId) {
      const foreign = await this.db.whatsappBusinessAccount.findUnique({
        where: { externalWabaId: nextWabaId },
        select: { id: true, workspaceId: true },
      });
      if (foreign && foreign.workspaceId !== workspaceId) {
        throw new ConflictException({
          error: "waba_already_connected",
          detail:
            "This WhatsApp Business Account is already connected to another workspace. " +
            "Meta delivers a WABA's webhooks to a single subscribed app, so it cannot be " +
            "shared — disconnect it there first.",
        });
      }
      wabaAccountId =
        foreign?.id ??
        (
          await this.db.whatsappBusinessAccount.create({
            data: { workspaceId, externalWabaId: nextWabaId },
            select: { id: true },
          })
        ).id;

      // Meta's REGISTERED-NUMBER CAP. A new business portfolio may register 2
      // business phone numbers; business verification (or reaching a 2,000
      // messaging limit) raises it to 20, announced on `business_capability_update`.
      //
      // Refusing (rather than warning) is right here even though the standing rule
      // is "a stale local copy must never block a send Meta would accept": our
      // count is a LOWER bound on Meta's registered numbers, so `count >= cap` is
      // provable, not estimated — those numbers exist and we send on them. The
      // (cap+1)th registration is a guaranteed Meta failure, so refusing with the
      // documented remedy beats failing opaquely later.
      const capWarning = await this.assertPortfolioNumberCap(
        workspaceId,
        wabaAccountId,
        phoneNumberId,
      );
      if (capWarning) warnings.push(capWarning);
    }

    // appId is shared — source it from the Meta App connection (used for
    // template header-media upload); a pasted value or existing one overrides.
    // When NOTHING supplies it, learn it from the token itself (`/app` resolves
    // to the issuing app): without a stored appId, `isAppSubscribedToWaba`
    // degrades to any-app, so a WABA shared with another BSP reads "subscribed"
    // while our app receives nothing. One extra Graph read, connect-time only;
    // best-effort (null leaves the field absent, the sweeper backfills later).
    const resolvedAppId =
      input.appId?.trim() ||
      meta?.appId ||
      existingConfig.appId ||
      (await fetchTokenAppId(accessToken, GRAPH_VERSION, appSecret ?? undefined)) ||
      undefined;
    const newConfig = pruneUndefined<MetaChannelConfig>({
      phoneNumberId,
      verifyToken,
      displayPhoneNumber: displayNumber ?? undefined,
      // NO wabaId here. It used to live in this JSON *and* in a column, with the
      // send-config loader reading the JSON while template scoping read the column
      // — two copies of one fact that could drift. The `wabaAccountId` FK is the
      // single authority and the loader joins it.
      appId: resolvedAppId,
    });
    // Encrypted at rest with the app-wide ENCRYPTION_KEY (lib/crypto/envelope.ts).
    // Read paths (getMetaSendConfig / getMetaWebhookConfig) decrypt transparently.
    const newSecrets: MetaChannelSecrets = {
      accessToken: encryptSecret(accessToken),
      appSecret: encryptSecret(appSecret),
    };

    // Keyed on the ACCOUNT (phone-number id), not just the channel: a workspace
    // may now hold several WhatsApp numbers, so re-pasting credentials for one
    // number must update THAT row rather than overwrite a sibling number.
    const savedConnection = await this.db.channelConnection.upsert({
      where: {
        workspaceId_channel_externalAccountId: {
          workspaceId,
          channel: META_PROVIDER,
          externalAccountId: phoneNumberId,
        },
      },
      create: {
        workspaceId,
        channel: META_PROVIDER,
        externalAccountId: phoneNumberId,
        wabaAccountId,
        // The number's Meta-verified identity, captured by the node read above.
        verifiedName: verifiedName ?? null,
        nameStatus: nameStatus ?? null,
        registrationStatus: registrationStatus ?? null,
        // First account on this channel becomes the send default.
        isDefault: !(await this.db.channelConnection.count({
          where: { workspaceId, channel: META_PROVIDER },
        })),
        config: newConfig as Prisma.InputJsonValue,
        secrets: newSecrets as Prisma.InputJsonValue,
        isActive: true,
      },
      update: {
        wabaAccountId,
        // Refresh identity on every save; only overwrite with real values so a
        // Meta hiccup can't blank a stored name (the webhook keeps it live).
        ...(verifiedName !== undefined ? { verifiedName } : {}),
        ...(nameStatus !== undefined ? { nameStatus } : {}),
        ...(registrationStatus !== undefined ? { registrationStatus } : {}),
        config: newConfig as Prisma.InputJsonValue,
        secrets: newSecrets as Prisma.InputJsonValue,
        isActive: true,
        // A fresh token clears any prior expired-token (Graph 190) flag.
        needsReconnect: false,
        lastAuthErrorAt: null,
        // …and the last account-level alert: a deliberate re-connect is the
        // operator saying "I've dealt with it" (policyViolation's posture).
        lastAccountAlert: Prisma.DbNull,
      },
      select: { id: true },
    });

    // Clean up the verify-token placeholder getConfig pre-minted (keyed on
    // "") and guarantee THIS real account is the sole active default — otherwise
    // webhook + default-send config resolve to the dead placeholder and drop all
    // inbound. See normalizeDefaultAccount.
    await normalizeDefaultAccount(workspaceId, META_PROVIDER, phoneNumberId);

    invalidateProviderConfig(workspaceId);
    invalidateWabaAnalytics(workspaceId);

    // A reconnect can mint a brand-new ChannelConnection row (new id/createdAt).
    // Publish catalog_changed so the outbound-webhooks subscriber flushes its
    // per-team channelCache — otherwise webhook payloads keep stamping the old
    // connection's id. Scope-agnostic on the server side; the client's template
    // view (whose availability tracks the connection) refreshes too.
    await this.bus.publish({
      type: "team.catalog_changed",
      workspaceId,
      scope: "whatsapp-templates",
    });

    // Reconnecting WhatsApp resumes any broadcasts parked `paused` because creds
    // were missing/expired at fire time — so the detail page's "fix the
    // connection and it will auto-resume" is true on a stable box, not just
    // after a deploy. Fire-and-forget; per-recipient CAS makes resume
    // double-send-safe.
    void resumePausedBroadcastsForTeam(workspaceId).catch((err) => {
      this.logger.warn(
        `failed to resume paused broadcasts after WhatsApp settings save for team ${workspaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });

    // Pull the number's messaging-limit tier / quality / throughput now so a
    // large template broadcast can be gated on real capacity immediately after
    // connecting (before the first quality webhook arrives). Fire-and-forget +
    // best-effort — a fetch failure just leaves the snapshot null (ungated).
    // Poll THE ROW JUST SAVED: by workspace alone this resolved the default
    // account, so connecting a second number polled the first one and the new
    // number never got a snapshot (or a portfolio link) until the sweeper.
    void fetchWhatsappHealthFromGraph(workspaceId, savedConnection.id).catch((err) => {
      this.logger.warn(
        `failed to fetch WhatsApp messaging health after settings save for team ${workspaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });

    // Assert the WABA↔app webhook subscription — the WhatsApp twin of the
    // Pages outage this product already shipped a fix for (zero inbound with
    // valid credentials; see meta-waba-subscription.ts). Awaited (one Graph
    // POST+GET) because its warning belongs in THIS response: the admin at the
    // connect form is the person who can fix it.
    if (nextWabaId) {
      const sub = await ensureWabaSubscribed(
        nextWabaId,
        accessToken,
        GRAPH_VERSION,
        // Scoped to OUR app: a WABA shared with another BSP reads back non-empty
        // whether or not our subscription stuck. See isAppSubscribedToWaba.
        newConfig.appId,
        appSecret,
      );
      if (!sub.ok) {
        warnings.push(
          `Couldn't confirm this app is subscribed to the WABA's webhooks (${sub.error}). ` +
            `Without the subscription NO inbound messages arrive: in the Meta App ` +
            `dashboard → WhatsApp → Configuration, subscribe the app and tick "messages".`,
        );
      }
    }

    return {
      config: {
        phoneNumberId,
        displayNumber: displayNumber ?? null,
        verifyToken,
      },
      warnings,
    };
  }

  /**
   * Confirm `wabaId` actually owns `phoneNumberId` before we persist it.
   * Meta's phone-number node doesn't expose its parent WABA (asking for
   * `whatsapp_business_account_id` there 400s — see updateConfig above), so we
   * go the other way: list the WABA's phone numbers and check membership.
   *
   * A CONFIRMED mismatch (Meta answered, number absent) is a hard reject — this
   * is the "pasted a different/test WABA id" bug. If Meta can't be reached or
   * the token can't read the WABA, we DON'T block the save: a token without
   * `whatsapp_business_management` can still send, and the reconciling template
   * sync + send-time errors surface a genuinely bad wabaId without stranding
   * the whole connection form on a permission quirk.
   */
  /**
   * Re-poll Meta for this workspace's WhatsApp health and return the fresh
   * snapshot.
   *
   * Awaits the fetch (unlike the fire-and-forget call on connect) because the
   * admin pressed a button and is watching: returning a stale snapshot with an
   * old "as of" timestamp would read as "the button doesn't work". A Graph
   * failure surfaces as `refreshed: false` with the LAST GOOD snapshot rather
   * than an error page — the stored numbers are still the truth we have, and
   * blanking them would be a worse answer than an honest "couldn't refresh".
   */
  async refreshHealth(
    workspaceId: string,
    accountId?: string | null,
  ): Promise<{
    refreshed: boolean;
    messagingHealthUpdatedAt: string | null;
  }> {
    // Resolve WHICH number to poll up front. With several active numbers a
    // workspace-only poll refuses (`account-unresolved`) and silently no-ops —
    // the admin's button would "work" while refreshing nothing. No accountId
    // means the default number (the panel's headline figures).
    const target = await this.db.channelConnection.findFirst({
      where: accountId
        ? { id: accountId, workspaceId, channel: META_PROVIDER }
        : { workspaceId, channel: META_PROVIDER, isDefault: true },
      select: { id: true },
    });
    if (accountId && !target) {
      throw new NotFoundException({ error: "account_not_found" });
    }
    let refreshed = true;
    try {
      await fetchWhatsappHealthFromGraph(workspaceId, target?.id ?? null);
    } catch (err) {
      this.logger.warn(`whatsapp health refresh failed for ${workspaceId}: ${err}`);
      refreshed = false;
    }
    const health = await getWhatsappHealth(workspaceId, target?.id ?? null);
    return {
      refreshed,
      messagingHealthUpdatedAt: health?.messagingHealthUpdatedAt?.toISOString() ?? null,
    };
  }

  /**
   * Window bounds for a template-analytics read.
   *
   * Clamped to Meta's 90-day lookback rather than passed through: an
   * out-of-range start returns an EMPTY set, not an error, so an unclamped
   * request would report "no data" for a template that has plenty.
   */
  private analyticsWindow(daysRaw: string | undefined): { start: Date; end: Date } {
    const parsed = Number.parseInt(daysRaw ?? "", 10);
    const days = Number.isFinite(parsed) ? Math.min(90, Math.max(1, parsed)) : 30;
    const end = new Date();
    return { start: new Date(end.getTime() - days * 86_400_000), end };
  }

  /**
   * Resolve one of OUR template ids to Meta's, plus the WABA it lives under.
   *
   * The WABA matters on a multi-account workspace: `template_analytics` is a
   * field on the WABA node, so a fetch made with the DEFAULT account's WABA
   * returns nothing for a template belonging to a second one.
   */
  private async templateRef(
    workspaceId: string,
    templateId: string,
  ): Promise<{ externalId: string; wabaId: string; wabaAccountId: string }> {
    const row = await this.db.messageTemplate.findFirst({
      where: { id: templateId, workspaceId },
      select: {
        externalId: true,
        wabaAccountId: true,
        wabaAccount: { select: { externalWabaId: true } },
      },
    });
    if (!row) throw new NotFoundException({ error: "template_not_found" });
    if (!row.externalId) {
      // A locally-created template awaiting Meta approval has no id there yet,
      // so there is nothing to look up — say that rather than returning an
      // empty series that reads as "nobody engaged".
      throw new BadRequestException({ error: "template_not_synced" });
    }
    // Both ids: Meta's `wabaId` for the user-facing analytics copy, our FK for
    // resolving the account that owns this catalog. Neither can be absent — the FK
    // is NOT NULL, which is what retired the old `""` "no opinion" sentinel that
    // let any account operate on any template.
    return {
      externalId: row.externalId,
      wabaId: row.wabaAccount.externalWabaId,
      wabaAccountId: row.wabaAccountId,
    };
  }

  /** Stored daily rollup for one template. No Graph call. */
  async templateAnalytics(workspaceId: string, templateId: string, daysRaw?: string) {
    const { externalId, wabaAccountId } = await this.templateRef(workspaceId, templateId);
    const { start, end } = this.analyticsWindow(daysRaw);
    const result = await readTemplateAnalytics(workspaceId, externalId, start, end);
    // Meta records NOTHING before the insights switch was flipped (no
    // backfill), and serves EU/Japan accounts nothing at all. Same two facts
    // the campaign report carries, resolved by the same function — the drawer
    // says them too, or an empty chart on an old template reads as a broken
    // feature.
    return { ...result, ...(await templateAnalyticsAccountContext(workspaceId, wabaAccountId)) };
  }

  /** Pull fresh figures from Meta for one template, then store them. */
  async refreshTemplateAnalytics(
    workspaceId: string,
    templateId: string,
    daysRaw?: string,
  ) {
    const { externalId, wabaAccountId } = await this.templateRef(workspaceId, templateId);
    const { start, end } = this.analyticsWindow(daysRaw);
    return refreshTemplateAnalytics(workspaceId, {
      templateExternalIds: [externalId],
      start,
      end,
      wabaAccountId,
    });
  }

  /**
   * Toggle button-click tracking on one template (Meta's
   * `cta_url_link_tracking_opted_out`). `enabled` speaks the operator's
   * language — "track clicks: on/off" — and is inverted to Meta's opt-OUT
   * flag here, in exactly one place.
   *
   * Meta requires the template's CURRENT category on the request; it is read
   * from the stored row and passed through verbatim, because sending a
   * different value flips the template back into review.
   */
  async setTemplateLinkTracking(
    workspaceId: string,
    templateId: string,
    enabled: boolean,
  ): Promise<{ linkTrackingOptedOut: boolean }> {
    const row = await this.db.messageTemplate.findFirst({
      where: { id: templateId, workspaceId },
      select: {
        externalId: true,
        wabaAccountId: true,
        category: true,
      },
    });
    if (!row) throw new NotFoundException({ error: "template_not_found" });
    if (!row.externalId) {
      throw new BadRequestException({ error: "template_not_synced" });
    }

    const config = await this.templateOpConfig(workspaceId, {
      wabaAccountId: row.wabaAccountId,
    });
    const provider = getMetaProvider();
    if (!provider.setTemplateLinkTracking) {
      throw new HttpException({ error: "provider_does_not_support_link_tracking" }, 501);
    }
    const optedOut = !enabled;
    try {
      await provider.setTemplateLinkTracking(
        { externalId: row.externalId, optedOut, category: row.category },
        config,
      );
    } catch (err) {
      this.throwIfMissingWaba(err);
      this.throwIfMetaSendError(err);
      this.logger.error("template link-tracking toggle failed", err);
      throw new BadGatewayException({
        error: "link_tracking_toggle_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    // Mirror locally only AFTER Meta accepted — the stored flag is what the
    // insights UI reads to explain an empty click series.
    await this.db.messageTemplate.updateMany({
      where: { id: templateId, workspaceId },
      data: { linkTrackingOptedOut: optedOut },
    });
    return { linkTrackingOptedOut: optedOut };
  }

  /**
   * Head-to-head comparison of two templates.
   *
   * Every one of Meta's constraints is checked HERE, before the Graph call,
   * because Meta answers a violation with an empty result rather than an error —
   * an unchecked request renders as "these two templates perform identically",
   * which is a confident wrong answer rather than a missing one.
   */
  async compareTemplates(
    workspaceId: string,
    templateId: string,
    againstId: string,
    daysRaw?: string,
  ): Promise<{
    days: number;
    /** Our template ids, best (lowest block rate) first. Empty when Meta had no
     *  verdict — see `enoughData`. */
    blockRateOrder: string[];
    sends: Array<{ templateId: string; count: number }>;
    topBlockReasons: Array<{ templateId: string; reason: string }>;
    /** False when Meta returned nothing, which almost always means one of the
     *  two templates is under the 1,000-send threshold for this window. */
    enoughData: boolean;
  }> {
    if (templateId === againstId) {
      throw new BadRequestException({
        error: "same_template",
        detail: "Pick a different template to compare against.",
      });
    }

    // Meta supports exactly these lookback windows; anything else silently
    // returns nothing, so reject rather than pass it through.
    const parsed = Number.parseInt(daysRaw ?? "", 10);
    const days = COMPARISON_WINDOWS.includes(parsed as (typeof COMPARISON_WINDOWS)[number])
      ? parsed
      : 30;

    const [a, b] = await Promise.all([
      this.templateRef(workspaceId, templateId),
      this.templateRef(workspaceId, againstId),
    ]);
    // Comparison is a WABA-scoped operation: Meta cannot compare across
    // accounts, and asking it to just yields an empty result.
    if (a.wabaAccountId !== b.wabaAccountId) {
      throw new BadRequestException({
        error: "different_waba",
        detail:
          "Both templates must belong to the same WhatsApp Business Account to be compared.",
      });
    }

    // Credentials for the WABA both templates live under (verified equal
    // above) — the default account's edge is the wrong one on a two-WABA
    // workspace, and Meta answers a wrong-WABA compare with an empty result
    // that reads as "these perform identically".
    const config = await this.templateOpConfig(workspaceId, {
      wabaAccountId: a.wabaAccountId,
    });
    const provider = getMetaProvider();
    if (!provider.compareTemplates) {
      throw new HttpException({ error: "provider_does_not_support_comparison" }, 501);
    }

    const end = new Date();
    const start = new Date(end.getTime() - days * 86_400_000);
    let result;
    try {
      result = await provider.compareTemplates(
        {
          templateExternalId: a.externalId,
          againstExternalIds: [b.externalId],
          start,
          end,
        },
        config,
      );
    } catch (err) {
      this.throwIfMissingWaba(err);
      this.throwIfMetaSendError(err);
      this.logger.error("template comparison failed", err);
      throw new BadGatewayException({
        error: "comparison_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    // Translate Meta's ids back to ours so the client never sees a provider id.
    const toLocal = new Map([
      [a.externalId, templateId],
      [b.externalId, againstId],
    ]);
    const local = (externalId: string) => toLocal.get(externalId);

    return {
      days,
      blockRateOrder: result.blockRateOrder
        .map(local)
        .filter((id): id is string => id !== undefined),
      sends: result.sends
        .map((s) => ({ templateId: local(s.templateExternalId), count: s.count }))
        .filter((s): s is { templateId: string; count: number } => s.templateId !== undefined),
      topBlockReasons: result.topBlockReasons
        .map((r) => ({ templateId: local(r.templateExternalId), reason: r.reason }))
        .filter((r): r is { templateId: string; reason: string } => r.templateId !== undefined),
      enoughData: result.sends.length > 0,
    };
  }

  /**
   * Enforce Meta's REGISTERED-NUMBER CAP for the portfolio this WABA belongs to.
   *
   * Meta caps a NEW business portfolio at 2 registered business phone numbers;
   * becoming verified — or reaching a 2,000 messaging limit — raises it to 20, and
   * the new value arrives on the `business_capability_update` webhook as
   * `max_phone_numbers_per_business`.
   *
   * Returns a WARNING string when the portfolio is one number from its cap, throws
   * 409 when it is already at it, and returns null otherwise. An unknown cap means
   * UNGATED — the same posture `messagingDailyCap` takes.
   *
   * Why this one REFUSES rather than warns, when the standing rule is "a stale
   * local copy must never block a send Meta would accept": our count is a LOWER
   * bound on the numbers Meta has registered (it cannot see numbers registered
   * outside this app), so `count >= cap` is provable rather than estimated. The
   * (cap+1)th registration is a guaranteed Meta failure, and refusing with the
   * documented remedy is more actionable than letting it fail opaquely.
   */
  private async assertPortfolioNumberCap(
    workspaceId: string,
    wabaAccountId: string,
    phoneNumberId: string,
  ): Promise<string | null> {
    const waba = await this.db.whatsappBusinessAccount.findFirst({
      where: { id: wabaAccountId, workspaceId },
      select: { portfolio: { select: { id: true, maxPhoneNumbers: true } } },
    });
    const cap = waba?.portfolio?.maxPhoneNumbers ?? null;
    const portfolioId = waba?.portfolio?.id;
    if (!cap || !portfolioId) return null;

    // Count REGISTERED numbers across every WABA in the portfolio (the cap is
    // portfolio-scoped, not WABA-scoped). Exclude the credential-less placeholder
    // and — critically — this very number: a re-save is not a new registration.
    const registered = await this.db.channelConnection.count({
      where: {
        workspaceId,
        channel: META_PROVIDER,
        isActive: true,
        externalAccountId: { not: "" },
        NOT: { externalAccountId: phoneNumberId },
        wabaAccount: { portfolioId },
      },
    });
    if (registered >= cap) {
      throw new ConflictException({
        error: "number_cap_reached",
        detail:
          `This business portfolio has reached Meta's cap of ${cap} registered phone ` +
          `numbers. Get the business verified (or reach a 2,000 messaging limit) and ` +
          `Meta raises the cap to 20 automatically.`,
      });
    }
    if (registered === cap - 1) {
      return (
        `This is the last phone number this business portfolio can register ` +
        `(Meta's cap is ${cap}). Business verification raises it to 20.`
      );
    }
    return null;
  }

  private async assertWabaOwnsNumber(
    wabaId: string,
    phoneNumberId: string,
    accessToken: string,
    appSecret?: string,
  ): Promise<string | null> {
    // `listWabaPhoneNumberIds` is the one definition of this read, shared with the
    // health sweeper's re-parent probe (which asks the same question on a schedule).
    // Sharing it fixed two things this local copy had: it stopped at `limit=200`
    // with no paging, so a WABA above Meta's documented expanded limit could refuse
    // a number it really owns; and it bypassed `withAppsecretProof`.
    const owned = await listWabaPhoneNumberIds(wabaId, accessToken, GRAPH_VERSION, appSecret);
    if (!owned.ok) {
      // A skip is not silent: 401/403 means the token can't read the WABA
      // (`whatsapp_business_management` missing) — ownership is unverified AND
      // template sync + portfolio discovery will be degraded, which the admin
      // standing at the form can actually fix.
      this.logger.warn(
        `skipping waba-ownership check for ${wabaId}/phone_numbers: ${owned.error}`,
      );
      return /graph GET 40[13]\b/.test(owned.error)
        ? "Your access token can't read this WhatsApp Business Account " +
            "(whatsapp_business_management scope missing?). WABA ownership was NOT " +
            "verified, and template sync + business-portfolio discovery will be " +
            "degraded until the token can read it."
        : "Couldn't verify this WABA owns the number; connected anyway. " +
            "If templates look wrong, re-check the WABA ID.";
    }
    if (owned.ids.length === 0 && owned.rowsSeen > 0) {
      // Numbers came back in a shape we could not read. Refusing the connect here
      // would block every onboarding on a parser problem, so treat ownership as
      // unverified — the same posture as an unreadable token above.
      this.logger.warn(
        `waba-ownership check inconclusive: ${wabaId}/phone_numbers returned ` +
          `${owned.rowsSeen} row(s) with no readable id`,
      );
      return (
        "Couldn't read this WhatsApp Business Account's phone numbers, so WABA " +
        "ownership was NOT verified; connected anyway. If templates look wrong, " +
        "re-check the WABA ID."
      );
    }
    if (!owned.ids.includes(phoneNumberId)) {
      throw new BadRequestException({
        error: "waba_id_does_not_own_this_phone_number",
        detail:
          "This WhatsApp Business Account ID doesn't contain the phone number you connected — you've likely pasted the WABA ID of a different (e.g. test) account. In WhatsApp Manager → Account tools → Phone numbers, copy the WABA ID that owns this number.",
      });
    }
    return null;
  }

  /**
   * Register a connected number for Cloud API use (`POST /{id}/register` with
   * the two-step PIN). The lite version of Meta's registration flow: no
   * request_code/verify_code, no PIN storage — the admin already has the PIN
   * (or just set one in WhatsApp Manager), and an unregistered number is the
   * one connect-time warning they cannot fix from our UI any other way.
   */
  async registerNumber(
    workspaceId: string,
    input: { accountId: string; pin: string },
  ): Promise<{ ok: true }> {
    let config;
    try {
      config = await getMetaSendConfig(workspaceId, input.accountId);
    } catch {
      throw new BadRequestException({ error: "account_not_connected" });
    }
    // Meta budgets registration at 10 requests PER BUSINESS NUMBER in a 72h
    // moving window; the 11th locks the number out of registration for up to
    // 72h (registration guide). The per-user @RateLimit on the route cannot
    // see that budget — an admin re-trying a wrong PIN at 3/min exhausts it in
    // under four minutes. Count attempts per number in Redis (approximate
    // fixed window — stricter than Meta's moving window is fine, looser is
    // not) and refuse the 10th-plus with the real remedy. Fail-open on a
    // Redis outage: registration is rare and Meta enforces the true limit.
    try {
      const redis = getRedisConnection();
      const key = `wa-register-attempts:${config.phoneNumberId}`;
      const attempts = await redis.incr(key);
      if (attempts === 1) await redis.expire(key, 72 * 3600);
      if (attempts > 9) {
        throw new BadRequestException({
          error: "register_attempts_exhausted",
          detail:
            "You've used 9 of Meta's 10 registration attempts for this number in the current 72-hour window — we stop here so the final attempt isn't burned (the 11th locks registration for up to 72 hours). If the number already has two-step verification, the PIN must match it; if it doesn't, the PIN you enter here becomes its new two-step PIN. Also confirm the number completed ownership verification (OTP) in WhatsApp Manager before retrying later.",
        });
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      // Redis unavailable — proceed; Meta enforces the real budget.
    }
    let res: Response;
    try {
      res = await fetch(
        // Signed for the same reason as the connect-time validation above.
        withAppsecretProof(
          `${GRAPH_BASE}/${GRAPH_VERSION}/${encodeURIComponent(config.phoneNumberId)}/register`,
          config.accessToken,
          config.appSecret,
        ),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ messaging_product: "whatsapp", pin: input.pin }),
          signal: AbortSignal.timeout(20_000),
        },
      );
    } catch (err) {
      throw new BadGatewayException({
        error: "could_not_reach_meta",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    if (!res.ok) {
      // Meta's error names the actual problem (wrong PIN, name not approved,
      // number in use elsewhere) — surface it verbatim; inventing a friendlier
      // sentence here would hide the fix.
      const body = await res.text().catch(() => "");
      throw new BadRequestException({
        error: "register_failed",
        status: res.status,
        detail: body.slice(0, 500),
      });
    }
    // Registration flips the number's `status` to CONNECTED — refresh the
    // snapshot now so the settings panel reflects it without waiting a sweep.
    void fetchWhatsappHealthFromGraph(workspaceId, input.accountId).catch(() => undefined);
    return { ok: true };
  }

  /**
   * Wipe credentials but leave historical messages intact (multi-tenancy
   * rule #2 — integration toggles must not erase audit trail).
   */
  async disconnect(workspaceId: string, confirmAll?: boolean): Promise<void> {
    // Refuse an ambiguous blast radius; see the helper.
    await assertChannelDisconnectConfirmed(workspaceId, META_PROVIDER, confirmAll);
    // Gather the rows BEFORE the delete — they are the credential source for
    // the webhook-subscription release below, and gone afterwards.
    const departing = await this.db.channelConnection.findMany({
      where: { workspaceId, channel: META_PROVIDER },
      select: { secrets: true, wabaAccount: { select: { externalWabaId: true } } },
    });
    // Drop the connection row entirely (wipes creds + verify token, matching
    // the old "null every meta_* column" behavior). Historical messages are
    // untouched — they live on their own tables. deleteMany so a
    // not-yet-connected team is a no-op rather than a 404.
    await this.db.channelConnection.deleteMany({
      where: { workspaceId, channel: META_PROVIDER },
    });
    // Release every WABA subscription the channel held. The per-account
    // remove path has released since 2026-07-29; this channel-wide disconnect
    // never did — Meta kept POSTing every number's traffic, dropped as
    // `unknown_account` (2026-08-13). IOU-first like the remove path, so a
    // Graph failure leaves a durable retry (subscription-release-retry.ts).
    const byWaba = new Map<string, { accessToken?: string; appSecret?: string }>();
    for (const row of departing) {
      const wabaId = row.wabaAccount?.externalWabaId;
      const raw = (row.secrets ?? {}) as { accessToken?: string; appSecret?: string };
      if (!wabaId || !raw.accessToken || byWaba.has(wabaId)) continue;
      // Explicit PICK, not the cast object — the ledger must hold only the two
      // ciphertexts the release needs, never whatever else `secrets` may grow.
      byWaba.set(wabaId, {
        accessToken: raw.accessToken,
        ...(raw.appSecret ? { appSecret: raw.appSecret } : {}),
      });
    }
    for (const [wabaId, s] of byWaba) {
      const pendingId = await enqueuePendingRelease({
        workspaceId,
        channel: META_PROVIDER,
        externalObjectId: wabaId,
        secrets: s,
      });
      let accessToken: string | null = null;
      try {
        accessToken = decryptSecret(s.accessToken!);
      } catch {
        continue; // undecryptable — the IOU stays; the sweeper reports it
      }
      let appSecret: string | undefined;
      if (s.appSecret) {
        try {
          appSecret = decryptSecret(s.appSecret);
        } catch {
          appSecret = undefined;
        }
      }
      if (!appSecret) {
        appSecret = (await getMetaConnection(workspaceId))?.appSecret ?? undefined;
      }
      const released = await releaseWabaSubscription(
        wabaId,
        accessToken,
        GRAPH_VERSION,
        appSecret,
      );
      if (released.ok) await resolvePendingRelease(pendingId);
      else
        this.logger.warn(
          `[${workspaceId}] WABA ${wabaId} subscription release failed on disconnect ` +
            `(retry sweeper owns it): ${released.error}`,
        );
    }
    // Every portfolio row just lost all its connections (SetNull FK) — GC them
    // so a later reconnect starts clean instead of self-healing onto a stale
    // container.
    await gcOrphanWhatsappPortfolios(workspaceId);
    invalidateProviderConfig(workspaceId);
    invalidateWabaAnalytics(workspaceId);

    // Deleting the row leaves a stale id in the outbound-webhooks subscriber's
    // channelCache; catalog_changed flushes it (see updateConfig for the same
    // reasoning) so post-disconnect webhook payloads don't carry a dangling id.
    await this.bus.publish({
      type: "team.catalog_changed",
      workspaceId,
      scope: "whatsapp-templates",
    });
  }

  // -------------------------------------------------------------------------
  // Templates (any agent on team)
  // -------------------------------------------------------------------------

  /**
   * Cached templates + connection hints in one shot. Picker UI uses
   * `hasWabaId` / `connected` to decide between "go set up your WABA" vs
   * "no templates yet, click refresh" without a POST round-trip.
   */
  async listTemplates(
    workspaceId: string,
    accountId?: string,
    /** Case-insensitive exact match against the template's own LABELS. */
    label?: string,
  ): Promise<{
    templates: TemplateDto[];
    hasWabaId: boolean;
    hasAppId: boolean;
    connected: boolean;
  }> {
    // Scope to ONE account's catalogue when asked. Templates live on a WhatsApp
    // Business Account and can only be sent from a number under that same WABA,
    // so a composer bound to a specific number must not offer another account's
    // templates — Meta rejects those per-recipient with an opaque error.
    //
    // The WABA id is resolved HERE rather than sent by the client: the account
    // directory deliberately withholds it (it is account metadata, not display
    // data), and resolving it server-side keeps that boundary intact.
    let scopeWabaAccountId: string | null = null;
    if (accountId) {
      const account = await this.db.channelConnection.findFirst({
        where: { id: accountId, workspaceId, channel: META_PROVIDER },
        select: { wabaAccountId: true },
      });
      if (!account) {
        throw new NotFoundException({ error: "account_not_found" });
      }
      // An account with NO WABA linked has NO catalog, so it gets an empty list —
      // not "show everything". The old code treated the `""` sentinel as "no
      // opinion" and fell through to the whole workspace, which is how a number
      // ended up offering another WABA's templates in the picker.
      scopeWabaAccountId = account.wabaAccountId;
      if (!scopeWabaAccountId) {
        return { templates: [], hasWabaId: false, hasAppId: false, connected: true };
      }
    }

    // Label filter, resolved to ids first: labels dedupe case-insensitively,
    // so the match must too, and Prisma's array filters are exact-case only.
    const labelIds = label?.trim()
      ? await templateIdsWithLabel(this.db, workspaceId, label.trim())
      : null;

    const [rows, conn] = await Promise.all([
      this.db.messageTemplate.findMany({
        where: {
          workspaceId,
          ...(scopeWabaAccountId ? { wabaAccountId: scopeWabaAccountId } : {}),
          ...(labelIds ? { id: { in: labelIds } } : {}),
        },
        // Meta's own WABA id for the DTO — never our internal cuid.
        include: { wabaAccount: { select: { externalWabaId: true } } },
        orderBy: [{ status: "asc" }, { name: "asc" }, { language: "asc" }],
      }),
      this.db.channelConnection.findFirst({
        where: {
          workspaceId,
          channel: META_PROVIDER,
          ...(accountId ? { id: accountId } : { isDefault: true }),
        },
        select: { config: true, wabaAccountId: true },
      }),
    ]);
    const config = (conn?.config ?? {}) as MetaChannelConfig;
    return {
      templates: rows.map(toTemplateDto),
      hasWabaId: Boolean(conn?.wabaAccountId),
      hasAppId: Boolean(config.appId),
      connected: Boolean(config.phoneNumberId),
    };
  }

  /**
   * Force a sync from Meta. Idempotent locally — upsert by
   * `(workspaceId, name, language)`, then RECONCILE: drop local rows Meta no longer
   * returns for the connection's WABA. `fetchTemplates` pages fully or throws,
   * so a returned list is the complete, authoritative catalog for that WABA;
   * paused/disabled templates STAY in it (with a status), so pruning doesn't
   * make a paused template vanish-and-reappear (the reason this used to be
   * additive-only). A 60s grace window spares a template just created via
   * createTemplate that Meta's list hasn't propagated yet. This is what clears
   * stale rows left behind when a connection's wabaId is corrected — e.g. the
   * shared `jaspers_market_*` sample templates imported under an old test WABA.
   */
  async syncTemplates(
    workspaceId: string,
    accountId?: string | null,
  ): Promise<{
    templates: TemplateDto[];
    syncedCount: number;
  }> {
    // Fail fast with the actionable message when nothing is connected at all;
    // the sync itself is per-account and fail-soft inside syncTemplateCatalog.
    // The target account must be resolved EXPLICITLY: with several active
    // numbers a workspace-only credential load refuses (account-unresolved),
    // which turned the Sync button into a guaranteed 409 on every
    // multi-account workspace.
    const target =
      accountId ??
      (
        await this.db.channelConnection.findFirst({
          where: { workspaceId, channel: META_PROVIDER, isDefault: true },
          select: { id: true },
        })
      )?.id;
    const config = await this.requireSendConfig(workspaceId, target);
    if (!config.wabaId) {
      // The preflight is only allowed to speak for the account it checked.
      // `syncTemplateCatalog` below iterates EVERY active account's WABA on its
      // own, so a workspace whose DEFAULT number has no WABA id but whose
      // second number does was getting a hard 409 and could never sync \u2014
      // despite having a perfectly syncable catalog. Only refuse when NO
      // account can name a WABA. An explicitly targeted account still refuses,
      // because there the caller asked about that one specifically.
      const anyWaba = accountId
        ? 0
        : await this.db.channelConnection.count({
            where: {
              workspaceId,
              channel: META_PROVIDER,
              isActive: true,
              wabaAccountId: { not: null },
            },
          });
      if (anyWaba === 0) {
        throw new ConflictException({
          error: "waba_id_missing",
          detail:
            "Add your WhatsApp Business Account ID in Settings \u2192 WhatsApp to load templates.",
        });
      }
    }

    // Reconciliation lives in the domain layer (lib/templates/catalog-sync.ts)
    // so the periodic sweeper and the components-update webhook run the exact
    // same code path — including the per-WABA scoping that keeps a sync of one
    // account from deleting another account's catalog.
    const outcome = await syncTemplateCatalog(workspaceId);

    if (outcome.failed.length > 0) {
      this.logger.warn(
        `template sync for workspace ${workspaceId}: ${outcome.failed.length} WABA(s) unreachable \u2014 ` +
          outcome.failed.map((f) => `${f.wabaId}: ${f.error}`).join("; "),
      );
      // Every WABA failed: the operator pressed a button and nothing happened.
      // Say so, rather than returning a cheerful "0 synced".
      if (outcome.syncedCount === 0) {
        throw new BadGatewayException({
          error: "sync_failed",
          detail: outcome.failed[0]!.error.slice(0, 500),
        });
      }
    }
    if (outcome.prunedCount > 0) {
      this.logger.log(
        `template sync for workspace ${workspaceId} pruned ${outcome.prunedCount} stale template(s)`,
      );
    }
    const rows = await this.db.messageTemplate.findMany({
      where: {
        workspaceId,
        // An account-scoped sync answers with that account's catalogue — the
        // caller (reply box, composer) feeds this straight into its picker, so an
        // unscoped list would suddenly show another WABA's templates.
        //
        // EXACT account scoping. This used to be `{ in: [config.wabaId, ""] }`,
        // which folded every legacy/unknown-WABA row into whichever account was
        // asked about. The `""` sentinel is gone and the FK is NOT NULL, so the
        // scope is simply "this account's WABA".
        ...(accountId && config.wabaAccountId
          ? { wabaAccountId: config.wabaAccountId }
          : {}),
      },
      // Meta's own WABA id for the DTO — never our internal cuid.
      include: { wabaAccount: { select: { externalWabaId: true } } },
      orderBy: [{ status: "asc" }, { name: "asc" }, { language: "asc" }],
    });

    // Tell every tab — including the triggering agent — that the cached
    // catalog moved, so two admins watching /settings/whatsapp don't see
    // different lists until one navigates.
    await this.bus.publish({
      type: "team.catalog_changed",
      workspaceId,
      scope: "whatsapp-templates",
    });

    return {
      templates: rows.map(toTemplateDto),
      syncedCount: outcome.syncedCount,
    };
  }

  /**
   * Create a template on Meta + upsert the local cache row. We don't edit
   * existing templates — Meta restricts what's editable on APPROVED and
   * forbids edits on PENDING, so the UI hides "edit" and asks for
   * delete + recreate. We also don't validate Meta's per-category quirks:
   * Meta's own error messages are far more informative than anything we'd
   * reimplement, so we surface them verbatim as 422.
   */
  async createTemplate(
    workspaceId: string,
    raw: unknown,
    /** Which number's WABA the template is created under; omitted = default. */
    accountId?: string | null,
  ): Promise<{ templateId: string; status: string }> {
    const obj = (raw ?? {}) as Record<string, unknown>;

    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    const language = typeof obj.language === "string" ? obj.language.trim() : "";
    const category = parseCategory(obj.category);
    const components = parseComponents(obj.components);
    const variableBindings = obj.variableBindings ?? {};

    if (!/^[a-z0-9_]{1,512}$/.test(name)) {
      throw new BadRequestException({
        error: "invalid_name",
        detail:
          "Template name must be lowercase letters, digits and underscores only.",
      });
    }
    if (!language || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(language)) {
      throw new BadRequestException({
        error: "invalid_language",
        detail: "Use a Meta language code like en_US, fr, pt_BR.",
      });
    }
    if (!category) {
      throw new BadRequestException({
        error: "invalid_category",
        detail: "Pick marketing, utility or authentication.",
      });
    }
    if (components.length === 0) {
      throw new BadRequestException({
        error: "components_required",
        detail: "At least a BODY component is required.",
      });
    }
    const body = components.find((c) => c.type === "BODY");
    if (!body || !body.text || body.text.trim().length === 0) {
      throw new BadRequestException({
        error: "body_required",
        detail: "Add a body — it's the only required component.",
      });
    }

    // Meta's own field limits + component rules, checked BEFORE the Graph call.
    // A rejection from Meta arrives as an opaque `#100 Invalid parameter` with no
    // field name, so an author who pasted a 1,200-character body would learn only
    // that "something" was wrong. Same pure validator the create form uses, so
    // the character counter and this rejection can't disagree.
    //
    // `category` is passed because one rule depends on it: a LOCATION header is
    // only legal on utility/marketing templates.
    const issues = validateTemplateComponents(name, components, { category });
    if (issues.length > 0) {
      throw new BadRequestException({
        error: "template_invalid",
        detail: issues.map((i) => i.message).join(" "),
        issues,
      });
    }

    // Meta's `message_send_ttl_seconds`. Only the presence of the field is
    // validated here — the legal range differs per category and is Meta's to
    // define, so an out-of-range value is left for Meta to reject with its own
    // message rather than blocked by a number we'd have to keep in sync.
    const messageSendTtlSeconds = parseTtlSeconds(obj.messageSendTtlSeconds, category);

    const config = await this.templateOpConfig(workspaceId, { accountId });
    const provider = getMetaProvider();
    if (!provider.createTemplate) {
      throw new HttpException(
        { error: "provider_cannot_create_templates" },
        501,
      );
    }

    // Read from EVERY parameterized surface (header text, body text, URL button
    // targets), not just the body. Inference is safe only here, on the authoring
    // path, because the composer wrote every placeholder and there is no literal
    // `{{word}}` prose to confuse it — for a template that already exists at
    // Meta, the stored `parameterFormat` is the authority.
    //
    // `validateTemplateComponents` has already rejected "mixed", so anything
    // that reaches this line is one dialect or none; "none" declares positional,
    // matching Meta's own default for a template with no parameters.
    const authoredParameterFormat: TemplateParameterFormat =
      detectParameterFormat(components) === "named" ? "named" : "positional";

    // Meta's review rejects a submission whose BODY and FOOTER wording
    // duplicate an existing template on the WABA (documented as exempt for
    // AUTHENTICATION templates) — but only after the 24-hour review, naming
    // the twin in Business Support Home. The local catalog can answer the
    // same question instantly. Same-name rows are excluded (language variants
    // of one template are translations, not duplicates), and so are
    // rejected/archived rows — a rejected twin never went live, and blocking
    // on an archived one 28 days from deletion risks refusing a create Meta
    // would accept. If the catalog is stale (twin deleted in WhatsApp Manager
    // but not re-synced), a Sync clears the false positive — the error says so.
    if (category !== "authentication") {
      const footerOf = (comps: unknown): string => {
        if (!Array.isArray(comps)) return "";
        const f = comps.find(
          (c) =>
            typeof (c as { type?: unknown })?.type === "string" &&
            ((c as { type: string }).type ?? "").toUpperCase() === "FOOTER",
        ) as { text?: unknown } | undefined;
        return typeof f?.text === "string" ? f.text.trim() : "";
      };
      const newFooter = footerOf(components);
      const twins = await this.db.messageTemplate.findMany({
        where: {
          workspaceId,
          wabaAccountId: requireWabaAccount(config),
          bodyText: body.text,
          status: { notIn: ["rejected", "archived"] },
          NOT: { name },
        },
        select: { name: true, language: true, components: true },
      });
      const twin = twins.find((t) => footerOf(t.components) === newFooter);
      if (twin) {
        throw new ConflictException({
          error: "template_duplicate_content",
          detail:
            `Meta rejects templates whose body and footer wording duplicate an existing ` +
            `template — this matches "${twin.name}" (${twin.language}). Change the wording, ` +
            `or if that template no longer exists in WhatsApp Manager, click Sync first.`,
        });
      }
    }

    let created;
    try {
      created = await provider.createTemplate(
        {
          name,
          language,
          category,
          components,
          parameterFormat: authoredParameterFormat,
          ...(messageSendTtlSeconds !== undefined ? { messageSendTtlSeconds } : {}),
        },
        config,
      );
    } catch (err) {
      this.throwIfMissingWaba(err);
      this.throwIfMetaSendError(err, 1000);
      this.logger.error("template create failed", err);
      throw new BadGatewayException({
        error: "create_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const now = new Date();
    const wabaAccountId = requireWabaAccount(config);
    // The category META ASSIGNED, not the one we asked for. Since 2025-04-09 a
    // UTILITY submission whose content reads as promotional is approved as
    // MARKETING outright, and storing our request instead left the row claiming
    // a cheaper category than Meta bills. Fall back to the requested value only
    // when Meta's response omitted the field.
    const assignedCategory = created.category ?? category;
    const saved = await this.db.messageTemplate.upsert({
      where: {
        workspaceId_wabaAccountId_name_language: {
          workspaceId,
          wabaAccountId,
          name,
          language,
        },
      },
      create: {
        workspaceId,
        // Must be written explicitly. Leaving it to the column default ("")
        // while the WHERE matched on the real WABA meant every create under a
        // connected WABA missed its own row on the next lookup and stranded a
        // duplicate that no per-WABA sync would ever reconcile.
        wabaAccountId,
        externalId: created.externalId,
        name,
        language,
        category: assignedCategory,
        status: created.status,
        bodyText: body.text,
        components: components as unknown as Prisma.InputJsonValue,
        variableBindings: variableBindings as Prisma.InputJsonValue,
        // Safe to infer only here — see the derivation above. The next sync
        // replaces it with Meta's authoritative `parameter_format` anyway.
        parameterFormat: authoredParameterFormat,
        ...(messageSendTtlSeconds !== undefined ? { messageSendTtlSeconds } : {}),
        syncedAt: now,
      },
      update: {
        externalId: created.externalId,
        category: assignedCategory,
        status: created.status,
        bodyText: body.text,
        components: components as unknown as Prisma.InputJsonValue,
        variableBindings: variableBindings as Prisma.InputJsonValue,
        parameterFormat: authoredParameterFormat,
        messageSendTtlSeconds: messageSendTtlSeconds ?? null,
        syncedAt: now,
      },
    });

    await this.bus.publish({
      type: "team.catalog_changed",
      workspaceId,
      scope: "whatsapp-templates",
    });

    return { templateId: saved.id, status: saved.status };
  }

  // -------------------------------------------------------------------------
  // Authentication templates
  //
  // Their body is FIXED preset text Meta owns, so there is nothing to author —
  // you choose the optional strings and the OTP button, and Meta writes the
  // wording in every language you name. That is why these get their own two
  // endpoints instead of going through the composer.
  // -------------------------------------------------------------------------

  /** Show the preset wording per language BEFORE anything is created. */
  async previewAuthTemplates(
    workspaceId: string,
    input: {
      languages?: string[];
      addSecurityRecommendation?: boolean;
      codeExpirationMinutes?: number;
    },
  ): Promise<{ previews: AuthTemplatePreview[] }> {
    const minutes = parseCodeExpirationMinutes(input.codeExpirationMinutes);
    const config = await this.templateOpConfig(workspaceId);
    const provider = getMetaProvider();
    if (!provider.previewAuthTemplates) {
      throw new HttpException({ error: "provider_has_no_auth_previews" }, 501);
    }
    try {
      return {
        previews: await provider.previewAuthTemplates(
          {
            languages: input.languages ?? [],
            ...(input.addSecurityRecommendation
              ? { addSecurityRecommendation: true }
              : {}),
            ...(minutes !== undefined ? { codeExpirationMinutes: minutes } : {}),
          },
          config,
        ),
      };
    } catch (err) {
      this.throwIfMissingWaba(err);
      this.throwIfMetaSendError(err);
      throw new BadGatewayException({
        error: "preview_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Create (or update) an authentication template across many languages.
   *
   * Upsert semantics are Meta's: an existing (name, language) is UPDATED rather
   * than colliding, which is what makes adding a language later safe to re-run.
   */
  async upsertAuthTemplate(
    workspaceId: string,
    raw: unknown,
    /** Which number's WABA the templates are created under; omitted = default. */
    accountId?: string | null,
  ): Promise<{ created: number; templates: Array<{ language: string; status: string }> }> {
    const obj = (raw ?? {}) as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    if (!TEMPLATE_NAME_PATTERN.test(name)) {
      throw new BadRequestException({
        error: "invalid_name",
        detail: "Template name must be lowercase letters, digits and underscores only.",
      });
    }
    const languages = Array.isArray(obj.languages)
      ? obj.languages.filter((l): l is string => typeof l === "string" && l.length > 0)
      : [];
    if (languages.length === 0) {
      throw new BadRequestException({
        error: "languages_required",
        detail: "Pick at least one language.",
      });
    }
    const bad = languages.filter((l) => !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(l));
    if (bad.length > 0) {
      throw new BadRequestException({
        error: "invalid_language",
        detail: `Not a Meta language code: ${bad.join(", ")}.`,
      });
    }

    const otpType = obj.otpType;
    if (otpType !== "COPY_CODE" && otpType !== "ONE_TAP" && otpType !== "ZERO_TAP") {
      throw new BadRequestException({
        error: "invalid_otp_type",
        detail: "Pick COPY_CODE, ONE_TAP or ZERO_TAP.",
      });
    }
    const supportedApps = Array.isArray(obj.supportedApps)
      ? (obj.supportedApps as Array<{ package_name?: unknown; signature_hash?: unknown }>)
          .filter(
            (a) =>
              typeof a?.package_name === "string" && typeof a?.signature_hash === "string",
          )
          .map((a) => ({
            package_name: a.package_name as string,
            signature_hash: a.signature_hash as string,
          }))
      : [];
    // One-tap and zero-tap hand the code to an APP; without the app's identity
    // there is nowhere for it to go, and Meta rejects with a generic error.
    if (otpType !== "COPY_CODE" && supportedApps.length === 0) {
      throw new BadRequestException({
        error: "supported_app_required",
        detail:
          `${otpType} delivers the code straight into your app, so it needs the app's ` +
          `package name and signature hash. Use COPY_CODE if you don't have them.`,
      });
    }
    // Meta's formats, checked here as well as in the form: a malformed package
    // or hash comes back as a generic `#100` that names neither field, and the
    // signature hash in particular is easy to paste with whitespace or the wrong
    // length and impossible to eyeball.
    if (supportedApps.length > MAX_SUPPORTED_APPS) {
      throw new BadRequestException({
        error: "too_many_apps",
        detail: `At most ${MAX_SUPPORTED_APPS} apps can receive the code.`,
      });
    }
    for (const app of supportedApps) {
      if (!ANDROID_PACKAGE_PATTERN.test(app.package_name)) {
        throw new BadRequestException({
          error: "invalid_package_name",
          detail:
            `"${app.package_name}" isn't a valid Android package name — it needs at ` +
            `least two dot-separated segments, each starting with a letter.`,
        });
      }
      if (!SIGNATURE_HASH_PATTERN.test(app.signature_hash)) {
        throw new BadRequestException({
          error: "invalid_signature_hash",
          detail:
            "An app signing key hash is exactly 11 characters (letters, digits, + / =).",
        });
      }
    }

    // Zero-tap fills the code into the customer's app WITHOUT them tapping
    // anything, so Meta requires an explicit acknowledgement that this is
    // understood and disclosed. A missing/false value is not a default — the
    // template simply isn't created — so refuse here with the reason rather
    // than surfacing Meta's generic rejection.
    const zeroTapTermsAccepted = obj.zeroTapTermsAccepted === true;
    if (otpType === "ZERO_TAP" && !zeroTapTermsAccepted) {
      throw new BadRequestException({
        error: "zero_tap_terms_required",
        detail:
          "Zero-tap fills the code into your app automatically, so Meta requires you to " +
          "confirm you accept the WhatsApp Business Terms for it and that your customers " +
          "are told the code will be filled in for them.",
      });
    }

    const codeExpirationMinutes = parseCodeExpirationMinutes(obj.codeExpirationMinutes);
    const messageSendTtlSeconds = parseTtlSeconds(
      obj.messageSendTtlSeconds,
      "authentication",
    );

    const config = await this.templateOpConfig(workspaceId, { accountId });
    const provider = getMetaProvider();
    if (!provider.upsertAuthTemplate) {
      throw new HttpException({ error: "provider_cannot_upsert_auth_templates" }, 501);
    }

    let result;
    try {
      result = await provider.upsertAuthTemplate(
        {
          name,
          languages,
          otpType,
          ...(obj.addSecurityRecommendation ? { addSecurityRecommendation: true } : {}),
          ...(codeExpirationMinutes !== undefined ? { codeExpirationMinutes } : {}),
          ...(messageSendTtlSeconds !== undefined ? { messageSendTtlSeconds } : {}),
          ...(supportedApps.length > 0 ? { supportedApps } : {}),
          ...(otpType === "ZERO_TAP" ? { zeroTapTermsAccepted } : {}),
        },
        config,
      );
    } catch (err) {
      this.throwIfMissingWaba(err);
      this.throwIfMetaSendError(err, 1000);
      this.logger.error("auth template upsert failed", err);
      throw new BadGatewayException({
        error: "create_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    // Pull the real rows rather than synthesizing them: the body text is Meta's
    // and we have never seen it, so a sync is the only honest way to learn what
    // was actually created.
    await syncTemplateCatalog(workspaceId);
    await this.bus.publish({
      type: "team.catalog_changed",
      workspaceId,
      scope: "whatsapp-templates",
    });

    return {
      created: result.templates.length,
      templates: result.templates.map((t) => ({
        language: t.language,
        status: t.status ?? "pending",
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Template Library
  // -------------------------------------------------------------------------

  /**
   * Browse Meta's library of pre-written, pre-categorized blueprints.
   *
   * A read of Meta's own static catalogue — identical for every account — so it
   * is not cached locally: the filters are the query, and stale results would be
   * worse than one Graph GET behind an already rate-limited route.
   */
  async browseTemplateLibrary(
    workspaceId: string,
    filters: TemplateLibraryFilters,
  ): Promise<{ templates: LibraryTemplate[] }> {
    // Any active account's credentials read the (account-agnostic) library —
    // resolved explicitly because a workspace-only load refuses with several
    // active numbers, which had broken library browsing on multi-account.
    const config = await this.templateOpConfig(workspaceId);
    const provider = getMetaProvider();
    if (!provider.fetchTemplateLibrary) {
      throw new HttpException({ error: "provider_has_no_template_library" }, 501);
    }
    try {
      return { templates: await provider.fetchTemplateLibrary(filters, config) };
    } catch (err) {
      this.throwIfMetaSendError(err);
      this.logger.error("template library browse failed", err);
      throw new BadGatewayException({
        error: "library_browse_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Instantiate a library blueprint under our own name.
   *
   * Unlike `createTemplate` there is nothing to validate about the CONTENT — the
   * blueprint owns it and it cannot be edited. What we do own is the name, the
   * language, and the per-business button destinations.
   *
   * The category comes from the BLUEPRINT, not from the caller. Meta's own docs
   * contradict themselves here (the body-properties table says the category
   * "must be UTILITY", while the same page's authentication add-ons —
   * `add_security_recommendation`, `code_expiration_minutes` — only make sense on
   * an authentication template). Taking it from the blueprint sidesteps the
   * contradiction and is strictly more correct: the blueprint already knows what
   * it is.
   */
  async createFromLibrary(
    workspaceId: string,
    raw: unknown,
    /** Which number's WABA the template is created under; omitted = default. */
    accountId?: string | null,
  ): Promise<{ templateId: string; status: string }> {
    const obj = (raw ?? {}) as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    const libraryTemplateName =
      typeof obj.libraryTemplateName === "string" ? obj.libraryTemplateName.trim() : "";
    const language = typeof obj.language === "string" ? obj.language.trim() : "";

    if (!TEMPLATE_NAME_PATTERN.test(name)) {
      throw new BadRequestException({
        error: "invalid_name",
        detail: "Template name must be lowercase letters, digits and underscores only.",
      });
    }
    if (!libraryTemplateName) {
      throw new BadRequestException({
        error: "library_template_required",
        detail: "Pick a template from the library.",
      });
    }
    if (!language || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(language)) {
      throw new BadRequestException({
        error: "invalid_language",
        detail: "Use a Meta language code like en_US, fr, pt_BR.",
      });
    }

    const config = await this.templateOpConfig(workspaceId, { accountId });
    const provider = getMetaProvider();
    if (!provider.createFromLibrary || !provider.fetchTemplateLibrary) {
      throw new HttpException({ error: "provider_has_no_template_library" }, 501);
    }

    // Re-read the blueprint rather than trusting the client's copy of it: the
    // category we submit and the `bodyParamTypes` we persist both come from here,
    // and a stale/forged client payload would put the wrong ones on the row —
    // where the types silently govern every future send-time check.
    const blueprint = (
      await provider.fetchTemplateLibrary({ name: libraryTemplateName, language }, config)
    ).find((t) => t.name === libraryTemplateName);
    if (!blueprint) {
      throw new NotFoundException({
        error: "library_template_not_found",
        detail: `No library template named "${libraryTemplateName}" in ${language}.`,
      });
    }

    let created;
    try {
      created = await provider.createFromLibrary(
        {
          name,
          language,
          category: blueprint.category ?? "utility",
          libraryTemplateName,
          ...(Array.isArray(obj.buttonInputs) && obj.buttonInputs.length > 0
            ? { buttonInputs: obj.buttonInputs as LibraryTemplateButtonInput[] }
            : {}),
          ...(obj.bodyInputs && typeof obj.bodyInputs === "object"
            ? { bodyInputs: obj.bodyInputs as LibraryTemplateBodyInput }
            : {}),
        },
        config,
      );
    } catch (err) {
      this.throwIfMissingWaba(err);
      this.throwIfMetaSendError(err, 1000);
      this.logger.error("library template create failed", err);
      throw new BadGatewayException({
        error: "create_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const now = new Date();
    const wabaAccountId = requireWabaAccount(config);
    const saved = await this.db.messageTemplate.upsert({
      where: {
        workspaceId_wabaAccountId_name_language: {
          workspaceId,
          wabaAccountId,
          name,
          language,
        },
      },
      create: {
        workspaceId,
        wabaAccountId,
        externalId: created.externalId,
        name,
        language,
        category: created.category ?? blueprint.category ?? "utility",
        status: created.status,
        bodyText: blueprint.body,
        // The blueprint's own copy, in our component shape, so every existing
        // reader (picker, preview, broadcast composer) works unchanged. The next
        // sync replaces it with exactly what Meta stored.
        components: libraryComponents(blueprint) as unknown as Prisma.InputJsonValue,
        // Library bodies are positional (`{{1}}`) — Meta authors them.
        parameterFormat: "positional",
        libraryTemplateName,
        bodyParamTypes: blueprint.bodyParamTypes,
        syncedAt: now,
      },
      update: {
        externalId: created.externalId,
        category: created.category ?? blueprint.category ?? "utility",
        status: created.status,
        bodyText: blueprint.body,
        components: libraryComponents(blueprint) as unknown as Prisma.InputJsonValue,
        parameterFormat: "positional",
        libraryTemplateName,
        bodyParamTypes: blueprint.bodyParamTypes,
        syncedAt: now,
      },
    });

    await this.bus.publish({
      type: "team.catalog_changed",
      workspaceId,
      scope: "whatsapp-templates",
    });

    return { templateId: saved.id, status: saved.status };
  }

  /**
   * Edit an existing template's category, components and/or TTL.
   *
   * This exists because the alternative the app used to recommend — delete and
   * recreate — is actively harmful: deleting an APPROVED template blocks reusing
   * that NAME for 30 days, so an operator fixing a typo would strand their own
   * template for a month.
   *
   * Meta's constraints are checked here, before the Graph call, because each has
   * a distinct fix and Meta reports them all as an opaque `#100`.
   */
  async editTemplate(
    workspaceId: string,
    id: string,
    raw: unknown,
  ): Promise<{ templateId: string; status: string }> {
    const obj = (raw ?? {}) as Record<string, unknown>;

    const template = await this.db.messageTemplate.findFirst({
      where: { id, workspaceId },
    });
    if (!template) throw new NotFoundException({ error: "template_not_found" });
    if (!template.externalId) {
      throw new BadRequestException({
        error: "template_not_synced",
        detail: "This template hasn't reached Meta yet, so there's nothing to edit.",
      });
    }
    // Meta allows edits only from these three states.
    if (!["approved", "rejected", "paused"].includes(template.status)) {
      throw new ConflictException({
        error: "template_not_editable",
        detail:
          `A ${template.status} template can't be edited. Only approved, rejected or ` +
          `paused templates can.`,
      });
    }
    // A library template's copy is Meta's and is fixed — editing components
    // would be rejected, and there is nothing meaningful to change.
    if (template.libraryTemplateName && obj.components !== undefined) {
      throw new ConflictException({
        error: "library_template_immutable",
        detail:
          "This template came from Meta's Template Library, so its wording is fixed. " +
          "Create a new template if you need different content.",
      });
    }

    const category = obj.category === undefined ? undefined : parseCategory(obj.category);
    if (obj.category !== undefined && !category) {
      throw new BadRequestException({
        error: "invalid_category",
        detail: "Pick marketing, utility or authentication.",
      });
    }
    // Meta rejects a category change on an APPROVED template outright.
    if (category && category !== template.category && template.status === "approved") {
      throw new ConflictException({
        error: "category_locked",
        detail:
          "An approved template's category can't be changed. Meta may recategorize it " +
          "itself, or you can request a review in WhatsApp Manager.",
      });
    }

    // `components` REPLACES the whole array at Meta — never merges — so an
    // incomplete payload silently deletes what it omits. Validate the full set
    // exactly as create does.
    const components =
      obj.components === undefined ? undefined : parseComponents(obj.components);
    if (components) {
      if (components.length === 0) {
        throw new BadRequestException({
          error: "components_required",
          detail: "At least a BODY component is required.",
        });
      }
      const issues = validateTemplateComponents(template.name, components, {
        category: category ?? template.category,
      });
      if (issues.length > 0) {
        throw new BadRequestException({
          error: "template_invalid",
          detail: issues.map((i) => i.message).join(" "),
          issues,
        });
      }
      // Meta stores ONE parameter_format per template and the edit endpoint has
      // no field to change it, so an edit must not silently switch dialects.
      const nextFormat =
        detectParameterFormat(components) === "named" ? "named" : "positional";
      if (nextFormat !== template.parameterFormat) {
        throw new BadRequestException({
          error: "parameter_format_locked",
          detail:
            `This template uses ${template.parameterFormat} variables ` +
            `(${template.parameterFormat === "named" ? "{{order_id}}" : "{{1}}"}). ` +
            `An edit can't switch to the other style — create a new template instead.`,
        });
      }
    }

    // Judged against the category the template will HAVE after this edit.
    const messageSendTtlSeconds = parseTtlSeconds(
      obj.messageSendTtlSeconds,
      category ?? (template.category as TemplateCategory),
    );
    if (!category && !components && messageSendTtlSeconds === undefined) {
      throw new BadRequestException({
        error: "nothing_to_edit",
        detail: "Change the category, the content or the time-to-live.",
      });
    }

    // Credentials for the WABA that OWNS this template — see templateOpConfig.
    const config = await this.templateOpConfig(workspaceId, {
      wabaAccountId: template.wabaAccountId,
    });
    const provider = getMetaProvider();
    if (!provider.editTemplate) {
      throw new HttpException({ error: "provider_cannot_edit_templates" }, 501);
    }

    try {
      await provider.editTemplate(
        {
          externalId: template.externalId,
          ...(category ? { category } : {}),
          ...(components ? { components } : {}),
          ...(messageSendTtlSeconds !== undefined ? { messageSendTtlSeconds } : {}),
        },
        config,
      );
    } catch (err) {
      this.throwIfMissingWaba(err);
      this.throwIfMetaSendError(err, 1000);
      this.logger.error("template edit failed", err);
      throw new BadGatewayException({
        error: "edit_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    // Meta re-enters the template into review on a successful edit. Reflect that
    // locally rather than leaving a stale "approved" — the next catalog sync
    // replaces it with Meta's real verdict, usually within minutes.
    const body = components?.find((c) => c.type === "BODY");
    const saved = await this.db.messageTemplate.update({
      where: { id: template.id },
      data: {
        ...(category ? { category } : {}),
        ...(components
          ? {
              components: components as unknown as Prisma.InputJsonValue,
              bodyText: body?.text ?? template.bodyText,
            }
          : {}),
        ...(messageSendTtlSeconds !== undefined ? { messageSendTtlSeconds } : {}),
        status: "pending",
        statusReason: null,
        statusDetail: Prisma.DbNull,
        syncedAt: new Date(),
      },
    });

    await this.bus.publish({
      type: "team.catalog_changed",
      workspaceId,
      scope: "whatsapp-templates",
    });

    return { templateId: saved.id, status: saved.status };
  }

  /**
   * Delete from Meta first, then drop the local row. Meta-side failure
   * keeps the local row so a re-sync stays consistent — otherwise admins
   * would see "deleted" in the app while the template stays active in
   * WhatsApp Manager. The provider treats Meta's 404 as success, so
   * re-deleting an already-gone template still cleans up locally.
   */
  async deleteTemplate(workspaceId: string, id: string): Promise<void> {
    const template = await this.db.messageTemplate.findFirst({
      where: { id, workspaceId },
    });
    if (!template) throw new NotFoundException({ error: "template_not_found" });
    // Meta refuses to delete a template in a disabled state. Say which state,
    // rather than surfacing its generic rejection as a 502.
    if (template.status === "disabled") {
      throw new ConflictException({
        error: "template_not_deletable",
        detail:
          "Meta doesn't allow deleting a disabled template. It stays in the catalogue " +
          "as a record; it simply can't be sent.",
      });
    }

    // Meta's delete-by-NAME deletes EVERY language variant of that name.
    // Without an externalId we can only delete by name, so refuse when
    // sibling variants exist rather than silently nuking them — the delete
    // confirm promised "the {language} variant", and a Sync populates the
    // externalId that makes a precise per-variant delete possible.
    if (!template.externalId) {
      const siblings = await this.db.messageTemplate.count({
        where: {
          workspaceId,
          wabaAccountId: template.wabaAccountId,
          name: template.name,
          NOT: { id: template.id },
        },
      });
      if (siblings > 0) {
        throw new ConflictException({
          error: "template_delete_would_remove_all_languages",
          detail:
            `"${template.name}" exists in ${siblings + 1} languages, and without a ` +
            `synced Meta id a delete removes ALL of them. Press "Refresh from Meta" ` +
            `first, then delete just this variant.`,
        });
      }
    }

    // Credentials for the WABA that OWNS this template — see templateOpConfig.
    // The default account's edge answered a wrong-WABA delete with a 404 that
    // the provider treats as "already gone", while the real template survived.
    const config = await this.templateOpConfig(workspaceId, {
      wabaAccountId: template.wabaAccountId,
    });
    const provider = getMetaProvider();
    if (!provider.deleteTemplate) {
      throw new HttpException(
        { error: "provider_does_not_support_template_delete" },
        501,
      );
    }

    try {
      await provider.deleteTemplate(
        {
          name: template.name,
          ...(template.externalId ? { externalId: template.externalId } : {}),
        },
        config,
      );
    } catch (err) {
      this.throwIfMissingWaba(err);
      this.throwIfMetaSendError(err);
      this.logger.error("template delete on Meta failed", err);
      throw new BadGatewayException({
        error: "delete_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    await this.db.messageTemplate.delete({ where: { id: template.id } });
    await this.bus.publish({
      type: "team.catalog_changed",
      workspaceId,
      scope: "whatsapp-templates",
    });
  }

  /**
   * Lift a quality pause on a template.
   *
   * A quality pause lifts ITSELF after 3h (then 6h, then Meta disables the
   * template on the third instance), so this is not how a normal pause is
   * recovered — it exists because a template paused by **Template Pacing** never
   * unpauses on its own and can only be lifted here or in WhatsApp Manager.
   *
   * On success the local row goes straight back to `approved` rather than
   * waiting for the status webhook: the operator just clicked the button and
   * needs to see it worked. The webhook, when it arrives, writes the same value
   * — and it is what resumes any campaigns we parked, so the two paths stay
   * complementary rather than duplicated.
   */
  async unpauseTemplate(workspaceId: string, id: string): Promise<void> {
    const template = await this.db.messageTemplate.findFirst({
      where: { id, workspaceId },
      select: {
        id: true,
        externalId: true,
        status: true,
        name: true,
        wabaAccountId: true,
      },
    });
    if (!template) throw new NotFoundException({ error: "template_not_found" });
    if (template.status !== "paused") {
      throw new ConflictException({
        error: "template_not_paused",
        detail: "Only a paused template can be unpaused.",
      });
    }
    if (!template.externalId) {
      throw new ConflictException({
        error: "template_not_synced",
        detail:
          "This template has no Meta id yet — run Sync so it can be matched to Meta's copy.",
      });
    }

    // Credentials for the WABA that OWNS this template — see templateOpConfig.
    const config = await this.templateOpConfig(workspaceId, {
      wabaAccountId: template.wabaAccountId,
    });
    const provider = getMetaProvider();
    if (!provider.unpauseTemplate) {
      throw new HttpException({ error: "provider_does_not_support_unpause" }, 501);
    }

    try {
      await provider.unpauseTemplate(template.externalId, config);
    } catch (err) {
      this.throwIfMissingWaba(err);
      this.throwIfMetaSendError(err);
      this.logger.error("template unpause on Meta failed", err);
      throw new BadGatewayException({
        error: "unpause_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    await this.db.messageTemplate.updateMany({
      where: { id: template.id, workspaceId },
      data: {
        status: "approved",
        statusReason: null,
        // The pause-instance detail (FIRST_PAUSE etc.) died with the pause.
        statusDetail: Prisma.DbNull,
        // Meta re-derives the band from recent feedback on unpause, so the RED
        // that caused the pause is no longer true. Null reads as "pending",
        // which is honest; the next webhook or sync fills in the new value.
        qualityScore: null,
        qualityScoreAt: null,
      },
    });
    // Campaigns we parked for this template can go again — the same call the
    // approval webhook makes, because the operator unpausing by hand shouldn't
    // have to wait for Meta to tell us what we just did.
    await resumeBroadcastsForTemplate(workspaceId, template.id);
    await this.bus.publish({
      type: "team.catalog_changed",
      workspaceId,
      scope: "whatsapp-templates",
    });
  }

  // ==========================================================================
  // Business profile
  //
  // What a customer sees when they tap the business name in a chat. Editable
  // in WhatsApp Manager, which is exactly why it belongs here too: an operator
  // shouldn't have to leave the product to set the description, address and
  // website their customers actually read.
  // ==========================================================================

  /** The profile for one of the workspace's WhatsApp numbers (default if unset). */
  async getBusinessProfile(workspaceId: string, accountId?: string) {
    const config = await this.requireSendConfig(workspaceId, accountId);
    const provider = getMetaProvider();
    if (!provider.getBusinessProfile) {
      throw new HttpException({ error: "provider_does_not_support_profiles" }, 501);
    }
    try {
      return { profile: await provider.getBusinessProfile(config) };
    } catch (err) {
      this.throwIfMetaSendError(err);
      this.logger.error("business profile read failed", err);
      throw new BadGatewayException({
        error: "profile_read_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * OBA standing + the owning WABA's record, for the settings panel.
   *
   * Read-only. Requesting OBA happens in WhatsApp Manager — Meta publishes a
   * wire shape for READING the status and none for making the request, so the
   * UI links out rather than pretending to submit one.
   */
  async getAccountStatus(workspaceId: string, accountId?: string) {
    const config = await this.requireSendConfig(workspaceId, accountId);
    const provider = getMetaProvider();
    if (!provider.getAccountStatus) {
      throw new HttpException({ error: "provider_does_not_support_account_status" }, 501);
    }
    try {
      return await provider.getAccountStatus(config);
    } catch (err) {
      this.throwIfMetaSendError(err);
      this.logger.error("account status read failed", err);
      throw new BadGatewayException({
        error: "account_status_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async updateBusinessProfile(
    workspaceId: string,
    input: UpdateBusinessProfileInput,
    accountId?: string,
  ) {
    const config = await this.requireSendConfig(workspaceId, accountId);
    const provider = getMetaProvider();
    if (!provider.updateBusinessProfile) {
      throw new HttpException({ error: "provider_does_not_support_profiles" }, 501);
    }
    try {
      await provider.updateBusinessProfile(input, config);
    } catch (err) {
      this.throwIfMetaSendError(err);
      this.logger.error("business profile update failed", err);
      throw new BadGatewayException({
        error: "profile_update_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    // Read back rather than echoing the input: Meta normalizes some fields and
    // silently ignores others, and showing the operator what it ACTUALLY stored
    // is the difference between "saved" and "saved something else".
    return this.getBusinessProfile(workspaceId, accountId);
  }

  // ==========================================================================
  // QR codes & short links
  //
  // A scannable/tappable entry point into a chat, optionally with a message
  // already typed. Managed here rather than only in Business Manager because
  // the codes go on packaging and signage — the people who own that live in
  // this product, not in Meta's console.
  //
  // Meta caps a number at 2,000 codes and offers NO analytics on them (a
  // deliberate privacy choice), so there is no scan-count to show.
  // ==========================================================================

  async listQrCodes(workspaceId: string, accountId?: string) {
    const config = await this.requireSendConfig(workspaceId, accountId);
    const provider = getMetaProvider();
    if (!provider.listQrCodes) {
      throw new HttpException({ error: "provider_does_not_support_qr_codes" }, 501);
    }
    try {
      return { codes: await provider.listQrCodes(config) };
    } catch (err) {
      this.throwIfMetaSendError(err);
      throw new BadGatewayException({
        error: "qr_list_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async createQrCode(
    workspaceId: string,
    input: CreateQrCodeInput,
    accountId?: string,
  ) {
    const config = await this.requireSendConfig(workspaceId, accountId);
    const provider = getMetaProvider();
    if (!provider.createQrCode) {
      throw new HttpException({ error: "provider_does_not_support_qr_codes" }, 501);
    }
    try {
      return {
        code: await provider.createQrCode(
          { prefilledMessage: input.prefilledMessage, imageFormat: input.imageFormat },
          config,
        ),
      };
    } catch (err) {
      this.throwIfMetaSendError(err);
      throw new BadGatewayException({
        error: "qr_create_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async updateQrCode(
    workspaceId: string,
    code: string,
    input: UpdateQrCodeInput,
    accountId?: string,
  ) {
    const config = await this.requireSendConfig(workspaceId, accountId);
    const provider = getMetaProvider();
    if (!provider.updateQrCode) {
      throw new HttpException({ error: "provider_does_not_support_qr_codes" }, 501);
    }
    try {
      return {
        code: await provider.updateQrCode(
          { code, prefilledMessage: input.prefilledMessage },
          config,
        ),
      };
    } catch (err) {
      this.throwIfMetaSendError(err);
      throw new BadGatewayException({
        error: "qr_update_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async deleteQrCode(workspaceId: string, code: string, accountId?: string) {
    const config = await this.requireSendConfig(workspaceId, accountId);
    const provider = getMetaProvider();
    if (!provider.deleteQrCode) {
      throw new HttpException({ error: "provider_does_not_support_qr_codes" }, 501);
    }
    try {
      await provider.deleteQrCode(code, config);
    } catch (err) {
      this.throwIfMetaSendError(err);
      throw new BadGatewayException({
        error: "qr_delete_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ==========================================================================
  // Username — the number's chat-native @handle
  //
  // 1:1 with the business phone number, globally unique across WhatsApp, and
  // adopting one does NOT hide the number. Like the business profile, every
  // read is LIVE from Graph (Meta is the authority); the stored
  // `ChannelConnection.businessUsername` is a cache re-synced opportunistically
  // on each read here and by the `business_username_updates` webhook.
  // ==========================================================================

  /** Current username + Meta's reserved suggestions, for the settings panel. */
  async getUsernameState(
    workspaceId: string,
    accountId?: string,
  ): Promise<{ username: string | null; suggestions: string[] }> {
    const config = await this.requireSendConfig(workspaceId, accountId);
    const provider = getMetaProvider();
    if (!provider.getUsername) {
      throw new HttpException({ error: "provider_does_not_support_usernames" }, 501);
    }
    let username: string | null;
    try {
      username = (await provider.getUsername(config)).username;
    } catch (err) {
      this.throwIfMetaSendError(err);
      this.logger.error("username read failed", err);
      throw new BadGatewayException({
        error: "username_read_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    // Suggestions are decoration on this panel — a failure (permission quirk,
    // endpoint not yet rolled out to this number) must not blank the current
    // username the operator came to see.
    let suggestions: string[] = [];
    if (provider.getUsernameSuggestions) {
      try {
        suggestions = await provider.getUsernameSuggestions(config);
      } catch (err) {
        this.logger.warn(
          `username suggestions read failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    await this.persistUsername(workspaceId, config.phoneNumberId, username);
    return { username, suggestions };
  }

  /**
   * Adopt or change the number's username.
   *
   * Meta's 147005 ("Username transfer required" — the name is already on
   * ANOTHER of this portfolio's numbers) surfaces as a structured 409 so the
   * UI can offer the force-transfer confirm instead of a dead-end error; a
   * re-send with `transferAction: "force_transfer"` moves the handle here.
   */
  async setUsername(
    workspaceId: string,
    input: SetWhatsappUsernameInput,
    accountId?: string,
  ): Promise<{ username: string; warnings: string[] }> {
    // Full rule check (the Zod schema only bounds length) — one shared
    // definition with the UI's live validation. Meta remains the final
    // authority; anything it rejects beyond these rules surfaces via
    // meta_rejected_request below.
    const check = checkWhatsappUsername(input.username);
    if (!check.ok) {
      throw new BadRequestException({
        error: "invalid_username",
        detail: check.errors.join(" "),
      });
    }
    const config = await this.requireSendConfig(workspaceId, accountId);
    const provider = getMetaProvider();
    if (!provider.setUsername) {
      throw new HttpException({ error: "provider_does_not_support_usernames" }, 501);
    }
    try {
      await provider.setUsername(
        {
          username: check.normalized,
          ...(input.transferAction ? { transferAction: input.transferAction } : {}),
        },
        config,
      );
    } catch (err) {
      if (isUsernameTransferConflict(err)) {
        throw new ConflictException({
          error: "username_transfer_required",
          detail:
            "This username already belongs to another phone number in the same " +
            'business portfolio. Re-send with transferAction "force_transfer" to ' +
            "move it to this number — the other number loses it.",
        });
      }
      this.throwIfMetaSendError(err);
      this.logger.error("username update failed", err);
      throw new BadGatewayException({
        error: "username_update_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    // Mirror locally only AFTER Meta accepted — same posture as link tracking.
    await this.persistUsername(workspaceId, config.phoneNumberId, check.normalized);
    return { username: check.normalized, warnings: check.warnings };
  }

  /** Remove the number's username. */
  async deleteUsername(workspaceId: string, accountId?: string): Promise<void> {
    const config = await this.requireSendConfig(workspaceId, accountId);
    const provider = getMetaProvider();
    if (!provider.deleteUsername) {
      throw new HttpException({ error: "provider_does_not_support_usernames" }, 501);
    }
    try {
      await provider.deleteUsername(config);
    } catch (err) {
      this.throwIfMetaSendError(err);
      this.logger.error("username delete failed", err);
      throw new BadGatewayException({
        error: "username_delete_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    await this.persistUsername(workspaceId, config.phoneNumberId, null);
  }

  /**
   * Re-sync the cached copy after Meta confirmed a value. Best-effort — the
   * cache is display data, and failing a successful Meta write over a local
   * hiccup would report the wrong outcome to the operator.
   */
  private async persistUsername(
    workspaceId: string,
    phoneNumberId: string,
    username: string | null,
  ): Promise<void> {
    try {
      await this.db.channelConnection.updateMany({
        where: {
          workspaceId,
          channel: META_PROVIDER,
          externalAccountId: phoneNumberId,
        },
        data: { businessUsername: username },
      });
    } catch (err) {
      this.logger.warn(
        `could not persist username for ${phoneNumberId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Update the parts of the template OUR app owns — `variableBindings` and/or
   * `labels`. Absent field = leave alone; the Zod schema refuses an empty
   * patch. Labels dedupe case-insensitively, preserving first-seen casing.
   */
  async updateTemplateBindings(
    workspaceId: string,
    id: string,
    input: UpdateTemplateBindingsInput,
  ): Promise<void> {
    const updated = await this.db.messageTemplate.updateMany({
      where: { id, workspaceId },
      data: {
        ...(input.variableBindings !== undefined
          ? { variableBindings: input.variableBindings as Prisma.InputJsonValue }
          : {}),
        ...(input.labels !== undefined
          ? { labels: normalizeTemplateLabels(input.labels) }
          : {}),
      },
    });
    if (updated.count === 0) {
      throw new NotFoundException({ error: "template_not_found" });
    }
    await this.bus.publish({
      type: "team.catalog_changed",
      workspaceId,
      scope: "whatsapp-templates",
    });
  }

  /**
   * Resumable upload for template header media. We hop server-side instead
   * of letting the browser hit Meta directly because:
   *   - The Meta access token belongs to the team's app — never touches
   *     client code.
   *   - The two-leg resumable flow needs `OAuth <token>` on leg 2, which
   *     is awkward to centralize anywhere else.
   *
   * 16 MB hard cap — bigger files won't fit through Meta's non-chunked
   * session anyway. Header media tops out under 10 MB in practice.
   */
  async uploadHeaderMedia(
    workspaceId: string,
    file: Express.Multer.File,
    /** Which number's credentials/app upload the asset; omitted = default. */
    accountId?: string | null,
    /** An EXISTING template being edited. Wins over `accountId`: the asset must
     *  be uploaded through the app that owns the template's WABA, and the
     *  template row is the only source of that which a link cannot drop. */
    templateId?: string | null,
  ): Promise<{ headerHandle: string }> {
    if (file.size > UPLOAD_MAX_BYTES) {
      throw new PayloadTooLargeException({
        error: "file_too_large",
        detail: `Header media must be under ${Math.floor(UPLOAD_MAX_BYTES / 1024 / 1024)} MB.`,
      });
    }
    const mimeType = file.mimetype || "application/octet-stream";
    if (!UPLOAD_ALLOWED_MIME.has(mimeType)) {
      throw new UnsupportedMediaTypeException({
        error: "unsupported_media_type",
        detail: `Got ${mimeType}. Supported: ${Array.from(UPLOAD_ALLOWED_MIME).join(", ")}.`,
      });
    }
    const filename = file.originalname || "upload";

    // Prefer the TEMPLATE's own WABA when one is named. `templateOpConfig`
    // already resolves credentials from a wabaId; this just stops the edit path
    // depending on a query param surviving every entry point into the form —
    // the Edit link dropped it, so a header asset was minted through the
    // DEFAULT account's app and then attached to another WABA's template.
    const templateWabaAccountId = templateId
      ? (
          await this.db.messageTemplate.findFirst({
            where: { id: templateId, workspaceId },
            select: { wabaAccountId: true },
          })
        )?.wabaAccountId ?? null
      : null;
    const config = await this.templateOpConfig(
      workspaceId,
      templateWabaAccountId
        ? { wabaAccountId: templateWabaAccountId }
        : { accountId },
    );
    const provider = getMetaProvider();
    if (!provider.uploadHeaderMedia) {
      throw new HttpException(
        { error: "provider_does_not_support_template_media_uploads" },
        501,
      );
    }

    const bytes = new Uint8Array(file.buffer);
    try {
      const result = await provider.uploadHeaderMedia(
        { bytes, mimeType, filename },
        config,
      );
      return { headerHandle: result.headerHandle };
    } catch (err) {
      if (err instanceof MissingAppIdError) {
        throw new ConflictException({
          error: "app_id_missing",
          detail:
            "Add your Meta App ID in Settings → WhatsApp before uploading template media.",
        });
      }
      this.throwIfMetaSendError(err);
      this.logger.error("template media upload failed", err);
      throw new BadGatewayException({
        error: "upload_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * `accountId` selects one of the workspace's WhatsApp numbers; omitted falls
   * back to the default. Threaded through because a workspace can hold several
   * numbers and each has its OWN business profile.
   */
  private async requireSendConfig(workspaceId: string, accountId?: string) {
    try {
      return await getMetaSendConfig(workspaceId, accountId);
    } catch (err) {
      if (err instanceof ProviderNotConfiguredError) {
        throw new ConflictException({
          error: "whatsapp_not_connected",
          detail: err.message,
        });
      }
      throw err;
    }
  }

  /**
   * Credentials for a TEMPLATE operation — resolved to a concrete account,
   * never left to the workspace-only fallback. Two failure modes this closes:
   *
   *  1. With 2+ active numbers, `getMetaSendConfig(workspaceId)` refuses
   *     (`account-unresolved`), which had silently turned EVERY template
   *     operation — edit, delete, unpause, compare, library browse/create,
   *     header-media upload — into a guaranteed 409 on multi-account
   *     workspaces.
   *  2. Operations on an EXISTING template must run against the WABA that
   *     OWNS it. The default account's credentials point at the default
   *     account's WABA — on a two-WABA workspace that meant editing/deleting
   *     WABA B's template through WABA A's edge: a 404 Meta answer that the
   *     delete path treats as "already gone" while the real template
   *     survives, silently diverging the local catalog.
   *
   * Resolution: an explicit `accountId` (the operator's pick) wins; else the
   * first active connection under the template's WABA; else the default account.
   *
   * The old third arm also caught rows carrying the legacy `""` wabaId sentinel —
   * "no WABA, so any account will do". That is gone: `wabaAccountId` is a NOT NULL
   * FK, so a template always names its WABA and the fallback now only fires when
   * every number under that WABA is inactive.
   */
  private async templateOpConfig(
    workspaceId: string,
    opts: { wabaAccountId?: string | null; accountId?: string | null } = {},
  ) {
    let targetId = opts.accountId ?? null;
    if (!targetId && opts.wabaAccountId) {
      targetId =
        (
          await this.db.channelConnection.findFirst({
            where: {
              workspaceId,
              channel: META_PROVIDER,
              wabaAccountId: opts.wabaAccountId,
              isActive: true,
            },
            orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
            select: { id: true },
          })
        )?.id ?? null;
    }
    if (!targetId) {
      targetId =
        (
          await this.db.channelConnection.findFirst({
            where: { workspaceId, channel: META_PROVIDER, isDefault: true },
            select: { id: true },
          })
        )?.id ?? null;
    }
    return this.requireSendConfig(workspaceId, targetId ?? undefined);
  }

  private throwIfMissingWaba(err: unknown): void {
    if (err instanceof MissingWabaIdError) {
      throw new ConflictException({
        error: "waba_id_missing",
        detail:
          "Add your WhatsApp Business Account ID in Settings → WhatsApp to load templates.",
      });
    }
  }

  private throwIfMetaSendError(err: unknown, detailLimit = 500): void {
    if (err instanceof MetaSendError) {
      throw new UnprocessableEntityException({
        error: "meta_rejected_request",
        status: err.httpStatus,
        detail: err.body.slice(0, detailLimit),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The WABA that owns the catalog we're about to write to — or a hard refusal.
 *
 * Templates are WABA-scoped in Meta, so a number with no WABA linked has no
 * catalog and cannot create, edit or send one. This used to fall back to the `""`
 * sentinel, which made the row belong to "unknown WABA" and — because the
 * cross-account send guard only refuses when both sides are known and differ —
 * left it sendable from ANY account. Refusing here is the whole point.
 */
/**
 * Graph error 147005 "Username transfer required": the requested username is
 * already on ANOTHER business phone number within the same portfolio, and Meta
 * wants an explicit `transfer_action: "force_transfer"` to move it. Detected in
 * the raw body the same way the shape-disagreement probe reads code 100 — the
 * numeric code is the contract, the wording is not.
 */
function isUsernameTransferConflict(err: unknown): boolean {
  return err instanceof MetaSendError && /"code"\s*:\s*147005\b/.test(err.body);
}

function requireWabaAccount(config: { wabaAccountId?: string }): string {
  if (!config.wabaAccountId) {
    throw new BadRequestException({
      error: "waba_unknown",
      detail:
        "This WhatsApp number has no WhatsApp Business Account linked, so it has no " +
        "template catalog. Add its WABA ID in WhatsApp settings first.",
    });
  }
  return config.wabaAccountId;
}

/**
 * Row → public DTO. NOTE the `wabaId` it emits is META's `externalWabaId`, joined
 * from the WABA relation — never our internal `wabaAccountId` cuid. Every outward
 * surface (`/v1`, the templates page, the broadcast composer) keys on Meta's id,
 * so the entity refactor is invisible across the API boundary.
 */
function toTemplateDto(row: {
  id: string;
  externalId: string | null;
  wabaAccount: { externalWabaId: string };
  name: string;
  language: string;
  category: string;
  correctCategory: string | null;
  status: string;
  statusReason: string | null;
  statusDetail: Prisma.JsonValue;
  archivedAt: Date | null;
  lastUsedAt: Date | null;
  qualityScore: string | null;
  qualityScoreAt: Date | null;
  libraryTemplateName: string | null;
  linkTrackingOptedOut: boolean | null;
  bodyText: string;
  components: Prisma.JsonValue;
  variableBindings: Prisma.JsonValue;
  labels: string[];
  parameterFormat: string;
  messageSendTtlSeconds: number | null;
  syncedAt: Date;
}): TemplateDto {
  return {
    id: row.id,
    externalId: row.externalId,
    wabaId: row.wabaAccount.externalWabaId,
    name: row.name,
    language: row.language,
    category: row.category,
    // Only a category that DIFFERS is a pending move; Meta reports the already-
    // applied value here too once the change lands.
    correctCategory:
      row.correctCategory && row.correctCategory !== row.category
        ? row.correctCategory
        : null,
    status: row.status,
    statusReason: row.statusReason,
    statusDetail:
      row.statusDetail && typeof row.statusDetail === "object"
        ? (row.statusDetail as TemplateDto["statusDetail"])
        : null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    qualityScore: row.qualityScore,
    qualityScoreAt: row.qualityScoreAt?.toISOString() ?? null,
    libraryTemplateName: row.libraryTemplateName,
    linkTrackingOptedOut: row.linkTrackingOptedOut,
    messageSendTtlSeconds: row.messageSendTtlSeconds,
    bodyText: row.bodyText,
    components: Array.isArray(row.components)
      ? (row.components as unknown as TemplateComponent[])
      : [],
    variableBindings: row.variableBindings ?? {},
    labels: row.labels,
    parameterFormat: row.parameterFormat === "named" ? "named" : "positional",
    syncedAt: row.syncedAt.toISOString(),
  };
}

/**
 * A library blueprint expressed as Meta's component array.
 *
 * The blueprint arrives flattened (`header`, `body`, `footer`, `buttons` as
 * sibling keys) while everything downstream — picker, preview, send-time
 * parameter derivation — reads `components`. Building it here means an
 * instantiated library template is indistinguishable to those readers from any
 * other, and the next catalog sync overwrites it with Meta's own copy anyway.
 */
function libraryComponents(t: LibraryTemplate): TemplateComponent[] {
  const out: TemplateComponent[] = [];
  if (t.header) out.push({ type: "HEADER", format: "TEXT", text: t.header });
  out.push({ type: "BODY", text: t.body });
  if (t.footer) out.push({ type: "FOOTER", text: t.footer });
  if (t.buttons.length > 0) {
    out.push({
      type: "BUTTONS",
      buttons: t.buttons.map((b) => ({
        type: b.type as NonNullable<TemplateComponent["buttons"]>[number]["type"],
        ...(b.text ? { text: b.text } : {}),
        ...(b.url ? { url: b.url } : {}),
        ...(b.phone_number ? { phone_number: b.phone_number } : {}),
      })),
    });
  }
  return out;
}

/**
 * `code_expiration_minutes` for an authentication template's expiry footer.
 *
 * Meta allows 1–90. Undefined means "no expiry footer at all", which is a
 * different template from one that says "expires in 0 minutes" — so a blank is
 * never coerced to a number.
 */
function parseCodeExpirationMinutes(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number.parseInt(String(v), 10);
  if (!Number.isInteger(n) || n < 1 || n > 90) {
    throw new BadRequestException({
      error: "invalid_code_expiration",
      detail: "Code expiry must be a whole number of minutes between 1 and 90.",
    });
  }
  return n;
}

function parseCategory(v: unknown): TemplateCategory | null {
  if (v === "marketing" || v === "utility" || v === "authentication") return v;
  return null;
}

/**
 * `message_send_ttl_seconds` from the request body, checked against the
 * CATEGORY's range.
 *
 * Undefined (field absent or empty) means "let Meta apply the category default",
 * which is different from any number we could pick — so it is never
 * materialized into a value.
 *
 * The range is category-dependent and the ranges do not overlap at the low end
 * (a utility maximum of 12h is exactly the marketing minimum), so a TTL can only
 * be judged once the category is known. `-1` is Meta's documented sentinel for
 * "30 days" on authentication and utility templates — a naive `n <= 0` guard
 * rejects it, which blocks a real, useful value.
 */
function parseTtlSeconds(v: unknown, category: TemplateCategory): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new BadRequestException({
      error: "invalid_ttl",
      detail: "Time-to-live must be a whole number of seconds.",
    });
  }
  const problem = validateTemplateTtl(category, n);
  if (problem) {
    throw new BadRequestException({ error: "invalid_ttl", detail: problem });
  }
  return n;
}

/**
 * Loose parser for the request body's `components` array. We don't mirror
 * Meta's full type tree — anything Meta later rejects comes back as a 422
 * with their own error message. Only shape sanity is enforced (array of
 * objects with a known `type`).
 */
function parseComponents(v: unknown): TemplateComponent[] {
  if (!Array.isArray(v)) return [];
  const out: TemplateComponent[] = [];
  for (const c of v) {
    if (!c || typeof c !== "object") continue;
    const obj = c as Record<string, unknown>;
    if (
      obj.type !== "HEADER" &&
      obj.type !== "BODY" &&
      obj.type !== "FOOTER" &&
      obj.type !== "BUTTONS" &&
      // Parameterless: it turns the template into a request for permission to
      // CALL the recipient, which is the only way to ask outside the 24h window.
      obj.type !== "CALL_PERMISSION_REQUEST" &&
      // Countdown offer: declared here with its heading; the expiry INSTANT is
      // supplied per send.
      obj.type !== "LIMITED_TIME_OFFER" &&
      // Media-card carousel. Its cards nest their own components, which the
      // shared validator checks — this gate only decides the outer type.
      obj.type !== "CAROUSEL"
    ) {
      // Reject rather than silently drop — a component with an unrecognized
      // `type` means the template the agent built won't match what Meta
      // approves (the dropped component just vanishes, then the send fails with
      // a mismatched-parameter error nobody can trace back here).
      throw new BadRequestException({
        error: "invalid_template_component",
        detail: `Unknown template component type: ${JSON.stringify(obj.type)}. Expected HEADER, BODY, FOOTER, BUTTONS, CALL_PERMISSION_REQUEST, LIMITED_TIME_OFFER, or CAROUSEL.`,
      });
    }
    out.push(obj as unknown as TemplateComponent);
  }
  return out;
}
