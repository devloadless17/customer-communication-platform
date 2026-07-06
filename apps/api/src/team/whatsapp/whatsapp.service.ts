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

// Credentials live on a `ChannelConnection` row keyed by (teamId, provider).
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
  async getConfig(teamId: string): Promise<WhatsappConfigView> {
    const conn = await this.db.channelConnection.findUnique({
      where: { teamId_channel: { teamId, channel: META_PROVIDER } },
      select: { config: true, secrets: true },
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
        await this.db.channelConnection.upsert({
          where: { teamId_channel: { teamId, channel: META_PROVIDER } },
          create: {
            teamId,
            channel: META_PROVIDER,
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
      wabaId: config.wabaId ?? null,
      appId: config.appId ?? null,
      verifyToken,
      accessToken,
      appSecret,
      credentialsUndecryptable,
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
    teamId: string,
    input: UpdateWhatsappConfigInput,
  ): Promise<{
    config: {
      phoneNumberId: string;
      displayNumber: string | null;
      verifyToken: string;
    };
  }> {
    const { phoneNumberId, accessToken, appSecret } = input;

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

    const existing = await this.db.channelConnection.findUnique({
      where: { teamId_channel: { teamId, channel: META_PROVIDER } },
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
      input.verifyToken || existingConfig.verifyToken || randomBytes(24).toString("hex");

    // Phone-number uniqueness across teams. The old `Team.metaPhoneNumberId
    // @unique` constraint can't live on a JSON field, so guard at the app
    // layer: reject if another team already connected this number. (Pilot is
    // single-tenant; this preserves the same user-facing error for later.)
    const clash = await this.db.channelConnection.findFirst({
      where: {
        channel: META_PROVIDER,
        teamId: { not: teamId },
        config: { path: ["phoneNumberId"], equals: phoneNumberId },
      },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictException({
        error: "this phone number id is already connected to another team",
      });
    }

    const newConfig = pruneUndefined<MetaChannelConfig>({
      phoneNumberId,
      verifyToken,
      displayPhoneNumber: displayNumber ?? undefined,
      // wabaId / appId use optional-update semantics: undefined input preserves
      // the existing value; empty string clears it.
      wabaId: input.wabaId === undefined ? existingConfig.wabaId : input.wabaId || undefined,
      appId: input.appId === undefined ? existingConfig.appId : input.appId || undefined,
    });
    // Encrypted at rest with the app-wide ENCRYPTION_KEY (lib/crypto/envelope.ts).
    // Read paths (getMetaSendConfig / getMetaWebhookConfig) decrypt transparently.
    const newSecrets: MetaChannelSecrets = {
      accessToken: encryptSecret(accessToken),
      appSecret: encryptSecret(appSecret),
    };

    await this.db.channelConnection.upsert({
      where: { teamId_channel: { teamId, channel: META_PROVIDER } },
      create: {
        teamId,
        channel: META_PROVIDER,
        config: newConfig as Prisma.InputJsonValue,
        secrets: newSecrets as Prisma.InputJsonValue,
        isActive: true,
      },
      update: {
        config: newConfig as Prisma.InputJsonValue,
        secrets: newSecrets as Prisma.InputJsonValue,
        isActive: true,
      },
    });

    invalidateProviderConfig(teamId);

    // A reconnect can mint a brand-new ChannelConnection row (new id/createdAt).
    // Publish catalog_changed so the outbound-webhooks subscriber flushes its
    // per-team channelCache — otherwise webhook payloads keep stamping the old
    // connection's id. Scope-agnostic on the server side; the client's template
    // view (whose availability tracks the connection) refreshes too.
    await this.bus.publish({
      type: "team.catalog_changed",
      teamId,
      scope: "whatsapp-templates",
    });

    // Reconnecting WhatsApp resumes any broadcasts parked `paused` because creds
    // were missing/expired at fire time — so the detail page's "fix the
    // connection and it will auto-resume" is true on a stable box, not just
    // after a deploy. Fire-and-forget; per-recipient CAS makes resume
    // double-send-safe.
    void resumePausedBroadcastsForTeam(teamId).catch((err) => {
      this.logger.warn(
        `failed to resume paused broadcasts after WhatsApp settings save for team ${teamId}: ${
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
   * Wipe credentials but leave historical messages intact (multi-tenancy
   * rule #2 — integration toggles must not erase audit trail).
   */
  async disconnect(teamId: string): Promise<void> {
    // Drop the connection row entirely (wipes creds + verify token, matching
    // the old "null every meta_* column" behavior). Historical messages are
    // untouched — they live on their own tables. deleteMany so a
    // not-yet-connected team is a no-op rather than a 404.
    await this.db.channelConnection.deleteMany({
      where: { teamId, channel: META_PROVIDER },
    });
    invalidateProviderConfig(teamId);

    // Deleting the row leaves a stale id in the outbound-webhooks subscriber's
    // channelCache; catalog_changed flushes it (see updateConfig for the same
    // reasoning) so post-disconnect webhook payloads don't carry a dangling id.
    await this.bus.publish({
      type: "team.catalog_changed",
      teamId,
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
  async listTemplates(teamId: string): Promise<{
    templates: TemplateDto[];
    hasWabaId: boolean;
    hasAppId: boolean;
    connected: boolean;
  }> {
    const [rows, conn] = await Promise.all([
      this.db.messageTemplate.findMany({
        where: { teamId },
        orderBy: [{ status: "asc" }, { name: "asc" }, { language: "asc" }],
      }),
      this.db.channelConnection.findUnique({
        where: { teamId_channel: { teamId, channel: META_PROVIDER } },
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
   * `(teamId, name, language)`. We don't delete rows that disappear from
   * Meta — admins pause/unpause templates and we want the local row's
   * status to flip through the lifecycle, not vanish and reappear.
   */
  async syncTemplates(teamId: string): Promise<{
    templates: TemplateDto[];
    syncedCount: number;
  }> {
    const config = await this.requireSendConfig(teamId);
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
          where: {
            teamId_name_language: { teamId, name: t.name, language: t.language },
          },
          create: {
            teamId,
            externalId: t.externalId ?? null,
            name: t.name,
            language: t.language,
            category: t.category,
            status: t.status,
            bodyText: t.bodyText,
            components: t.components as unknown as Prisma.InputJsonValue,
            syncedAt: now,
          },
          update: {
            externalId: t.externalId ?? null,
            category: t.category,
            status: t.status,
            bodyText: t.bodyText,
            components: t.components as unknown as Prisma.InputJsonValue,
            syncedAt: now,
          },
        }),
      ),
    );

    const rows = await this.db.messageTemplate.findMany({
      where: { teamId },
      orderBy: [{ status: "asc" }, { name: "asc" }, { language: "asc" }],
    });

    // Tell every tab — including the triggering agent — that the cached
    // catalog moved, so two admins watching /settings/whatsapp don't see
    // different lists until one navigates.
    await this.bus.publish({
      type: "team.catalog_changed",
      teamId,
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
    teamId: string,
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

    const config = await this.requireSendConfig(teamId);
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

    const now = new Date();
    const saved = await this.db.messageTemplate.upsert({
      where: { teamId_name_language: { teamId, name, language } },
      create: {
        teamId,
        externalId: created.externalId,
        name,
        language,
        category,
        status: created.status,
        bodyText: body.text,
        components: components as unknown as Prisma.InputJsonValue,
        variableBindings: variableBindings as Prisma.InputJsonValue,
        syncedAt: now,
      },
      update: {
        externalId: created.externalId,
        category,
        status: created.status,
        bodyText: body.text,
        components: components as unknown as Prisma.InputJsonValue,
        variableBindings: variableBindings as Prisma.InputJsonValue,
        syncedAt: now,
      },
    });

    await this.bus.publish({
      type: "team.catalog_changed",
      teamId,
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
  async deleteTemplate(teamId: string, id: string): Promise<void> {
    const template = await this.db.messageTemplate.findFirst({
      where: { id, teamId },
    });
    if (!template) throw new NotFoundException({ error: "template not found" });

    const config = await this.requireSendConfig(teamId);
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
      teamId,
      scope: "whatsapp-templates",
    });
  }

  /** Update variableBindings only — the part of the template our app owns. */
  async updateTemplateBindings(
    teamId: string,
    id: string,
    input: UpdateTemplateBindingsInput,
  ): Promise<void> {
    const updated = await this.db.messageTemplate.updateMany({
      where: { id, teamId },
      data: {
        variableBindings: input.variableBindings as Prisma.InputJsonValue,
      },
    });
    if (updated.count === 0) {
      throw new NotFoundException({ error: "template not found" });
    }
    await this.bus.publish({
      type: "team.catalog_changed",
      teamId,
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
    teamId: string,
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

    const config = await this.requireSendConfig(teamId);
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

  private async requireSendConfig(teamId: string) {
    try {
      return await getMetaSendConfig(teamId);
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
      continue;
    }
    out.push(obj as unknown as TemplateComponent);
  }
  return out;
}
