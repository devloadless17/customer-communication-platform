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
import { getMetaProvider } from "@/lib/providers";
import {
  getMetaSendConfig,
  invalidateProviderConfig,
  ProviderNotConfiguredError,
} from "@/lib/providers/config";
import { getMetaConnection } from "@/lib/providers/meta-connection";
import {
  fetchWhatsappHealthFromGraph,
  gcOrphanWhatsappPortfolios,
  getWhatsappHealth,
} from "@/lib/providers/meta-health";
import { ensureWabaSubscribed } from "@/lib/providers/meta-waba-subscription";
import { normalizeDefaultAccount } from "@/lib/providers/normalize-default-account";
import {
  readTemplateAnalytics,
  refreshTemplateAnalytics,
} from "@/lib/analytics/template-analytics";
import {
  MetaSendError,
  MissingAppIdError,
  MissingWabaIdError,
} from "@/lib/providers/meta";
import type { WhatsappConfigView } from "@ccp/shared/dtos";
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
import { syncTemplateCatalog } from "@/lib/templates/catalog-sync";

import { EventBus } from "../../events/event-bus.module";
import { DbService } from "../../db/db.service";
import type {
  UpdateTemplateBindingsInput,
  UpdateWhatsappConfigInput,
  UpdateBusinessProfileInput,
  CreateQrCodeInput,
  UpdateQrCodeInput,
} from "./whatsapp.schemas";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v25.0";

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
   * Tradeoff considered (carried over from the pre-NestJS RSC page comment):
   * we ship the access token + app secret to the admin's browser so the
   * "Update credentials" form can pre-fill them. Acceptable for a
   * single-admin pilot; for multi-admin teams, swap to a mask + reveal-on-demand
   * pattern (one extra route) so the field isn't readable from every admin's
   * devtools. The decryption is a net win regardless: this endpoint replaces
   * the old RSC page that imported `decryptSecret` directly into apps/web,
   * which is why the envelope key no longer needs to live in the web image.
   */
  async getConfig(workspaceId: string): Promise<WhatsappConfigView> {
    const conn = await this.db.channelConnection.findFirst({
      where: { workspaceId, channel: META_PROVIDER, isDefault: true },
      select: {
        config: true,
        secrets: true,
        needsReconnect: true,
        // Messaging limit is portfolio-scoped (Meta, 2025-10-07).
        portfolio: { select: { messagingTier: true, messagingDailyCap: true } },
        qualityRating: true,
        throughputLevel: true,
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
          `could not pre-mint verify token: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return {
      phoneNumberId: config.phoneNumberId ?? null,
      displayPhoneNumber: config.displayPhoneNumber ?? null,
      wabaId: config.wabaId ?? "",
      appId: config.appId ?? null,
      verifyToken,
      accessToken,
      appSecret,
      credentialsUndecryptable,
      needsReconnect: conn?.needsReconnect ?? false,
      messagingTier: conn?.portfolio?.messagingTier ?? null,
      messagingDailyCap: conn?.portfolio?.messagingDailyCap ?? null,
      qualityRating: conn?.qualityRating ?? null,
      throughputLevel: conn?.throughputLevel ?? null,
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

    // Source the access token (system-user) + App secret from the shared Meta
    // App connection unless overridden on this form.
    const meta = await getMetaConnection(workspaceId);
    const accessToken = input.accessToken?.trim() || meta?.systemUserToken || null;
    const appSecret = input.appSecret?.trim() || meta?.appSecret || null;
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
    try {
      // One node read validates the credentials AND captures the number's
      // identity + readiness: `verified_name`/`name_status` (a NONE/EXPIRED
      // name voids the certificate) and `status`/`code_verification_status`
      // (an unregistered number saves cleanly but fails every send).
      const res = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(phoneNumberId)}` +
          `?fields=display_phone_number,verified_name,name_status,code_verification_status,status`,
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
      // endpoint below is the fix.
      const status = data.status?.toUpperCase();
      if (status && status !== "CONNECTED") {
        warnings.push(
          `This number's Cloud API status is ${status} — sends will fail until it is ` +
            `registered. Use "Register number" (two-step PIN) or register it in WhatsApp Manager.`,
        );
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

    const existing = await this.db.channelConnection.findFirst({
      where: { workspaceId, channel: META_PROVIDER, isDefault: true },
      select: { config: true },
    });
    const existingConfig = (existing?.config ?? {}) as MetaChannelConfig;

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
    const nextWabaId =
      input.wabaId === undefined ? existingConfig.wabaId : input.wabaId || undefined;
    if (nextWabaId) {
      const wabaWarning = await this.assertWabaOwnsNumber(
        nextWabaId,
        phoneNumberId,
        accessToken,
      );
      if (wabaWarning) warnings.push(wabaWarning);
    }

    const newConfig = pruneUndefined<MetaChannelConfig>({
      phoneNumberId,
      verifyToken,
      displayPhoneNumber: displayNumber ?? undefined,
      // wabaId keeps optional-update semantics (WhatsApp-specific, for templates).
      wabaId: nextWabaId,
      // appId is shared — source it from the Meta App connection (used for
      // template header-media upload); a pasted value or existing one overrides.
      appId: input.appId?.trim() || meta?.appId || existingConfig.appId || undefined,
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
        wabaId: newConfig.wabaId ?? null,
        // The number's Meta-verified identity, captured by the node read above.
        verifiedName: verifiedName ?? null,
        nameStatus: nameStatus ?? null,
        // First account on this channel becomes the send default.
        isDefault: !(await this.db.channelConnection.count({
          where: { workspaceId, channel: META_PROVIDER },
        })),
        config: newConfig as Prisma.InputJsonValue,
        secrets: newSecrets as Prisma.InputJsonValue,
        isActive: true,
      },
      update: {
        wabaId: newConfig.wabaId ?? null,
        // Refresh identity on every save; only overwrite with real values so a
        // Meta hiccup can't blank a stored name (the webhook keeps it live).
        ...(verifiedName !== undefined ? { verifiedName } : {}),
        ...(nameStatus !== undefined ? { nameStatus } : {}),
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
      const sub = await ensureWabaSubscribed(nextWabaId, accessToken, GRAPH_VERSION);
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
  ): Promise<{ externalId: string; wabaId: string | null }> {
    const row = await this.db.messageTemplate.findFirst({
      where: { id: templateId, workspaceId },
      select: { externalId: true, wabaId: true },
    });
    if (!row) throw new NotFoundException({ error: "template_not_found" });
    if (!row.externalId) {
      // A locally-created template awaiting Meta approval has no id there yet,
      // so there is nothing to look up — say that rather than returning an
      // empty series that reads as "nobody engaged".
      throw new BadRequestException({ error: "template_not_synced" });
    }
    // `""` is the legacy/unknown-WABA sentinel; treat it as "no opinion" so the
    // default account is used, which is right for a single-account workspace.
    return { externalId: row.externalId, wabaId: row.wabaId || null };
  }

  /** Stored daily rollup for one template. No Graph call. */
  async templateAnalytics(workspaceId: string, templateId: string, daysRaw?: string) {
    const { externalId } = await this.templateRef(workspaceId, templateId);
    const { start, end } = this.analyticsWindow(daysRaw);
    return readTemplateAnalytics(workspaceId, externalId, start, end);
  }

  /** Pull fresh figures from Meta for one template, then store them. */
  async refreshTemplateAnalytics(
    workspaceId: string,
    templateId: string,
    daysRaw?: string,
  ) {
    const { externalId, wabaId } = await this.templateRef(workspaceId, templateId);
    const { start, end } = this.analyticsWindow(daysRaw);
    return refreshTemplateAnalytics(workspaceId, {
      templateExternalIds: [externalId],
      start,
      end,
      wabaId,
    });
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
    if ((a.wabaId ?? "") !== (b.wabaId ?? "")) {
      throw new BadRequestException({
        error: "different_waba",
        detail:
          "Both templates must belong to the same WhatsApp Business Account to be compared.",
      });
    }

    const config = await this.requireSendConfig(workspaceId);
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

  private async assertWabaOwnsNumber(
    wabaId: string,
    phoneNumberId: string,
    accessToken: string,
  ): Promise<string | null> {
    let numbers: Array<{ id?: string }>;
    try {
      const res = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(wabaId)}/phone_numbers?fields=id&limit=200`,
        {
          headers: { authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!res.ok) {
        // A skip is not silent anymore: 401/403 means the token can't read the
        // WABA (`whatsapp_business_management` missing) — ownership is
        // unverified AND template sync + portfolio discovery will be degraded,
        // which the admin standing at the form can actually fix.
        this.logger.warn(
          `skipping waba-ownership check: meta returned ${res.status} reading ${wabaId}/phone_numbers`,
        );
        return res.status === 401 || res.status === 403
          ? "Your access token can't read this WhatsApp Business Account " +
              "(whatsapp_business_management scope missing?). WABA ownership was NOT " +
              "verified, and template sync + business-portfolio discovery will be " +
              "degraded until the token can read it."
          : `Couldn't verify this WABA owns the number (Meta returned ${res.status}); ` +
              "connected anyway. If templates look wrong, re-check the WABA ID.";
      }
      const data = (await res.json()) as { data?: Array<{ id?: string }> };
      numbers = data.data ?? [];
    } catch (err) {
      this.logger.warn(
        `skipping waba-ownership check: could not reach meta (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      return (
        "Couldn't reach Meta to verify this WABA owns the number; connected anyway. " +
        "If templates look wrong, re-check the WABA ID."
      );
    }
    if (!numbers.some((n) => n.id === phoneNumberId)) {
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
    let res: Response;
    try {
      res = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(config.phoneNumberId)}/register`,
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
  async disconnect(workspaceId: string): Promise<void> {
    // Drop the connection row entirely (wipes creds + verify token, matching
    // the old "null every meta_* column" behavior). Historical messages are
    // untouched — they live on their own tables. deleteMany so a
    // not-yet-connected team is a no-op rather than a 404.
    await this.db.channelConnection.deleteMany({
      where: { workspaceId, channel: META_PROVIDER },
    });
    // Every portfolio row just lost all its connections (SetNull FK) — GC them
    // so a later reconnect starts clean instead of self-healing onto a stale
    // container.
    await gcOrphanWhatsappPortfolios(workspaceId);
    invalidateProviderConfig(workspaceId);

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
    let scopeWabaId: string | null = null;
    if (accountId) {
      const account = await this.db.channelConnection.findFirst({
        where: { id: accountId, workspaceId, channel: META_PROVIDER },
        select: { wabaId: true },
      });
      if (!account) {
        throw new NotFoundException({ error: "account_not_found" });
      }
      // `""` is the legacy/unknown sentinel — treat it as "no opinion" and show
      // everything, rather than silently returning an empty catalogue.
      scopeWabaId = account.wabaId || null;
    }

    const [rows, conn] = await Promise.all([
      this.db.messageTemplate.findMany({
        where: {
          workspaceId,
          ...(scopeWabaId ? { wabaId: scopeWabaId } : {}),
        },
        orderBy: [{ status: "asc" }, { name: "asc" }, { language: "asc" }],
      }),
      this.db.channelConnection.findFirst({
        where: {
          workspaceId,
          channel: META_PROVIDER,
          ...(accountId ? { id: accountId } : { isDefault: true }),
        },
        select: { config: true },
      }),
    ]);
    const config = (conn?.config ?? {}) as MetaChannelConfig;
    return {
      templates: rows.map(toTemplateDto),
      hasWabaId: Boolean(config.wabaId),
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
  async syncTemplates(workspaceId: string): Promise<{
    templates: TemplateDto[];
    syncedCount: number;
  }> {
    // Fail fast with the actionable message when nothing is connected at all;
    // the sync itself is per-account and fail-soft inside syncTemplateCatalog.
    const config = await this.requireSendConfig(workspaceId);
    if (!config.wabaId) {
      throw new ConflictException({
        error: "waba_id_missing",
        detail:
          "Add your WhatsApp Business Account ID in Settings \u2192 WhatsApp to load templates.",
      });
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
      where: { workspaceId },
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

    const config = await this.requireSendConfig(workspaceId);
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
    const wabaId = config.wabaId ?? "";
    // The category META ASSIGNED, not the one we asked for. Since 2025-04-09 a
    // UTILITY submission whose content reads as promotional is approved as
    // MARKETING outright, and storing our request instead left the row claiming
    // a cheaper category than Meta bills. Fall back to the requested value only
    // when Meta's response omitted the field.
    const assignedCategory = created.category ?? category;
    const saved = await this.db.messageTemplate.upsert({
      where: {
        workspaceId_wabaId_name_language: { workspaceId, wabaId, name, language },
      },
      create: {
        workspaceId,
        // Must be written explicitly. Leaving it to the column default ("")
        // while the WHERE matched on the real WABA meant every create under a
        // connected WABA missed its own row on the next lookup and stranded a
        // duplicate that no per-WABA sync would ever reconcile.
        wabaId,
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
    const config = await this.requireSendConfig(workspaceId);
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

    const config = await this.requireSendConfig(workspaceId);
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
    const config = await this.requireSendConfig(workspaceId);
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

    const config = await this.requireSendConfig(workspaceId);
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
    const wabaId = config.wabaId ?? "";
    const saved = await this.db.messageTemplate.upsert({
      where: {
        workspaceId_wabaId_name_language: { workspaceId, wabaId, name, language },
      },
      create: {
        workspaceId,
        wabaId,
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

    const config = await this.requireSendConfig(workspaceId);
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

    const config = await this.requireSendConfig(workspaceId);
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
      select: { id: true, externalId: true, status: true, name: true },
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

    const config = await this.requireSendConfig(workspaceId);
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

  /** Update variableBindings only — the part of the template our app owns. */
  async updateTemplateBindings(
    workspaceId: string,
    id: string,
    input: UpdateTemplateBindingsInput,
  ): Promise<void> {
    const updated = await this.db.messageTemplate.updateMany({
      where: { id, workspaceId },
      data: {
        variableBindings: input.variableBindings as Prisma.InputJsonValue,
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

    const config = await this.requireSendConfig(workspaceId);
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

function toTemplateDto(row: {
  id: string;
  externalId: string | null;
  wabaId: string;
  name: string;
  language: string;
  category: string;
  correctCategory: string | null;
  status: string;
  statusReason: string | null;
  archivedAt: Date | null;
  lastUsedAt: Date | null;
  qualityScore: string | null;
  qualityScoreAt: Date | null;
  libraryTemplateName: string | null;
  bodyText: string;
  components: Prisma.JsonValue;
  variableBindings: Prisma.JsonValue;
  parameterFormat: string;
  messageSendTtlSeconds: number | null;
  syncedAt: Date;
}): TemplateDto {
  return {
    id: row.id,
    externalId: row.externalId,
    wabaId: row.wabaId,
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
    archivedAt: row.archivedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    qualityScore: row.qualityScore,
    qualityScoreAt: row.qualityScoreAt?.toISOString() ?? null,
    libraryTemplateName: row.libraryTemplateName,
    messageSendTtlSeconds: row.messageSendTtlSeconds,
    bodyText: row.bodyText,
    components: Array.isArray(row.components)
      ? (row.components as unknown as TemplateComponent[])
      : [],
    variableBindings: row.variableBindings ?? {},
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
