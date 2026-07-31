import { Body, Controller, Get, Param, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";

import { RateLimit } from "@/common/rate-limit.interceptor";

import { ApiKeyGuard } from "../../auth/api-key.guard";
import type { ApiKeyContext } from "../../auth/api-key.guard";
import { CurrentApiKey } from "../../auth/current-session.decorator";
import { RequireScope } from "../../auth/scope.decorator";
import { ScopeGuard } from "../../auth/scope.guard";
import { zBody, zQuery } from "../../common/zod-validation.pipe";
import { CreateExportSchema, ListTransfersQuerySchema, type CreateExportInput, type ListTransfersQueryInput } from "@/contacts/transfer.schemas";
import { TRANSFER_MAX_UPLOAD_BYTES } from "@ccp/shared/contacts/transfer-columns";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { tmpdir } from "node:os";
import type { Response } from "express";
import { ContactTransferService } from "@/contacts/transfer.service";

/**
 * /v1 CONTACT IMPORT / EXPORT — peeled from the ExternalV1Controller (2026-07-31 split).
 * Same base path + guard stack; check:v1-docs discovers every
 * *.controller.ts here, so a peel cannot drop a route from coverage.
 */
@Controller("api/external/v1")
@UseGuards(ApiKeyGuard, ScopeGuard)
@RateLimit({ perMinute: 600 })
export class ExternalV1ContactTransfersController {
  constructor(
    private readonly transfers: ContactTransferService,
  ) {}

  /**
   * Queue an export. Returns a job id immediately; poll
   * `GET /v1/contacts/transfers/:id` and then fetch
   * `GET /v1/contacts/transfers/:id/download` once `status` is `completed`.
   *
   * Rate-limited hard: each call can produce a full dump of the contact book,
   * which is both expensive to generate and the single most sensitive payload
   * this API can emit.
   */
  @Post("contacts/export")
  @RequireScope("read:contacts")
  @RateLimit({ perMinute: 5 })
  async startContactExport(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(CreateExportSchema)) body: CreateExportInput,
  ) {
    // No acting user on an API-key call; the job records the key's team and is
    // fetched back through the same team-scoped reads.
    return this.transfers.startExport({ workspaceId: auth.workspaceId, userId: null, input: body });
  }

  /** Upload a CSV/XLSX and get back the staged key + detected mapping. */
  @Post("contacts/import/upload")
  @RequireScope("write:contacts")
  @RateLimit({ perMinute: 10 })
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({ destination: tmpdir() }),
      limits: { fileSize: TRANSFER_MAX_UPLOAD_BYTES },
    }),
  )
  async uploadContactImport(
    @CurrentApiKey() auth: ApiKeyContext,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.transfers.preview(auth.workspaceId, file);
  }

  @Get("contacts/transfers")
  @RequireScope("read:contacts")
  async listContactTransfers(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query(zQuery(ListTransfersQuerySchema)) query: ListTransfersQueryInput,
  ) {
    return this.transfers.list(auth.workspaceId, query);
  }

  @Get("contacts/transfers/:id")
  @RequireScope("read:contacts")
  async getContactTransfer(@CurrentApiKey() auth: ApiKeyContext, @Param("id") id: string) {
    return { job: await this.transfers.get(auth.workspaceId, id) };
  }

  /**
   * 302 to a short-lived presigned URL. Partners that can't follow redirects
   * can read the `Location` header directly.
   */
  @Get("contacts/transfers/:id/download")
  @RequireScope("read:contacts")
  async downloadContactTransfer(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Res() res: Response,
  ): Promise<void> {
    res.redirect(302, await this.transfers.downloadUrl(auth.workspaceId, id, "result"));
  }

  @Get("contacts/transfers/:id/errors")
  @RequireScope("read:contacts")
  async errorsContactTransfer(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Res() res: Response,
  ): Promise<void> {
    res.redirect(302, await this.transfers.downloadUrl(auth.workspaceId, id, "errors"));
  }

  @Post("contacts/transfers/:id/cancel")
  @RequireScope("write:contacts")
  async cancelContactTransfer(@CurrentApiKey() auth: ApiKeyContext, @Param("id") id: string) {
    return this.transfers.cancel(auth.workspaceId, id);
  }

  // ---- Contacts: create / upsert / update / delete ------------------

}
