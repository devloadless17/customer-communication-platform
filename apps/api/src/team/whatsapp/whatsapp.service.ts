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

import { resumePausedBroadcastsForTeam } from "@/lib/broadcast-runner";
import { decryptSecret, encryptSecret } from "@/lib/crypto/envelope";
import { getMetaProvider } from "@/lib/providers";
import {
  getMetaSendConfig,
  invalidateProviderConfig,
  ProviderNotConfiguredError,
} from "@/lib/providers/config";
import { getMetaConnection } from "@/lib/providers/meta-connection";
import { fetchWhatsappHealthFromGraph } from "@/lib/providers/meta-health";
import {
  MetaSendError,
  MissingAppIdError,
  MissingWabaIdError,
} from "@/lib/providers/meta";
import type { WhatsappConfigView } from "@ccp/shared/dtos";
import type {
  ProviderTemplate,
  TemplateCategory,
  TemplateComponent,
} from "@ccp/shared/providers/types";
import type { TemplateDto } from "@ccp/shared/types";
import {
  templateNamedPlaceholders,
  validateTemplateComponents,
} from "@ccp/shared/template-render";

import { EventBus } from "../../events/event-bus.module";
import { DbService } from "../../db/db.service";
import type {
  UpdateTemplateBindingsInput,
  UpdateWhatsappConfigInput,
} from "./whatsapp.schemas";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v25.0";
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
  }> {
    const { phoneNumberId } = input;

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
    try {
      const res = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name`,
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
          error: "meta rejected credentials",
          status: res.status,
          detail: body.slice(0, 500),
        });
      }
      const data = (await res.json()) as { display_phone_number?: string };
      displayNumber = data.display_phone_number;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error("meta validation failed", err);
      throw new BadGatewayException({
        error: "could not reach meta to validate",
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

    // Phone-number uniqueness across teams. The old `Team.metaPhoneNumberId
    // @unique` constraint can't live on a JSON field, so guard at the app
    // layer: reject if another team already connected this number. (Pilot is
    // single-tenant; this preserves the same user-facing error for later.)
    const clash = await this.db.channelConnection.findFirst({
      where: {
        channel: META_PROVIDER,
        workspaceId: { not: workspaceId },
        config: { path: ["phoneNumberId"], equals: phoneNumberId },
      },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictException({
        error: "this phone number id is already connected to another team",
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
      await this.assertWabaOwnsNumber(nextWabaId, phoneNumberId, accessToken);
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
    await this.db.channelConnection.upsert({
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
        config: newConfig as Prisma.InputJsonValue,
        secrets: newSecrets as Prisma.InputJsonValue,
        isActive: true,
        // A fresh token clears any prior expired-token (Graph 190) flag.
        needsReconnect: false,
        lastAuthErrorAt: null,
      },
    });

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
    void fetchWhatsappHealthFromGraph(workspaceId).catch((err) => {
      this.logger.warn(
        `failed to fetch WhatsApp messaging health after settings save for team ${workspaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });

    return {
      config: {
        phoneNumberId,
        displayNumber: displayNumber ?? null,
        verifyToken,
      },
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
  private async assertWabaOwnsNumber(
    wabaId: string,
    phoneNumberId: string,
    accessToken: string,
  ): Promise<void> {
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
        this.logger.warn(
          `skipping waba-ownership check: meta returned ${res.status} reading ${wabaId}/phone_numbers`,
        );
        return;
      }
      const data = (await res.json()) as { data?: Array<{ id?: string }> };
      numbers = data.data ?? [];
    } catch (err) {
      this.logger.warn(
        `skipping waba-ownership check: could not reach meta (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      return;
    }
    if (!numbers.some((n) => n.id === phoneNumberId)) {
      throw new BadRequestException({
        error: "waba id does not own this phone number",
        detail:
          "This WhatsApp Business Account ID doesn't contain the phone number you connected — you've likely pasted the WABA ID of a different (e.g. test) account. In WhatsApp Manager → Account tools → Phone numbers, copy the WABA ID that owns this number.",
      });
    }
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
  async listTemplates(workspaceId: string): Promise<{
    templates: TemplateDto[];
    hasWabaId: boolean;
    hasAppId: boolean;
    connected: boolean;
  }> {
    const [rows, conn] = await Promise.all([
      this.db.messageTemplate.findMany({
        where: { workspaceId },
        orderBy: [{ status: "asc" }, { name: "asc" }, { language: "asc" }],
      }),
      this.db.channelConnection.findFirst({
        where: { workspaceId, channel: META_PROVIDER, isDefault: true },
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
    const config = await this.requireSendConfig(workspaceId);
    const provider = getMetaProvider();
    if (!provider.fetchTemplates) {
      throw new HttpException(
        { error: "provider does not support templates" },
        501,
      );
    }

    let fetched: ProviderTemplate[];
    try {
      fetched = await provider.fetchTemplates(config);
    } catch (err) {
      this.throwIfMissingWaba(err);
      this.throwIfMetaSendError(err);
      this.logger.error("template sync failed", err);
      throw new BadGatewayException({
        error: "sync failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const now = new Date();
    await this.db.$transaction(
      fetched.map((t) =>
        this.db.messageTemplate.upsert({
          // Templates are scoped to a WABA (numbers under one WABA share a
          // catalog), so the key includes it: two WABAs in one workspace may each
          // hold a template with the same name+language.
          where: {
            workspaceId_wabaId_name_language: {
              workspaceId,
              wabaId: config.wabaId ?? "",
              name: t.name,
              language: t.language,
            },
          },
          create: {
            workspaceId,
            externalId: t.externalId ?? null,
            name: t.name,
            language: t.language,
            category: t.category,
            status: t.status,
            bodyText: t.bodyText,
            components: t.components as unknown as Prisma.InputJsonValue,
            // Meta's own answer, not our inference — see the schema comment.
            parameterFormat: t.parameterFormat,
            syncedAt: now,
          },
          update: {
            externalId: t.externalId ?? null,
            category: t.category,
            status: t.status,
            bodyText: t.bodyText,
            components: t.components as unknown as Prisma.InputJsonValue,
            parameterFormat: t.parameterFormat,
            syncedAt: now,
          },
        }),
      ),
    );

    // Reconcile deletions: anything local but absent from this authoritative
    // fetch is stale (deleted in WhatsApp Manager, or imported earlier under a
    // now-corrected wabaId). Match on (name, language) — the upsert's identity,
    // immutable in Meta — and spare rows touched in the last 60s so a freshly
    // created template racing Meta's list propagation survives.
    // Delimit the composite key with an ESCAPED NUL, never a raw byte: a raw
    // NUL in source makes grep/rg classify this file as binary and skip it.
    const fetchedKeys = new Set(
      fetched.map((t) => `${t.name}\u0000${t.language}`),
    );
    const graceCutoff = new Date(now.getTime() - 60_000);
    const localRows = await this.db.messageTemplate.findMany({
      where: { workspaceId },
      select: { id: true, name: true, language: true, syncedAt: true },
    });
    const staleIds = localRows
      .filter(
        (r) =>
          !fetchedKeys.has(`${r.name}\u0000${r.language}`) &&
          r.syncedAt < graceCutoff,
      )
      .map((r) => r.id);
    if (staleIds.length > 0) {
      await this.db.messageTemplate.deleteMany({
        where: { workspaceId, id: { in: staleIds } },
      });
      this.logger.log(
        `template sync for team ${workspaceId} pruned ${staleIds.length} stale template(s)`,
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
      syncedCount: fetched.length,
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
        error: "invalid name",
        detail:
          "Template name must be lowercase letters, digits and underscores only.",
      });
    }
    if (!language || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(language)) {
      throw new BadRequestException({
        error: "invalid language",
        detail: "Use a Meta language code like en_US, fr, pt_BR.",
      });
    }
    if (!category) {
      throw new BadRequestException({
        error: "invalid category",
        detail: "Pick marketing, utility or authentication.",
      });
    }
    if (components.length === 0) {
      throw new BadRequestException({
        error: "components required",
        detail: "At least a BODY component is required.",
      });
    }
    const body = components.find((c) => c.type === "BODY");
    if (!body || !body.text || body.text.trim().length === 0) {
      throw new BadRequestException({
        error: "body required",
        detail: "Add a body — it's the only required component.",
      });
    }

    // Meta's own field limits, checked BEFORE the Graph call. A rejection from
    // Meta arrives as an opaque `#100 Invalid parameter` with no field name, so
    // an author who pasted a 1,200-character body would learn only that
    // "something" was wrong. Same pure validator the create form uses, so the
    // character counter and this rejection can't disagree.
    const issues = validateTemplateComponents(name, components);
    if (issues.length > 0) {
      throw new BadRequestException({
        error: "template_invalid",
        detail: issues.map((i) => i.message).join(" "),
        issues,
      });
    }

    const config = await this.requireSendConfig(workspaceId);
    const provider = getMetaProvider();
    if (!provider.createTemplate) {
      throw new HttpException(
        { error: "provider cannot create templates" },
        501,
      );
    }

    let created;
    try {
      created = await provider.createTemplate(
        { name, language, category, components },
        config,
      );
    } catch (err) {
      this.throwIfMissingWaba(err);
      this.throwIfMetaSendError(err, 1000);
      this.logger.error("template create failed", err);
      throw new BadGatewayException({
        error: "create failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const authoredParameterFormat =
      templateNamedPlaceholders(body.text).length > 0 ? "named" : "positional";

    const now = new Date();
    const saved = await this.db.messageTemplate.upsert({
      where: {
        workspaceId_wabaId_name_language: {
          workspaceId,
          wabaId: config.wabaId ?? "",
          name,
          language,
        },
      },
      create: {
        workspaceId,
        externalId: created.externalId,
        name,
        language,
        category,
        status: created.status,
        bodyText: body.text,
        components: components as unknown as Prisma.InputJsonValue,
        variableBindings: variableBindings as Prisma.InputJsonValue,
        // Derived from the body WE authored, which is the one case where
        // inference is safe: we know there is no literal `{{word}}` copy in it,
        // because the composer wrote every placeholder. The next sync replaces
        // this with Meta's authoritative `parameter_format` anyway.
        parameterFormat: authoredParameterFormat,
        syncedAt: now,
      },
      update: {
        externalId: created.externalId,
        category,
        status: created.status,
        bodyText: body.text,
        components: components as unknown as Prisma.InputJsonValue,
        variableBindings: variableBindings as Prisma.InputJsonValue,
        parameterFormat: authoredParameterFormat,
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
    if (!template) throw new NotFoundException({ error: "template not found" });

    const config = await this.requireSendConfig(workspaceId);
    const provider = getMetaProvider();
    if (!provider.deleteTemplate) {
      throw new HttpException(
        { error: "provider does not support template delete" },
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
        error: "delete failed",
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
      throw new NotFoundException({ error: "template not found" });
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
        error: "file too large",
        detail: `Header media must be under ${Math.floor(UPLOAD_MAX_BYTES / 1024 / 1024)} MB.`,
      });
    }
    const mimeType = file.mimetype || "application/octet-stream";
    if (!UPLOAD_ALLOWED_MIME.has(mimeType)) {
      throw new UnsupportedMediaTypeException({
        error: "unsupported media type",
        detail: `Got ${mimeType}. Supported: ${Array.from(UPLOAD_ALLOWED_MIME).join(", ")}.`,
      });
    }
    const filename = file.originalname || "upload";

    const config = await this.requireSendConfig(workspaceId);
    const provider = getMetaProvider();
    if (!provider.uploadHeaderMedia) {
      throw new HttpException(
        { error: "provider does not support template media uploads" },
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
          error: "app id missing",
          detail:
            "Add your Meta App ID in Settings → WhatsApp before uploading template media.",
        });
      }
      this.throwIfMetaSendError(err);
      this.logger.error("template media upload failed", err);
      throw new BadGatewayException({
        error: "upload failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async requireSendConfig(workspaceId: string) {
    try {
      return await getMetaSendConfig(workspaceId);
    } catch (err) {
      if (err instanceof ProviderNotConfiguredError) {
        throw new ConflictException({
          error: "whatsapp not connected",
          detail: err.message,
        });
      }
      throw err;
    }
  }

  private throwIfMissingWaba(err: unknown): void {
    if (err instanceof MissingWabaIdError) {
      throw new ConflictException({
        error: "waba id missing",
        detail:
          "Add your WhatsApp Business Account ID in Settings → WhatsApp to load templates.",
      });
    }
  }

  private throwIfMetaSendError(err: unknown, detailLimit = 500): void {
    if (err instanceof MetaSendError) {
      throw new UnprocessableEntityException({
        error: "meta rejected request",
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
  name: string;
  language: string;
  category: string;
  status: string;
  bodyText: string;
  components: Prisma.JsonValue;
  variableBindings: Prisma.JsonValue;
  parameterFormat: string;
  syncedAt: Date;
}): TemplateDto {
  return {
    id: row.id,
    externalId: row.externalId,
    name: row.name,
    language: row.language,
    category: row.category,
    status: row.status,
    bodyText: row.bodyText,
    components: Array.isArray(row.components)
      ? (row.components as unknown as TemplateComponent[])
      : [],
    variableBindings: row.variableBindings ?? {},
    parameterFormat: row.parameterFormat === "named" ? "named" : "positional",
    syncedAt: row.syncedAt.toISOString(),
  };
}

function parseCategory(v: unknown): TemplateCategory | null {
  if (v === "marketing" || v === "utility" || v === "authentication") return v;
  return null;
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
      obj.type !== "BUTTONS"
    ) {
      // Reject rather than silently drop — a component with an unrecognized
      // `type` means the template the agent built won't match what Meta
      // approves (the dropped component just vanishes, then the send fails with
      // a mismatched-parameter error nobody can trace back here).
      throw new BadRequestException({
        error: "invalid_template_component",
        detail: `Unknown template component type: ${JSON.stringify(obj.type)}. Expected HEADER, BODY, FOOTER, or BUTTONS.`,
      });
    }
    out.push(obj as unknown as TemplateComponent);
  }
  return out;
}
