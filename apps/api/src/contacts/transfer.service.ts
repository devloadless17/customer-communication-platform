import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import {
  TRANSFER_FORMAT_MIME,
  TRANSFER_MAX_UPLOAD_BYTES,
  TRANSFER_COLUMNS,
  type TransferFormat,
} from "@ccp/shared/contacts/transfer-columns";

import { Prisma } from "@prisma/client";

import { DbService } from "@/db/db.service";
import { blobStorage } from "@/lib/blob-storage";
import { fieldHeader, resolveExportColumns, suggestMapping } from "@/lib/contact-transfer/columns";
import { createSink, createSource } from "@/lib/contact-transfer/formats";
import {
  enqueueContactTransfer,
  MAX_CONCURRENT_TRANSFERS_PER_TEAM,
  removeContactTransfer,
} from "@/lib/contact-transfer/queue";

import type { CreateExportInput, CreateImportInput } from "./transfer.schemas";

/** Artifacts + job rows are reaped this long after creation. A contact export
 *  is a bulk PII dump; it must not sit in the bucket indefinitely. */
const ARTIFACT_TTL_DAYS = 7;

/** Rows shown in the mapping step's preview table. */
const PREVIEW_ROWS = 20;

/** Presigned download validity — long enough to click, short enough to not be
 *  a shareable link to the whole contact book. */
const DOWNLOAD_TTL_SECONDS = 300;

@Injectable()
export class ContactTransferService {
  constructor(private readonly db: DbService) {}

  /**
   * Inspect an uploaded file WITHOUT importing it: headers, a few sample rows,
   * and our suggested column mapping.
   *
   * Doing this server-side (rather than parsing in the browser as the old
   * dialog did) means CSV and Excel behave identically, the client ships no
   * parser, and the mapping the user confirms is derived from the same code
   * that will actually run the import.
   */
  async preview(
    workspaceId: string,
    file: Express.Multer.File | undefined,
  ): Promise<{
    headers: string[];
    sampleRows: Array<Record<string, string>>;
    suggestedMapping: Record<string, string>;
    fields: Array<{ key: string; label: string }>;
    builtins: Array<{ id: string; label: string }>;
    uploadKey: string;
    filename: string;
    format: TransferFormat;
  }> {
    const { format, path, cleanup } = await this.acceptUpload(file);
    try {
      const source = createSource(format, path);
      const headers = await source.headers();
      if (headers.length === 0) {
        throw new BadRequestException({
          error: "empty_file",
          detail: "The file has no header row.",
        });
      }
      const sampleRows: Array<Record<string, string>> = [];
      for await (const { cells } of source.rows()) {
        sampleRows.push(cells);
        if (sampleRows.length >= PREVIEW_ROWS) break;
      }
      await source.close();

      const fields = await this.db.contactFieldDefinition.findMany({
        where: { workspaceId },
        orderBy: [{ order: "asc" }, { createdAt: "asc" }],
        select: { key: true, label: true },
      });

      // Park the file in R2 under a preview key so the RUN call doesn't have to
      // re-upload it. The user has already waited for one upload; making them
      // wait again after the mapping step would be the slowest part of the
      // whole flow for a 50 MB file.
      const uploadKey = `contact-imports/${workspaceId}/staged-${randomUUID()}.${format}`;
      await blobStorage.putObjectFromFile({
        key: uploadKey,
        path,
        contentType: TRANSFER_FORMAT_MIME[format],
      });

      return {
        headers,
        sampleRows,
        suggestedMapping: suggestMapping(headers, fields),
        fields,
        builtins: TRANSFER_COLUMNS.filter((c) => c.importable).map((c) => ({
          id: c.id,
          label: c.label,
        })),
        uploadKey,
        filename: file?.originalname ?? `contacts.${format}`,
        format,
      };
    } finally {
      await cleanup();
    }
  }

  /**
   * Queue an import of a previously-staged upload (from `preview`).
   *
   * Returns immediately with a job id — the file is already in R2 and the
   * worker streams it from there, so nothing large crosses this request.
   */
  async startImport(args: {
    workspaceId: string;
    /** null for an API-key caller — there is no acting human. */
    userId: string | null;
    uploadKey: string;
    filename: string;
    format: TransferFormat;
    options: CreateImportInput;
    canManageTags: boolean;
  }): Promise<{ jobId: string }> {
    // The staged key comes from the client, so it must be proven to belong to
    // THIS team before the worker is pointed at it — otherwise a caller could
    // hand us another tenant's staged file and import their contact book.
    const expectedPrefix = `contact-imports/${args.workspaceId}/`;
    if (!args.uploadKey.startsWith(expectedPrefix) || args.uploadKey.includes("..")) {
      throw new BadRequestException({ error: "invalid_upload_key" });
    }

    await this.assertNoRunningJob(args.workspaceId);

    const job = await this.createJob({
      workspaceId: args.workspaceId,
      kind: "import",
      format: args.format,
      createdByUserId: args.userId,
      filename: args.filename,
      sourceKey: args.uploadKey,
      options: {
        mode: args.options.mode,
        tagMode: args.options.tagMode,
        fireAutomations: args.options.fireAutomations,
        mapping: args.options.mapping ?? {},
        canManageTags: args.canManageTags,
        // Persisted on the JOB, not just passed through, so a resumed import
        // resolves national numbers the same way the first attempt did — a
        // half-imported file must not end up with two different identities for
        // the same person.
        defaultCountry: args.options.defaultCountry,
      },
      expiresAt: expiry(),
    });
    await enqueueContactTransfer(job.id);
    return { jobId: job.id };
  }

  async startExport(args: {
    workspaceId: string;
    /** null for an API-key caller — there is no acting human. */
    userId: string | null;
    input: CreateExportInput;
  }): Promise<{ jobId: string }> {
    await this.assertNoRunningJob(args.workspaceId);

    const format = args.input.format as TransferFormat;
    const stamp = new Date().toISOString().slice(0, 10);
    const job = await this.createJob({
      workspaceId: args.workspaceId,
      kind: "export",
      format,
      createdByUserId: args.userId,
      filename: `contacts-${stamp}.${format}`,
      options: {
        // Explicit selection wins over filters — see the schema's note.
        ...(args.input.ids?.length ? { scopeIds: args.input.ids } : {}),
        filters: args.input.filters ?? {},
      },
      expiresAt: expiry(),
    });
    await enqueueContactTransfer(job.id);
    return { jobId: job.id };
  }

  async list(workspaceId: string, opts: { limit: number; kind?: "import" | "export" }) {
    const rows = await this.db.contactTransferJob.findMany({
      where: { workspaceId, ...(opts.kind ? { kind: opts.kind } : {}) },
      orderBy: { createdAt: "desc" },
      take: opts.limit,
      select: JOB_SELECT,
    });
    return { jobs: rows.map(toWire) };
  }

  async get(workspaceId: string, id: string) {
    const row = await this.db.contactTransferJob.findFirst({
      // workspaceId in the where, not a post-hoc check: a job id from another tenant
      // must 404, and the only way to guarantee that is to never load it.
      where: { id, workspaceId },
      select: JOB_SELECT,
    });
    if (!row) throw new NotFoundException({ error: "not_found" });
    return toWire(row);
  }

  /** Presigned URL for the produced artifact (`result`) or the failed-rows report. */
  async downloadUrl(
    workspaceId: string,
    id: string,
    which: "result" | "errors",
  ): Promise<string> {
    const row = await this.db.contactTransferJob.findFirst({
      where: { id, workspaceId },
      select: { artifactKey: true, errorArtifactKey: true, filename: true, format: true },
    });
    if (!row) throw new NotFoundException({ error: "not_found" });
    const key = which === "errors" ? row.errorArtifactKey : row.artifactKey;
    if (!key) throw new NotFoundException({ error: "no_artifact" });

    const downloadFilename =
      which === "errors"
        ? row.filename.replace(/\.[^.]+$/, "") + `-errors.${row.format}`
        : row.filename;
    return blobStorage.presignGetUrl(key, {
      ttlSeconds: DOWNLOAD_TTL_SECONDS,
      downloadFilename,
    });
  }

  /**
   * Cancel a queued or running job. The runner polls the row between batches,
   * so a running job stops within one batch; already-applied rows STAY applied
   * (a partial import is not rolled back — the counters and the error report
   * say exactly what landed).
   */
  async cancel(workspaceId: string, id: string): Promise<{ ok: true }> {
    const res = await this.db.contactTransferJob.updateMany({
      where: { id, workspaceId, status: { in: ["pending", "running"] } },
      data: { status: "canceled", finishedAt: new Date() },
    });
    if (res.count === 0) {
      const exists = await this.db.contactTransferJob.findFirst({
        where: { id, workspaceId },
        select: { id: true },
      });
      if (!exists) throw new NotFoundException({ error: "not_found" });
      // Already terminal — treat as success so a double-click isn't an error.
    }
    await removeContactTransfer(id);
    return { ok: true };
  }

  /**
   * Downloadable import template: the canonical header row plus one obviously-
   * fake example row that documents the formats inline (phone WITH country
   * code, comma-separated tags, stage by name). The #1 import mistake is the
   * phone format, and an example is the clearest possible guidance.
   *
   * Built from the same shared column table the importer classifies against,
   * so a fresh download always matches what the server will accept.
   */
  async template(
    workspaceId: string,
    format: TransferFormat,
  ): Promise<{ path: string; filename: string; cleanup: () => Promise<void> }> {
    const fieldDefs = await this.db.contactFieldDefinition.findMany({
      where: { workspaceId, isVisible: true },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
      select: { key: true, label: true },
    });
    // Importable columns only — a template containing `source`/`id` would
    // invite the user to fill in columns we ignore.
    const builtins = TRANSFER_COLUMNS.filter((c) => c.importable);
    // fieldHeader disambiguates a custom field whose label a built-in would
    // shadow; without it the template offers two columns ("language" and
    // "Language") that both land in the built-in.
    const columns = [...builtins.map((c) => c.header), ...fieldDefs.map(fieldHeader)];
    const example: Record<string, string> = {};
    for (const c of builtins) example[c.header] = c.example ?? "";

    const path = join(tmpdir(), `ccp-template-${randomUUID()}.${format}`);
    const sink = createSink(format, path, "Contacts");
    await sink.writeHeader(columns);
    await sink.writeRows([example]);
    await sink.finish();
    return {
      path,
      filename: `contacts-template.${format}`,
      cleanup: async () => {
        await unlink(path).catch(() => {});
      },
    };
  }

  /**
   * Poll a job until it leaves pending/running, or the budget expires.
   *
   * Only the backward-compatible `GET /api/contacts/export` route uses this —
   * the UI is socket-driven and never blocks on a job. Polling (rather than
   * waiting on a socket/pubsub) keeps it correct even if the job is picked up
   * by the other worker slot, and 500 ms is far below the wait budget.
   */
  async waitForTerminal(
    workspaceId: string,
    id: string,
    budgetMs: number,
  ): Promise<{ status: string; error: string | null } | null> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const row = await this.db.contactTransferJob.findFirst({
        where: { id, workspaceId },
        select: { status: true, error: true },
      });
      if (!row) return null;
      if (row.status !== "pending" && row.status !== "running") return row;
      if (Date.now() >= deadline) return row;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /** Column list for the export preview ("this file will have these columns"). */
  async exportColumns(workspaceId: string): Promise<{ columns: string[] }> {
    const { columns } = await resolveExportColumns(workspaceId);
    return { columns };
  }

  // -------------------------------------------------------------------------

  /**
   * One in-flight job per team. Reported as a 409 rather than a silent queue so
   * the user is told "your other import is still running" instead of watching a
   * job sit at 0% for ten minutes.
   *
   * This is the FRIENDLY path only. It's a read-then-write with no lock, so two
   * requests arriving together both see zero and both proceed — the partial
   * unique index `ContactTransferJob_workspaceId_active_key` is what actually
   * enforces the invariant, and `createJob` maps its P2002 to this same error.
   */
  private async assertNoRunningJob(workspaceId: string): Promise<void> {
    const running = await this.db.contactTransferJob.count({
      where: { workspaceId, status: { in: ["pending", "running"] } },
    });
    if (running >= MAX_CONCURRENT_TRANSFERS_PER_TEAM) throw transferInProgress();
  }

  /**
   * Insert a job row, translating the active-transfer unique violation into the
   * same 409 the pre-check produces. Without this a lost race surfaces as a
   * raw 500 from the Prisma exception filter.
   */
  private async createJob(
    data: Prisma.ContactTransferJobUncheckedCreateInput,
  ): Promise<{ id: string }> {
    try {
      return await this.db.contactTransferJob.create({ data, select: { id: true } });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002" &&
        String(e.meta?.target ?? "").includes("active")
      ) {
        throw transferInProgress();
      }
      throw e;
    }
  }

  /**
   * Validate a multipart upload and land it on local disk.
   *
   * Multer is configured with DISK storage for this route, not memory: a 50 MiB
   * file per concurrent upload held as a Buffer is heap we have no reason to
   * spend on a 2 GB container that also serves the inbox.
   */
  private async acceptUpload(
    file: Express.Multer.File | undefined,
  ): Promise<{ format: TransferFormat; path: string; cleanup: () => Promise<void> }> {
    if (!file) throw new BadRequestException({ error: "missing_file" });
    if (file.size > TRANSFER_MAX_UPLOAD_BYTES) {
      await unlink(file.path).catch(() => {});
      throw new BadRequestException({
        error: "file_too_large",
        detail: `The file is larger than ${Math.round(TRANSFER_MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`,
      });
    }
    const cleanup = async (): Promise<void> => {
      await unlink(file.path).catch(() => {});
    };
    try {
      const format = await detectFormat(file);
      return { format, path: file.path, cleanup };
    } catch (e) {
      await cleanup();
      throw e;
    }
  }
}

function transferInProgress(): ConflictException {
  return new ConflictException({
    error: "transfer_in_progress",
    detail: "Another contact import or export is still running. Wait for it to finish.",
  });
}

function expiry(): Date {
  return new Date(Date.now() + ARTIFACT_TTL_DAYS * 24 * 3600 * 1000);
}

/**
 * Decide CSV vs XLSX from the CONTENT, not the filename.
 *
 * An .xlsx is a ZIP, so its first bytes are always "PK\x03\x04". Trusting the
 * extension alone means a user who renamed `book.xlsx` to `book.csv` (people
 * do this constantly) gets a parse failure full of binary garbage instead of a
 * successful import. Sniffing also stops a mislabelled binary from reaching
 * the CSV parser at all.
 */
async function detectFormat(file: Express.Multer.File): Promise<TransferFormat> {
  const magic = await readFirstBytes(file.path, 4);
  const isZip = magic[0] === 0x50 && magic[1] === 0x4b; // "PK"
  if (isZip) return "xlsx";

  const name = (file.originalname ?? "").toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    // Named like a workbook but isn't a ZIP — a legacy .xls (OLE2) or a
    // renamed file. Both would produce nonsense through either parser, so say
    // so plainly rather than failing deep inside a batch.
    throw new BadRequestException({
      error: "unsupported_format",
      detail:
        "That looks like an old .xls file. Open it in Excel and save as .xlsx (or export as CSV), then upload again.",
    });
  }
  return "csv";
}

function readFirstBytes(path: string, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(path, { start: 0, end: n - 1 });
    stream.on("data", (c) => chunks.push(c as Buffer));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

const JOB_SELECT = {
  id: true,
  kind: true,
  format: true,
  status: true,
  filename: true,
  processedRows: true,
  totalRows: true,
  created: true,
  updated: true,
  revived: true,
  skipped: true,
  failed: true,
  automationsSkipped: true,
  artifactKey: true,
  artifactBytes: true,
  errorArtifactKey: true,
  errorSample: true,
  error: true,
  createdByUserId: true,
  startedAt: true,
  finishedAt: true,
  createdAt: true,
  expiresAt: true,
} as const;

type JobRow = {
  [K in keyof typeof JOB_SELECT]: unknown;
};

/**
 * Wire shape. R2 keys are deliberately NOT exposed — the client gets booleans
 * and asks for a presigned URL through the download route, which re-checks the
 * team. Handing out object keys would leak the bucket layout and invite a
 * client to construct one.
 */
function toWire(row: JobRow) {
  return {
    id: row.id as string,
    kind: row.kind as "import" | "export",
    format: row.format as TransferFormat,
    status: row.status as string,
    filename: row.filename as string,
    processedRows: row.processedRows as number,
    totalRows: row.totalRows as number | null,
    created: row.created as number,
    updated: row.updated as number,
    revived: row.revived as number,
    skipped: row.skipped as number,
    failed: row.failed as number,
    automationsSkipped: row.automationsSkipped as boolean,
    hasArtifact: Boolean(row.artifactKey),
    artifactBytes: row.artifactBytes as number | null,
    hasErrorReport: Boolean(row.errorArtifactKey),
    details: row.errorSample,
    error: row.error as string | null,
    createdByUserId: row.createdByUserId as string | null,
    startedAt: row.startedAt as Date | null,
    finishedAt: row.finishedAt as Date | null,
    createdAt: row.createdAt as Date,
    expiresAt: row.expiresAt as Date,
  };
}
