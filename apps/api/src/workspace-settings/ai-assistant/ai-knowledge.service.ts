import { randomUUID } from "node:crypto";

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from "@nestjs/common";

import { blobStorage } from "@/lib/blob-storage";

import { DbService } from "../../db/db.service";

/**
 * Knowledge-file ingestion for the AI Assistant (correction #8 + #13).
 *
 * Upload -> validated + stored under a PRIVATE, team-prefixed R2 key ->
 * bounded text extraction (size/char/time caps, encrypted-PDF rejected) ->
 * chunked into AiContextChunk rows for keyword/full-text retrieval. Deleting a
 * document removes its R2 object AND its chunks (FK cascade). Only the top
 * tenant-filtered chunks are ever injected into a prompt — retrieval lives in
 * lib/ai/knowledge-retrieval.ts, never "inject every document".
 */

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_FILES_PER_TEAM = 50;
const MAX_EXTRACT_CHARS = 200_000;
const EXTRACT_TIMEOUT_MS = 20_000;
const CHUNK_CHARS = 3000;
const CHUNK_OVERLAP = 300;

// Extension-independent allowlist. PDF/DOCX get real extraction; the text
// family is decoded as UTF-8. Anything else is rejected up front.
const ALLOWED_MIME = new Set<string>([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);

interface UploadInput {
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
}

@Injectable()
export class AiKnowledgeService {
  private readonly logger = new Logger(AiKnowledgeService.name);

  constructor(private readonly db: DbService) {}

  async list(workspaceId: string) {
    return this.db.aiContextDocument.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });
  }

  async upload(workspaceId: string, input: UploadInput) {
    const mimeType = normalizeMime(input.mimeType, input.filename);
    if (!ALLOWED_MIME.has(mimeType)) {
      throw new BadRequestException({
        error: "unsupported_file_type",
        detail: "Allowed: PDF, DOCX, TXT, Markdown, CSV, JSON.",
      });
    }
    if (input.bytes.length === 0) {
      throw new BadRequestException({ error: "empty_file" });
    }
    if (input.bytes.length > MAX_FILE_BYTES) {
      throw new PayloadTooLargeException({ error: "file_too_large", maxBytes: MAX_FILE_BYTES });
    }
    const count = await this.db.aiContextDocument.count({ where: { workspaceId } });
    if (count >= MAX_FILES_PER_TEAM) {
      throw new BadRequestException({ error: "too_many_files", max: MAX_FILES_PER_TEAM });
    }

    // Private, tenant-scoped key. putObject skips the media magic-byte sniff
    // (these are first-party admin uploads, validated above).
    const key = `ai-knowledge/${workspaceId}/${randomUUID()}`;
    await blobStorage.putObject({ key, bytes: input.bytes, contentType: mimeType });

    const doc = await this.db.aiContextDocument.create({
      data: {
        workspaceId,
        filename: input.filename.slice(0, 255),
        mimeType,
        sizeBytes: input.bytes.length,
        r2Key: key,
        status: "processing",
      },
    });

    // Extract + chunk detached from the request. The row already carries
    // status=processing so the settings UI shows a spinner; process() flips it
    // to ready/failed. Errors are swallowed into the row, never thrown here.
    void this.process(doc.id, workspaceId, input.bytes, mimeType).catch((err) => {
      this.logger.error(`process(${doc.id}) failed: ${String(err)}`);
    });

    return doc;
  }

  async setEnabled(workspaceId: string, id: string, enabled: boolean) {
    const doc = await this.db.aiContextDocument.findFirst({ where: { workspaceId, id } });
    if (!doc) throw new NotFoundException({ error: "document_not_found" });
    return this.db.aiContextDocument.update({ where: { id }, data: { enabled } });
  }

  async reprocess(workspaceId: string, id: string) {
    const doc = await this.db.aiContextDocument.findFirst({ where: { workspaceId, id } });
    if (!doc) throw new NotFoundException({ error: "document_not_found" });
    const fetched = await blobStorage.fetch(doc.r2Key);
    await this.db.aiContextDocument.update({
      where: { id },
      data: { status: "processing", error: null },
    });
    void this.process(id, workspaceId, fetched.bytes, doc.mimeType).catch((err) => {
      this.logger.error(`reprocess(${id}) failed: ${String(err)}`);
    });
    return { ok: true };
  }

  /** Delete the document, its R2 object, and (via FK cascade) its chunks. */
  async remove(workspaceId: string, id: string) {
    const doc = await this.db.aiContextDocument.findFirst({ where: { workspaceId, id } });
    if (!doc) throw new NotFoundException({ error: "document_not_found" });
    // Storage first — a leaked chunk row is harmless; a leaked private blob is
    // not. delete() is idempotent, so a retry after a partial failure is safe.
    await blobStorage.delete(doc.r2Key);
    await this.db.aiContextDocument.delete({ where: { id } }); // chunks cascade
    return { ok: true };
  }

  // --- internal ---

  private async process(id: string, workspaceId: string, bytes: Uint8Array, mimeType: string) {
    try {
      // SERIALIZED process-wide. `pdf-parse` / `mammoth` are CPU-bound and
      // synchronous inside their promises, so `withTimeout` — a Promise.race —
      // resolves the WRAPPER but cannot interrupt the work: the 20s ceiling is
      // not the bound it looks like. This is the same process that hosts
      // Socket.io, Meta webhook ingest and every BullMQ worker for every tenant
      // on the box, and `process()` is detached (the caller already got its
      // 200), so N concurrent uploads would otherwise stack N stalls.
      //
      // One at a time bounds that to a single document's parse. It does NOT
      // eliminate the stall for one pathological 10MB file — the real fix is a
      // worker thread, which is deliberately NOT built here: the trigger is a
      // measured stall from a real upload, and the uploader is an authenticated
      // workspace admin (10MB cap, 50 docs), not an anonymous caller. Recorded
      // in tests/VERIFICATION.md so it isn't rediscovered as unknown.
      const raw = await extractionGate(() =>
        withTimeout(extractText(bytes, mimeType), EXTRACT_TIMEOUT_MS, "extraction_timeout"),
      );
      const text = raw.split("\u0000").join("").trim().slice(0, MAX_EXTRACT_CHARS);
      if (!text) {
        await this.markFailed(id, "no_text_extracted");
        return;
      }
      const chunks = chunkText(text);
      // ONE createMany, not up to 2000 individual `create`s in the array form
      // of $transaction — that shipped 2001 round-trips and held the write
      // transaction open for all of them on a pool this whole process shares.
      await this.db.$transaction([
        this.db.aiContextChunk.deleteMany({ where: { documentId: id } }),
        this.db.aiContextChunk.createMany({
          data: chunks.map((content, ordinal) => ({
            workspaceId,
            documentId: id,
            ordinal,
            content,
            tokenCount: approxTokens(content),
          })),
        }),
        this.db.aiContextDocument.update({
          where: { id },
          data: {
            status: "ready",
            error: null,
            chunkCount: chunks.length,
            tokenCount: approxTokens(text),
            processedAt: new Date(),
          },
        }),
      ]);
    } catch (err) {
      await this.markFailed(id, extractErrorCode(err));
    }
  }

  private async markFailed(id: string, error: string) {
    await this.db.aiContextDocument
      .update({ where: { id }, data: { status: "failed", error } })
      .catch(() => {});
  }
}

// --- pure helpers (no DI; unit-testable) ---

function normalizeMime(mime: string, filename: string): string {
  const m = (mime || "").toLowerCase().split(";")[0]!.trim();
  if (ALLOWED_MIME.has(m)) return m;
  // Browsers sometimes send octet-stream / empty for .md / .csv — fall back to
  // the extension so a legitimate text file isn't rejected on a mislabel.
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const byExt: Record<string, string> = {
    txt: "text/plain",
    md: "text/markdown",
    markdown: "text/markdown",
    csv: "text/csv",
    json: "application/json",
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  return byExt[ext] ?? m;
}

async function extractText(bytes: Uint8Array, mimeType: string): Promise<string> {
  if (mimeType === "application/pdf") return extractPdf(bytes);
  if (
    mimeType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return extractDocx(bytes);
  }
  // text family
  return Buffer.from(bytes).toString("utf8");
}

async function extractPdf(bytes: Uint8Array): Promise<string> {
  // Cheap encrypted-PDF reject (correction #13). pdf-parse would also throw,
  // but this gives a clear, early signal without loading the parser.
  const asLatin = Buffer.from(bytes).toString("latin1");
  if (/\/Encrypt\b/.test(asLatin)) {
    throw new Error("encrypted_pdf_unsupported");
  }
  let pdfParse: (b: Buffer) => Promise<{ text: string }>;
  try {
    // Dynamic + string-cast so the build doesn't hard-depend on the parser
    // being installed; a missing dep degrades to a clear failed status.
    const mod = (await import("pdf-parse" as string)) as {
      default?: unknown;
    };
    pdfParse = ((mod as { default?: unknown }).default ?? mod) as (
      b: Buffer,
    ) => Promise<{ text: string }>;
  } catch {
    throw new Error("pdf_extraction_unavailable");
  }
  const parsed = await pdfParse(Buffer.from(bytes));
  return parsed.text ?? "";
}

async function extractDocx(bytes: Uint8Array): Promise<string> {
  let extractRawText: (input: { buffer: Buffer }) => Promise<{ value: string }>;
  try {
    const mod = (await import("mammoth" as string)) as {
      extractRawText?: unknown;
      default?: { extractRawText?: unknown };
    };
    const fn =
      (mod as { extractRawText?: unknown }).extractRawText ??
      (mod as { default?: { extractRawText?: unknown } }).default?.extractRawText;
    extractRawText = fn as (input: { buffer: Buffer }) => Promise<{ value: string }>;
  } catch {
    throw new Error("docx_extraction_unavailable");
  }
  const res = await extractRawText({ buffer: Buffer.from(bytes) });
  return res.value ?? "";
}

/** Paragraph-aware chunking with a small overlap so context isn't split cold. */
function chunkText(text: string): string[] {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buf = "";
  for (const para of paras) {
    if (buf.length + para.length + 2 > CHUNK_CHARS && buf) {
      chunks.push(buf);
      buf = buf.slice(Math.max(0, buf.length - CHUNK_OVERLAP));
    }
    // A single oversized paragraph is hard-split.
    if (para.length > CHUNK_CHARS) {
      for (let i = 0; i < para.length; i += CHUNK_CHARS - CHUNK_OVERLAP) {
        chunks.push(para.slice(i, i + CHUNK_CHARS));
      }
      buf = "";
      continue;
    }
    buf = buf ? `${buf}\n\n${para}` : para;
  }
  if (buf.trim()) chunks.push(buf);
  return chunks.slice(0, 2000); // hard ceiling on chunk count per doc
}

function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function extractErrorCode(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const known = [
    "encrypted_pdf_unsupported",
    "pdf_extraction_unavailable",
    "docx_extraction_unavailable",
    "extraction_timeout",
    "no_text_extracted",
  ];
  return known.find((k) => msg.includes(k)) ?? "extraction_failed";
}

/**
 * Process-wide serialization for document extraction. See `process()` — the
 * parsers are synchronous CPU work that the timeout cannot preempt, so the
 * only real lever is how many can be in flight at once. One.
 */
let extractionChain: Promise<unknown> = Promise.resolve();
function extractionGate<T>(fn: () => Promise<T>): Promise<T> {
  const next = extractionChain.then(fn, fn);
  // Keep the chain alive regardless of outcome; the caller owns the rejection.
  extractionChain = next.catch(() => undefined);
  return next;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout]) as Promise<T>;
}
