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
    const team = await this.db.team.findUnique({
      where: { id: teamId },
      select: {
        metaPhoneNumberId: true,
        metaDisplayPhoneNumber: true,
        metaWabaId: true,
        metaAppId: true,
        metaVerifyToken: true,
        metaAccessToken: true,
        metaAppSecret: true,
      },
    });
    if (!team) {
      return {
        phoneNumberId: null,
        displayPhoneNumber: null,
        wabaId: null,
        appId: null,
        verifyToken: null,
        accessToken: null,
        appSecret: null,
        credentialsUndecryptable: false,
      };
    }
    // Tolerate decrypt failure here (key rotated, value corrupt, wrong env):
    // surface it via the `credentialsUndecryptable` flag so the page can ask
    // the admin to re-paste. The send path in lib/providers/config.ts stays
    // strict — there, a failed decrypt is loud (silent send-nothing is worse).
    const accessToken = this.tryDecrypt(team.metaAccessToken, "metaAccessToken");
    const appSecret = this.tryDecrypt(team.metaAppSecret, "metaAppSecret");
    const credentialsUndecryptable =
      (team.metaAccessToken != null && accessToken === null) ||
      (team.metaAppSecret != null && appSecret === null);

    // Pre-mint a verify token on first read so the onboarding UI can show
    // "Step 1 — paste this into Meta" before any credentials are saved.
    // Race-safe via `metaVerifyToken: null` predicate — a concurrent first
    // load becomes a no-op write. Failure degrades to "shown next load",
    // not a page error.
    let verifyToken = team.metaVerifyToken;
    if (verifyToken == null) {
      const minted = randomBytes(24).toString("hex");
      try {
        const res = await this.db.team.updateMany({
          where: { id: teamId, metaVerifyToken: null },
          data: { metaVerifyToken: minted },
        });
        if (res.count > 0) {
          verifyToken = minted;
        } else {
          const refreshed = await this.db.team.findUnique({
            where: { id: teamId },
            select: { metaVerifyToken: true },
          });
          verifyToken = refreshed?.metaVerifyToken ?? minted;
        }
      } catch (err) {
        this.logger.warn(
          `could not pre-mint verify token: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return {
      phoneNumberId: team.metaPhoneNumberId,
      displayPhoneNumber: team.metaDisplayPhoneNumber,
      wabaId: team.metaWabaId,
      appId: team.metaAppId,
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
        { headers: { authorization: `Bearer ${accessToken}` } },
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

    // Verify-token resolution order:
    //   1. Explicit value from input (legacy callers / future re-rotate UI).
    //   2. Existing team row value (pre-minted by getConfig on first load,
    //      or set on a prior save). Stable across re-saves — critical so
    //      Meta's stored verify token stays valid when an admin clicks
    //      "Validate & save" again.
    //   3. Fresh random (defensive — getConfig pre-mints, so this branch
    //      shouldn't fire in practice).
    let verifyToken = input.verifyToken;
    if (!verifyToken) {
      const existing = await this.db.team.findUnique({
        where: { id: teamId },
        select: { metaVerifyToken: true },
      });
      verifyToken = existing?.metaVerifyToken ?? randomBytes(24).toString("hex");
    }

    try {
      await this.db.team.update({
        where: { id: teamId },
        data: {
          metaPhoneNumberId: phoneNumberId,
          // Encrypted at rest with the app-wide ENCRYPTION_KEY
          // (lib/crypto/envelope.ts). Read paths (getMetaSendConfig /
          // getMetaWebhookConfig) decrypt transparently — nothing reads
          // these columns raw, so rewrites stay safe.
          metaAccessToken: encryptSecret(accessToken),
          metaAppSecret: encryptSecret(appSecret),
          metaVerifyToken: verifyToken,
          metaDisplayPhoneNumber: displayNumber ?? null,
          // wabaId / appId use optional-update semantics — see schema doc.
          ...(input.wabaId === undefined
            ? {}
            : { metaWabaId: input.wabaId || null }),
          ...(input.appId === undefined
            ? {}
            : { metaAppId: input.appId || null }),
        },
      });
    } catch (err) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code?: string }).code === "P2002"
      ) {
        throw new ConflictException({
          error: "this phone number id is already connected to another team",
        });
      }
      throw err;
    }

    invalidateProviderConfig(teamId);

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
    await this.db.team.update({
      where: { id: teamId },
      data: {
        metaPhoneNumberId: null,
        metaAccessToken: null,
        metaAppSecret: null,
        metaVerifyToken: null,
        metaDisplayPhoneNumber: null,
        metaWabaId: null,
        metaAppId: null,
      },
    });
    invalidateProviderConfig(teamId);
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
    const [rows, team] = await Promise.all([
      this.db.messageTemplate.findMany({
        where: { teamId },
        orderBy: [{ status: "asc" }, { name: "asc" }, { language: "asc" }],
      }),
      this.db.team.findUnique({
        where: { id: teamId },
        select: { metaWabaId: true, metaAppId: true, metaPhoneNumberId: true },
      }),
    ]);
    return {
      templates: rows.map(toTemplateDto),
      hasWabaId: Boolean(team?.metaWabaId),
      hasAppId: Boolean(team?.metaAppId),
      connected: Boolean(team?.metaPhoneNumberId),
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
