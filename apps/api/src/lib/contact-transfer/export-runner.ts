/**
 * Streaming contact export: DB → temp file → R2 artifact.
 *
 * Keyset-paginated, one page in memory at a time, so wall-clock and peak heap
 * scale with page size rather than team size. The previous exporter loaded up
 * to 50k rows and serialized them into one string; at 100k that is a
 * multi-megabyte string built synchronously on the event loop of the process
 * that also serves the inbox.
 *
 * Filters are the shared list filters (`buildContactFilterWhere`) — the SAME
 * predicate the contacts list, the count endpoint, and filter-mode bulk actions
 * use. Export honoring exactly what the user sees on screen is the point;
 * re-implementing the filter here would guarantee eventual divergence.
 */

import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { directoryContactWhere } from "@/lib/queries/contacts";

import {
  TRANSFER_MAX_EXPORT_ROWS,
  type TransferFormat,
} from "@ccp/shared/contacts/transfer-columns";

import { db } from "@/lib/db";
import { blobStorage } from "@/lib/blob-storage";
import { buildContactFilterWhere, type ListContactsOpts } from "@/lib/queries/contacts";

import { fieldHeader, resolveExportColumns } from "./columns";
import { createSink, type Row,
  artifactContentType,
} from "./formats";

/** Rows per page. Matches the broadcast recipient export's proven page size. */
const PAGE = 2_000;

export interface ExportScope {
  /** Explicit ids (the "export selected" path). Wins over `filters`. */
  ids?: string[];
  /** Live list filters (search / tag / stage / source / channel / window). */
  filters?: ListContactsOpts;
}

export interface ExportProgress {
  (processed: number, total: number | null): Promise<void>;
}

export interface ExportResult {
  artifactKey: string;
  artifactBytes: number;
  rowCount: number;
  truncated: boolean;
}

/**
 * Run an export. Returns the R2 key of the artifact; the caller owns presigning
 * and the job row.
 *
 * `isCanceled` is polled between pages so an operator cancel takes effect
 * within one page rather than after the whole file.
 */
export async function runContactExport(opts: {
  workspaceId: string;
  jobId: string;
  format: TransferFormat;
  scope: ExportScope;
  onProgress?: ExportProgress;
  isCanceled?: () => Promise<boolean>;
}): Promise<ExportResult> {
  const { workspaceId, jobId, format, scope } = opts;

  const { columns, fieldDefs, oneOffKeys } = await resolveExportColumns(workspaceId);

  const stageRows = await db.contactStage.findMany({
    where: { workspaceId },
    select: { id: true, name: true },
  });
  const stageNameById = new Map(stageRows.map((s) => [s.id, s.name]));

  const tmpPath = join(tmpdir(), `ccp-export-${jobId}-${randomUUID()}.${format}`);
  const sink = createSink(format, tmpPath, "Contacts");

  let rowCount = 0;
  let truncated = false;

  try {
    await sink.writeHeader(columns);

    const total = await countScope(workspaceId, scope);

    for await (const page of iterateContacts(workspaceId, scope)) {
      if (opts.isCanceled && (await opts.isCanceled())) {
        throw new ExportCanceled();
      }

      const remaining = TRANSFER_MAX_EXPORT_ROWS - rowCount;
      const usable = page.length > remaining ? page.slice(0, remaining) : page;

      const rows: Row[] = usable.map((c) => {
        const cf =
          c.customFields && typeof c.customFields === "object" && !Array.isArray(c.customFields)
            ? (c.customFields as Record<string, unknown>)
            : {};
        const row: Row = {
          id: c.id,
          phone_number: c.phoneNumber ?? "",
          name: c.name,
          first_name: c.firstName ?? "",
          last_name: c.lastName ?? "",
          email: c.email ?? "",
          location: c.location ?? "",
          language: c.language ?? "",
          country: c.countryCode ?? "",
          // Comma-separated tag NAMES so the file round-trips: the importer
          // splits on comma (and still accepts the legacy ";"). The cell
          // contains commas, so the CSV writer quotes it per RFC 4180.
          tags: c.tags.map((t) => t.name).join(", "),
          stage: (c.stageId && stageNameById.get(c.stageId)) || "",
          source: c.source,
        };
        for (const def of fieldDefs) {
          const v = cf[def.key];
          // fieldHeader, not def.label — a field whose label collides with a
          // built-in is written under `custom:<key>` so it round-trips.
          row[fieldHeader(def)] = typeof v === "string" ? v : "";
        }
        for (const key of oneOffKeys) {
          const v = cf[key];
          row[key] = typeof v === "string" ? v : "";
        }
        return row;
      });

      await sink.writeRows(rows);
      rowCount += rows.length;

      if (opts.onProgress) await opts.onProgress(rowCount, total);

      if (rowCount >= TRANSFER_MAX_EXPORT_ROWS) {
        truncated = page.length > usable.length || (total ?? 0) > rowCount;
        break;
      }
    }

    await sink.finish();

    const key = `contact-exports/${workspaceId}/${jobId}.${format}`;
    const { sizeBytes } = await blobStorage.putObjectFromFile({
      key,
      // Streamed from disk by the storage layer, not read into a Buffer here.
      path: tmpPath,
      contentType: artifactContentType(format),
    });

    return { artifactKey: key, artifactBytes: sizeBytes, rowCount, truncated };
  } finally {
    // Always remove the temp file — a failed 100k export must not leave a
    // 25 MB file behind on a VPS disk we share with Postgres and Redis.
    await unlink(tmpPath).catch(() => {});
  }
}

export class ExportCanceled extends Error {
  constructor() {
    super("export canceled");
    this.name = "ExportCanceled";
  }
}

type ExportContact = {
  id: string;
  phoneNumber: string | null;
  name: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  location: string | null;
  language: string | null;
  countryCode: string | null;
  source: string;
  stageId: string | null;
  customFields: unknown;
  tags: Array<{ name: string }>;
};

/**
 * Count the scope up front so the UI can show a real percentage. Cheap relative
 * to the export itself (one indexed count), and a progress bar that can't reach
 * 100% is worse than none.
 */
async function countScope(workspaceId: string, scope: ExportScope): Promise<number | null> {
  if (scope.ids) return scope.ids.length;
  const where = buildContactFilterWhere(workspaceId, scope.filters ?? {});
  const rows = await db.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count FROM "Contact" c WHERE ${where}
  `;
  const n = rows[0]?.count;
  return n === undefined ? null : Number(n);
}

/**
 * Yield pages of contacts for the scope.
 *
 * Ids come from the shared filter SQL, keyset-paginated on `(createdAt, id)` —
 * served by the existing `@@index([workspaceId, createdAt desc, id desc])`, which
 * Postgres scans backwards for our ascending order. Hydration is a separate
 * Prisma query so we get typed rows + the tag join without hand-writing it.
 *
 * OFFSET pagination would be quadratic here: page 50 of a 100k export would
 * make Postgres walk and discard 100,000 rows.
 */
async function* iterateContacts(
  workspaceId: string,
  scope: ExportScope,
): AsyncGenerator<ExportContact[]> {
  if (scope.ids) {
    // Explicit selection: chunk the id list. Still scoped by workspaceId — an id
    // list arrives from the client and must never be trusted as tenant-safe.
    for (let i = 0; i < scope.ids.length; i += PAGE) {
      const chunk = scope.ids.slice(i, i + PAGE);
      const rows = await hydrate(workspaceId, chunk);
      if (rows.length > 0) yield rows;
    }
    return;
  }

  const where = buildContactFilterWhere(workspaceId, scope.filters ?? {});
  let cursor: { createdAt: Date; id: string } | null = null;

  for (;;) {
    const keyset: Prisma.Sql = cursor
      ? Prisma.sql`AND (c."createdAt", c."id") > (${cursor.createdAt}, ${cursor.id})`
      : Prisma.empty;

    const idRows = await db.$queryRaw<Array<{ id: string; createdAt: Date }>>`
      SELECT c."id", c."createdAt"
      FROM "Contact" c
      WHERE ${where} ${keyset}
      ORDER BY c."createdAt" ASC, c."id" ASC
      LIMIT ${PAGE}
    `;
    if (idRows.length === 0) return;

    const rows = await hydrate(
      workspaceId,
      idRows.map((r) => r.id),
    );
    if (rows.length > 0) yield rows;

    const last = idRows[idRows.length - 1]!;
    cursor = { createdAt: last.createdAt, id: last.id };
    if (idRows.length < PAGE) return;
  }
}

async function hydrate(workspaceId: string, ids: string[]): Promise<ExportContact[]> {
  if (ids.length === 0) return [];
  const rows = await db.contact.findMany({
    // workspaceId in the where even though the ids came from a team-scoped query —
    // tenant isolation is manual here and defense in depth is free.
    //
    // `directoryContactWhere` too, and it is NOT redundant here. The FILTER
    // branch gets it via `buildContactFilterWhere`; this explicit-ids branch
    // had no such gate, so a client could pass visitor ids — obtainable from
    // the sanctioned `?channel=webchatwidget` view — and export anonymous
    // EPHEMERAL contacts into a CSV. lib/contact-transfer/ states the
    // opposite ("directoryContactWhere still applies, so anonymous webchat
    // visitors stay out"), and §6 makes directory membership a DERIVED
    // property, not a per-call-site choice. Same tenant either way, so this is
    // a promise-keeping fix, not a cross-tenant one.
    where: {
      AND: [
        { workspaceId, id: { in: ids }, deletedAt: null },
        directoryContactWhere,
      ],
    },
    select: {
      id: true,
      phoneNumber: true,
      name: true,
      firstName: true,
      lastName: true,
      email: true,
      location: true,
      language: true,
      countryCode: true,
      source: true,
      stageId: true,
      customFields: true,
      tags: { select: { name: true } },
    },
  });
  // findMany does not preserve the `in` order; restore the keyset order so the
  // exported file is deterministic (and so a re-export diffs cleanly).
  const byId = new Map(rows.map((r) => [r.id, r as ExportContact]));
  return ids.map((id) => byId.get(id)).filter((r): r is ExportContact => r !== undefined);
}
