import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import type { Response } from "express";

import { resolvePermissions } from "@ccp/shared/auth/permissions";
import {
  TRANSFER_FORMAT_MIME,
  TRANSFER_MAX_UPLOAD_BYTES,
  type TransferFormat,
} from "@ccp/shared/contacts/transfer-columns";

import { RequireCapability } from "../auth/capability.guard";
import { CurrentSession } from "../auth/current-session.decorator";
import { DenyRestrictedViewer } from "../auth/restricted-viewer.guard";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { zBody, zQuery } from "../common/zod-validation.pipe";
import {
  CreateExportSchema,
  ListTransfersQuerySchema,
  parseImportOptions,
  type CreateExportInput,
  type ListTransfersQueryInput,
} from "./transfer.schemas";
import { ContactTransferService } from "./transfer.service";

/**
 * Contact import/export surface.
 *
 *   POST /api/contacts/import/preview   — inspect an upload, get headers + mapping
 *   POST /api/contacts/import           — queue an import of a staged upload
 *   POST /api/contacts/export           — queue an export
 *   GET  /api/contacts/transfers        — recent jobs
 *   GET  /api/contacts/transfers/:id    — one job's status + counters
 *   GET  /api/contacts/transfers/:id/download  — 302 → presigned artifact
 *   GET  /api/contacts/transfers/:id/errors    — 302 → presigned error report
 *   POST /api/contacts/transfers/:id/cancel
 *   GET  /api/contacts/transfer-template?format=csv|xlsx
 *   GET  /api/contacts/export-columns
 *
 * Every route is thin: validate, delegate to ContactTransferService, shape the
 * response. All of the work lives in lib/contact-transfer/** (CLAUDE.md §4).
 *
 * Uploads use DISK storage, not multer's default memory storage — see the
 * service's `acceptUpload`.
 */
@Controller("api/contacts")
@UseGuards(SessionGuard)
export class ContactTransferController {
  constructor(private readonly transfers: ContactTransferService) {}

  @Post("import/preview")
  @RequireCapability("contacts:import")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({ destination: tmpdir() }),
      limits: { fileSize: TRANSFER_MAX_UPLOAD_BYTES },
    }),
  )
  async preview(
    @CurrentSession() session: ApiSession,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.transfers.preview(session.workspaceId, file);
  }

  @Post("import")
  @RequireCapability("contacts:import")
  async startImport(
    @CurrentSession() session: ApiSession,
    @Body() body: Record<string, unknown>,
  ) {
    const uploadKey = typeof body.uploadKey === "string" ? body.uploadKey : "";
    const filename = typeof body.filename === "string" ? body.filename : "contacts.csv";
    const format = body.format === "xlsx" ? "xlsx" : "csv";
    if (!uploadKey) throw new BadRequestException({ error: "missing_upload_key" });

    // Import auto-creates unknown tag names. Gate that on the same
    // `tags:manage` capability the tag CRUD endpoints require, so someone who
    // can import but not manage tags can't create them through the back door.
    // Without it, import links only to EXISTING tags.
    const canManageTags = !!resolvePermissions(session.role, session.rolePermissions)[
      "tags:manage"
    ];

    return this.transfers.startImport({
      workspaceId: session.workspaceId,
      userId: session.userId,
      uploadKey,
      filename,
      format,
      options: parseImportOptions(
        typeof body.options === "string" ? body.options : JSON.stringify(body.options ?? {}),
      ),
      canManageTags,
    });
  }

  @Post("export")
  @RequireCapability("contacts:export")
  // Browsing the directory is open to restricted agents; EXPORTING the whole
  // book is not — the capability defaults true for agents, so the visibility
  // boundary needs its own gate here. Product decision 2026-08-10.
  @DenyRestrictedViewer()
  async startExport(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreateExportSchema)) body: CreateExportInput,
  ) {
    return this.transfers.startExport({
      workspaceId: session.workspaceId,
      userId: session.userId,
      input: body,
    });
  }

  @Get("transfers")
  async list(
    @CurrentSession() session: ApiSession,
    @Query(zQuery(ListTransfersQuerySchema)) query: ListTransfersQueryInput,
  ) {
    return this.transfers.list(session.workspaceId, query);
  }

  @Get("transfers/:id")
  async get(@CurrentSession() session: ApiSession, @Param("id") id: string) {
    return this.transfers.get(session.workspaceId, id);
  }

  /**
   * 302 to a short-lived presigned URL rather than proxying the bytes: a 25 MB
   * export streamed through the API is 25 MB of Node event-loop time we can
   * hand to R2 for free. The redirect target is team-checked before it's
   * minted, so the key itself never has to be guessable.
   */
  @Get("transfers/:id/download")
  @RequireCapability("contacts:export")
  // Same boundary as startExport: the bytes are the whole book.
  @DenyRestrictedViewer()
  async download(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Res() res: Response,
  ): Promise<void> {
    const url = await this.transfers.downloadUrl(session.workspaceId, id, "result");
    res.redirect(302, url);
  }

  @Get("transfers/:id/errors")
  @RequireCapability("contacts:import")
  async errors(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Res() res: Response,
  ): Promise<void> {
    const url = await this.transfers.downloadUrl(session.workspaceId, id, "errors");
    res.redirect(302, url);
  }

  @Post("transfers/:id/cancel")
  async cancel(@CurrentSession() session: ApiSession, @Param("id") id: string) {
    return this.transfers.cancel(session.workspaceId, id);
  }

  /** Blank import template in either format. */
  @Get("transfer-template")
  async template(
    @CurrentSession() session: ApiSession,
    @Query("format") formatRaw: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const format: TransferFormat = formatRaw === "xlsx" ? "xlsx" : "csv";
    const { path, filename, cleanup } = await this.transfers.template(session.workspaceId, format);
    res
      .status(200)
      .set("content-type", TRANSFER_FORMAT_MIME[format])
      .set("content-disposition", `attachment; filename="${filename}"`);
    const stream = createReadStream(path);
    // Delete the temp file once the response is done either way — a client that
    // disconnects mid-download must not leave the file behind.
    res.on("close", () => void cleanup());
    stream.pipe(res);
  }

  @Get("export-columns")
  @RequireCapability("contacts:export")
  async exportColumns(@CurrentSession() session: ApiSession) {
    return this.transfers.exportColumns(session.workspaceId);
  }

  /**
   * Backward-compatible one-shot export: `GET /api/contacts/export` still
   * behaves like a plain download link, so any existing bookmark, script, or
   * `<a download>` keeps working.
   *
   * It is NOT a second implementation — it queues the same job, waits for the
   * runner, and redirects to the same presigned artifact. That keeps exactly
   * one export code path (CLAUDE.md §17: no parallel pattern for something the
   * codebase already does) while preserving the old URL's contract.
   *
   * A team large enough to exceed the wait budget gets a 202 with the job id;
   * the in-app UI never hits this route, so that only affects scripted callers,
   * which can poll `/transfers/:id` like the UI does.
   */
  @Get("export")
  @RequireCapability("contacts:export")
  async legacyExport(
    @CurrentSession() session: ApiSession,
    @Query("format") formatRaw: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const format: TransferFormat = formatRaw === "xlsx" ? "xlsx" : "csv";
    let jobId: string;
    try {
      ({ jobId } = await this.transfers.startExport({
        workspaceId: session.workspaceId,
        userId: session.userId,
        input: { format, filters: {} },
      }));
    } catch (e) {
      // The one-transfer-per-team gate would turn this legacy download link
      // into a 409 whenever an unrelated import happens to be running — a
      // scripted caller hitting a bookmarked URL has no idea what that means
      // and nothing to retry against. Answer with the honest 503 + Retry-After
      // instead, which every HTTP client already understands.
      if (e instanceof ConflictException) {
        res
          .status(503)
          .set("retry-after", "30")
          .json({
            error: "transfer_in_progress",
            detail:
              "Another contact import or export is running. Retry shortly, or use POST /api/contacts/export to queue one.",
          });
        return;
      }
      throw e;
    }
    const done = await this.transfers.waitForTerminal(session.workspaceId, jobId, LEGACY_WAIT_MS);
    if (done?.status === "completed") {
      res.redirect(302, await this.transfers.downloadUrl(session.workspaceId, jobId, "result"));
      return;
    }
    if (done?.status === "failed") {
      res.status(500).json({ error: "export_failed", detail: done.error });
      return;
    }
    // Still running — hand back the job id rather than holding the connection.
    res.status(202).json({ jobId, status: done?.status ?? "running" });
  }
}

/** How long the legacy synchronous-looking export route waits before handing
 *  back a job id instead. Comfortably covers a normal team; a 100k export is
 *  expected to fall through to the 202. */
const LEGACY_WAIT_MS = 60_000;
