/**
 * Streaming contact import: R2 source file → batched writes → counters + an
 * error report.
 *
 * Shape of the run:
 *   read a batch of rows  →  normalize + validate  →  de-dupe against the file
 *   →  split by current DB state (active / tombstoned / absent)
 *   →  createMany · revive CAS · bulk UPDATE  →  link tags  →  events  →  repeat
 *
 * Everything is per-batch, so a 200k-row file costs the same peak memory as a
 * 1k-row one apart from the in-file de-dupe set.
 *
 * IDENTITY. Every imported row is keyed on a normalized phone and stamped
 * `identityChannel: 'whatsapp'` — the only channel whose natural key a person
 * can type into a spreadsheet. An imported EMAIL is stored on the row but never
 * used as an identity key: `IdentityService` only treats email as a strong key
 * when it was self-asserted through the contact-share chip. A spreadsheet
 * address must never be able to fold two people into one Customer (docs/identity.md).
 */

import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  IMPORT_EVENT_FANOUT_CAP,
  TRANSFER_IDENTITY_CHANNEL,
  TRANSFER_MAX_ERROR_ROWS,
  TRANSFER_MAX_IMPORT_ROWS,
  TRANSFER_MAX_NEW_TAGS,
  type ImportMode,
  type ImportTagMode,
  type TransferFormat,
} from "@ccp/shared/contacts/transfer-columns";
import { getCountryFromPhone, normalizePhoneE164 } from "@ccp/shared/utils/phone";

import { runWithConcurrency } from "@/common/concurrency";
import { blobStorage } from "@/lib/blob-storage";
import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { ensureDefaultStage } from "@/lib/queries";
import { toContactWire } from "@/lib/queries/_shared";
import { workflowContactSnapshot } from "@/lib/workflows/events";

import { resolveImportMapping, type HeaderMapping, type TeamFieldDef } from "./columns";
import { createSink, createSource, type Row } from "./formats";

/** Rows per DB batch. Big enough to amortize round-trips, small enough that
 *  every statement stays plannable and no single transaction runs long. */
const BATCH = 1_000;

/** Max characters kept per cell — parity with the JSON API's field caps. */
const MAX_TEXT = 500;

/** Max tags applied from one row (a pathological cell can't flood the catalog). */
const MAX_TAGS_PER_ROW = 25;

/** Per-contact customFields ceiling, mirrored from contacts.schemas.ts. */
const MAX_TOTAL_FIELDS = 100;

export interface ImportOptions {
  mode: ImportMode;
  tagMode: ImportTagMode;
  /** User's request to publish per-row events. Still forced off above the cap. */
  fireAutomations: boolean;
  /** Explicit header → target overrides from the mapping step. */
  mapping?: Record<string, string>;
  /** Caller has `tags:manage` — only then are unknown tag names auto-created. */
  canManageTags: boolean;
}

export interface ImportCounters {
  processedRows: number;
  created: number;
  updated: number;
  revived: number;
  skipped: number;
  failed: number;
}

export interface ImportResult extends ImportCounters {
  totalRows: number;
  unknownColumns: string[];
  unknownStages: string[];
  extraSheets: string[];
  automationsSkipped: boolean;
  errorSample: Array<{ row: number; reason: string }>;
  errorArtifactKey: string | null;
}

export class ImportCanceled extends Error {
  constructor() {
    super("import canceled");
    this.name = "ImportCanceled";
  }
}

/** A row that survived parsing and is ready for the DB. */
interface PendingRow {
  rowNumber: number;
  phoneNumber: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  location: string | null;
  language: string | null;
  countryCode: string | null;
  customFields: Record<string, string>;
  tagNames: string[];
  stageName: string;
  /** The original cells, kept only to reproduce the row in the error report. */
  raw: Row;
}

export async function runContactImport(opts: {
  teamId: string;
  userId: string | null;
  jobId: string;
  format: TransferFormat;
  sourceKey: string;
  options: ImportOptions;
  /** Rows already applied by a previous attempt — resume cursor. */
  resumeFrom: number;
  /** Counters from the previous attempt, so a resume reports the whole run. */
  resumeCounters?: Partial<ImportCounters>;
  onProgress?: (counters: ImportCounters) => Promise<void>;
  isCanceled?: () => Promise<boolean>;
}): Promise<ImportResult> {
  const { teamId, userId, jobId, format, sourceKey, options } = opts;

  // Pull the source out of R2 to a temp file. The parsers want a path (ExcelJS
  // in particular reads the zip central directory, which needs random access),
  // and a local file also makes a retry cheap.
  const localPath = join(tmpdir(), `ccp-import-${jobId}-${randomUUID()}.${format}`);
  await downloadToFile(sourceKey, localPath);

  const fieldDefs: TeamFieldDef[] = await db.contactFieldDefinition.findMany({
    where: { teamId },
    select: { key: true, label: true },
  });

  const source = createSource(format, localPath);
  const errorRows: Array<{ rowNumber: number; reason: string; raw: Row }> = [];
  const unknownStages = new Set<string>();

  const counters: ImportCounters = {
    processedRows: opts.resumeCounters?.processedRows ?? 0,
    created: opts.resumeCounters?.created ?? 0,
    updated: opts.resumeCounters?.updated ?? 0,
    revived: opts.resumeCounters?.revived ?? 0,
    skipped: opts.resumeCounters?.skipped ?? 0,
    failed: opts.resumeCounters?.failed ?? 0,
  };

  try {
    const headers = await source.headers();
    if (headers.length === 0) {
      throw new ImportRejected("empty_file", "The file has no header row.");
    }

    const { mapping, unknownColumns } = resolveImportMapping(
      headers,
      fieldDefs,
      options.mapping,
    );

    if (!hasTarget(mapping, "phone_number")) {
      throw new ImportRejected(
        "no_phone_column",
        "No column is mapped to the phone number. Contacts are identified by phone, so at least one column must map to it.",
      );
    }

    // The mapped custom-field column set is identical for every row, so the
    // per-contact field cap can be checked ONCE here instead of throwing
    // mid-run and leaving a half-applied import.
    const fieldColumnCount = [...mapping.values()].filter((m) => m.kind === "field").length;
    if (fieldColumnCount > MAX_TOTAL_FIELDS) {
      throw new ImportRejected(
        "too_many_fields",
        `The file maps ${fieldColumnCount} custom-field columns; the limit is ${MAX_TOTAL_FIELDS} per contact.`,
      );
    }

    const defaultStageId = await ensureDefaultStage(teamId);
    const stageIdByName = new Map(
      (
        await db.contactStage.findMany({ where: { teamId }, select: { id: true, name: true } })
      ).map((s) => [s.name.toLowerCase(), s.id]),
    );
    const resolveStage = (name: string): string => {
      if (!name) return defaultStageId;
      const hit = stageIdByName.get(name.toLowerCase());
      if (hit) return hit;
      unknownStages.add(name);
      return defaultStageId;
    };

    // In-file de-dupe. Bounded by TRANSFER_MAX_IMPORT_ROWS: one normalized
    // phone string per row, ~200k × ~15 chars, tens of MB — the reason that cap
    // exists at all.
    const seenPhones = new Set<string>();

    // Distinct new tag names across the WHOLE file. A bad mapping (an order id
    // landing under a header named "tags") yields a unique value per row, which
    // would spawn one tag per contact and permanently pollute the catalog.
    const newTagNames = new Set<string>();

    let batch: PendingRow[] = [];
    let rowsSeen = 0;
    // Above the cap we stop publishing per-row events entirely (see below).
    let automationsSkipped = false;

    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      if (opts.isCanceled && (await opts.isCanceled())) throw new ImportCanceled();

      const fireEvents = options.fireAutomations && !automationsSkipped;
      const outcome = await applyBatch({
        teamId,
        userId,
        rows: batch,
        options,
        resolveStage,
        fireEvents,
      });

      counters.created += outcome.created;
      counters.updated += outcome.updated;
      counters.revived += outcome.revived;
      counters.skipped += outcome.skipped;
      for (const e of outcome.errors) pushError(errorRows, e);
      counters.failed += outcome.errors.length;
      // Advanced only AFTER the batch commits, so a crash mid-batch resumes at
      // the start of that batch and the idempotent writes absorb the replay.
      counters.processedRows += batch.length;

      batch = [];
      if (opts.onProgress) await opts.onProgress({ ...counters });
    };

    for await (const { rowNumber, cells } of source.rows()) {
      rowsSeen += 1;

      if (rowsSeen > TRANSFER_MAX_IMPORT_ROWS) {
        throw new ImportRejected(
          "too_many_rows",
          `The file has more than ${TRANSFER_MAX_IMPORT_ROWS.toLocaleString()} rows. Split it and import the parts separately.`,
        );
      }

      // Resume: rows already applied by a previous attempt are skipped without
      // being re-parsed or re-counted.
      if (rowsSeen <= opts.resumeFrom) continue;

      // Cross the fanout cap → stop publishing per-row events for the REST of
      // the run and record that we did. Checked against rows seen (not applied)
      // because the cost we're bounding is events, and every applied row emits
      // one.
      if (!automationsSkipped && rowsSeen > IMPORT_EVENT_FANOUT_CAP) {
        automationsSkipped = options.fireAutomations;
      }

      const built = buildRow(rowNumber, cells, mapping);
      if ("error" in built) {
        pushError(errorRows, { rowNumber, reason: built.error, raw: cells });
        counters.failed += 1;
        counters.processedRows += 1;
        continue;
      }

      const row = built.row;
      if (seenPhones.has(row.phoneNumber)) {
        pushError(errorRows, {
          rowNumber,
          reason: "duplicate phone number in this file",
          raw: cells,
        });
        counters.failed += 1;
        counters.processedRows += 1;
        continue;
      }
      seenPhones.add(row.phoneNumber);

      for (const t of row.tagNames) newTagNames.add(t.toLowerCase());
      if (newTagNames.size > TRANSFER_MAX_NEW_TAGS * 20) {
        // Cheap early bail: 20× the create ceiling means the "tags" column is
        // almost certainly mismapped. The precise existing-vs-new split happens
        // per batch; this only prevents an unbounded Set.
        throw new ImportRejected(
          "too_many_tags",
          `The tags column has more than ${TRANSFER_MAX_NEW_TAGS * 20} distinct values, which usually means the wrong column is mapped to Tags.`,
        );
      }

      batch.push(row);
      if (batch.length >= BATCH) await flush();
    }

    await flush();

    const errorArtifactKey =
      errorRows.length > 0
        ? await writeErrorReport({ teamId, jobId, format, headers, errorRows })
        : null;

    return {
      ...counters,
      totalRows: rowsSeen,
      unknownColumns,
      unknownStages: [...unknownStages].sort(),
      extraSheets: hasExtraSheets(source) ? source.extraSheets() : [],
      automationsSkipped,
      errorSample: errorRows.slice(0, 50).map((e) => ({ row: e.rowNumber, reason: e.reason })),
      errorArtifactKey,
    };
  } finally {
    await source.close().catch(() => {});
    await unlink(localPath).catch(() => {});
  }
}

/** A whole-file rejection (bad shape / over a cap), distinct from a row error. */
export class ImportRejected extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ImportRejected";
  }
}

function hasTarget(mapping: Map<string, HeaderMapping>, id: string): boolean {
  for (const m of mapping.values()) {
    if (m.kind === "builtin" && m.id === id) return true;
  }
  return false;
}

function hasExtraSheets(s: unknown): s is { extraSheets: () => string[] } {
  return typeof (s as { extraSheets?: unknown }).extraSheets === "function";
}

/** Bounded error collection — a 200k-row file of garbage must not OOM us
 *  building a report nobody will read past the first thousand lines. */
function pushError(
  sink: Array<{ rowNumber: number; reason: string; raw: Row }>,
  e: { rowNumber: number; reason: string; raw: Row },
): void {
  if (sink.length < TRANSFER_MAX_ERROR_ROWS) sink.push(e);
}

// ---------------------------------------------------------------------------
// Row building
// ---------------------------------------------------------------------------

function buildRow(
  rowNumber: number,
  cells: Row,
  mapping: Map<string, HeaderMapping>,
): { row: PendingRow } | { error: string } {
  let phoneRaw = "";
  let name = "";
  let firstName = "";
  let lastName = "";
  let email = "";
  let location = "";
  let language = "";
  let country = "";
  let tagsRaw = "";
  let stageRaw = "";
  const customFields: Record<string, string> = {};

  for (const [header, value] of Object.entries(cells)) {
    const m = mapping.get(header);
    if (!m) continue;
    if (m.kind === "field") {
      customFields[m.key] = value.slice(0, MAX_TEXT);
      continue;
    }
    if (m.kind === "ignore") continue;
    const v = value.slice(0, MAX_TEXT);
    switch (m.id) {
      case "phone_number": phoneRaw = v; break;
      case "name": name = v; break;
      case "first_name": firstName = v; break;
      case "last_name": lastName = v; break;
      case "email": email = v; break;
      case "location": location = v; break;
      case "language": language = v; break;
      case "country": country = v; break;
      case "tags": tagsRaw = v; break;
      case "stage": stageRaw = v; break;
      default: break;
    }
  }

  if (!phoneRaw.trim()) return { error: "missing phone number" };
  const phone = normalizePhoneE164(phoneRaw);
  if (!phone) {
    return {
      error: `invalid phone number "${phoneRaw}" — include the country code, e.g. 15551234567`,
    };
  }

  // Synthesize the display name from first/last when there's no Name column,
  // mirroring the manual-create path so a first+last file doesn't end up with
  // the bare phone number as every contact's name.
  let displayName = name.trim();
  if (!displayName) {
    const composed = `${firstName.trim()} ${lastName.trim()}`.trim();
    if (composed) displayName = composed;
  }

  const countryNormalized = country.trim().toUpperCase();
  const countryValid = /^[A-Z]{2}$/.test(countryNormalized);

  // Split on "," (the export separator) or ";" (legacy + people who type
  // semicolons), trim, drop blanks, de-dupe case-insensitively keeping the
  // first-seen casing for creation.
  const seen = new Set<string>();
  const tagNames: string[] = [];
  for (const raw of tagsRaw.split(/[;,]/)) {
    const t = raw.trim().slice(0, MAX_TEXT);
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    tagNames.push(t);
    if (tagNames.length >= MAX_TAGS_PER_ROW) break;
  }

  return {
    row: {
      rowNumber,
      phoneNumber: phone,
      name: displayName || phone,
      firstName: firstName.trim() || null,
      lastName: lastName.trim() || null,
      email: email.trim() || null,
      location: location.trim() || null,
      language: language.trim() || null,
      countryCode: countryValid ? countryNormalized : null,
      customFields,
      tagNames,
      stageName: stageRaw.trim(),
      raw: cells,
    },
  };
}

// ---------------------------------------------------------------------------
// Batch application
// ---------------------------------------------------------------------------

interface BatchOutcome {
  created: number;
  updated: number;
  revived: number;
  skipped: number;
  errors: Array<{ rowNumber: number; reason: string; raw: Row }>;
}

async function applyBatch(args: {
  teamId: string;
  userId: string | null;
  rows: PendingRow[];
  options: ImportOptions;
  resolveStage: (name: string) => string;
  fireEvents: boolean;
}): Promise<BatchOutcome> {
  const { teamId, userId, rows, options, resolveStage, fireEvents } = args;
  const outcome: BatchOutcome = { created: 0, updated: 0, revived: 0, skipped: 0, errors: [] };

  const phones = rows.map((r) => r.phoneNumber);

  // Two narrow lookups rather than one unfiltered query, so a tombstoned row
  // can't masquerade as an existing duplicate. BOTH are scoped to
  // identityChannel — the phone partial-unique only fires for whatsapp, and a
  // phone that a social/widget contact borrowed (contact-share, widget
  // pre-chat) must not be read as "this contact already exists".
  const [activeRows, tombstonedRows] = await Promise.all([
    db.contact.findMany({
      where: {
        teamId,
        identityChannel: TRANSFER_IDENTITY_CHANNEL,
        phoneNumber: { in: phones },
        deletedAt: null,
      },
      select: { id: true, phoneNumber: true },
    }),
    db.contact.findMany({
      where: {
        teamId,
        identityChannel: TRANSFER_IDENTITY_CHANNEL,
        phoneNumber: { in: phones },
        deletedAt: { not: null },
      },
      select: { id: true, phoneNumber: true },
    }),
  ]);
  const activeIdByPhone = new Map(activeRows.map((r) => [r.phoneNumber!, r.id]));
  const tombstonedIdByPhone = new Map(tombstonedRows.map((r) => [r.phoneNumber!, r.id]));

  const toCreate: PendingRow[] = [];
  const toRevive: PendingRow[] = [];
  const toUpdate: PendingRow[] = [];

  for (const row of rows) {
    if (activeIdByPhone.has(row.phoneNumber)) {
      if (options.mode === "create_only") outcome.skipped += 1;
      else toUpdate.push(row);
      continue;
    }
    if (tombstonedIdByPhone.has(row.phoneNumber)) {
      // A tombstoned row is "absent" as far as the user is concerned, so
      // update_only leaves it alone — reviving on an update-only run would
      // resurrect contacts the team deliberately deleted.
      if (options.mode === "update_only") outcome.skipped += 1;
      else toRevive.push(row);
      continue;
    }
    if (options.mode === "update_only") outcome.skipped += 1;
    else toCreate.push(row);
  }

  // ---- create ------------------------------------------------------------
  if (toCreate.length > 0) {
    const res = await db.contact.createMany({
      data: toCreate.map((p) => ({
        teamId,
        identityChannel: TRANSFER_IDENTITY_CHANNEL,
        phoneNumber: p.phoneNumber,
        name: p.name,
        firstName: p.firstName ?? undefined,
        lastName: p.lastName ?? undefined,
        email: p.email ?? undefined,
        location: p.location ?? undefined,
        language: p.language ?? undefined,
        countryCode: p.countryCode ?? getCountryFromPhone(p.phoneNumber) ?? undefined,
        customFields: p.customFields,
        stageId: resolveStage(p.stageName),
        source: "manual" as const,
      })),
      // Guards the (teamId, phone) partial unique against a concurrent inbound
      // message creating the same contact mid-import.
      skipDuplicates: true,
    });
    outcome.created += res.count;
    // A collision means the contact exists after all — count it as skipped so
    // "created + skipped" still equals the rows we attempted.
    outcome.skipped += toCreate.length - res.count;
  }

  // ---- revive ------------------------------------------------------------
  if (toRevive.length > 0) {
    const revivedIds: string[] = [];
    await runWithConcurrency(toRevive, 16, async (p) => {
      const id = tombstonedIdByPhone.get(p.phoneNumber);
      if (!id) return;
      // CAS on the row STILL being tombstoned: between the read above and this
      // write a concurrent inbound may have un-tombstoned it, and clobbering a
      // now-live row with stale file values would be a silent data loss.
      // updateMany (not update) because Prisma's `update` only accepts unique
      // fields in the where.
      const flip = await db.contact.updateMany({
        where: { id, teamId, deletedAt: { not: null } },
        data: {
          name: p.name,
          firstName: p.firstName,
          lastName: p.lastName,
          email: p.email,
          location: p.location,
          language: p.language,
          countryCode: p.countryCode ?? getCountryFromPhone(p.phoneNumber) ?? null,
          customFields: p.customFields,
          stageId: resolveStage(p.stageName),
          source: "manual",
          deletedAt: null,
          version: { increment: 1 },
        },
      });
      if (flip.count > 0) revivedIds.push(id);
    });
    outcome.revived += revivedIds.length;
    outcome.skipped += toRevive.length - revivedIds.length;
  }

  // ---- update ------------------------------------------------------------
  // `contact.updated` carries `previousStageId` + `fieldChanges`, so the
  // BEFORE state has to be captured ahead of the write. Only paid for when
  // we're actually publishing — above the fanout cap this query never runs.
  const previousById = new Map<string, PreviousContact>();
  if (toUpdate.length > 0 && fireEvents) {
    const before = await db.contact.findMany({
      where: {
        teamId,
        identityChannel: TRANSFER_IDENTITY_CHANNEL,
        phoneNumber: { in: toUpdate.map((r) => r.phoneNumber) },
        deletedAt: null,
      },
      select: {
        id: true,
        stageId: true,
        name: true,
        firstName: true,
        lastName: true,
        email: true,
        location: true,
        language: true,
        countryCode: true,
      },
    });
    for (const b of before) previousById.set(b.id, b);
  }
  if (toUpdate.length > 0) {
    outcome.updated += await applyUpdates({ teamId, rows: toUpdate, resolveStage });
  }

  // ---- tags --------------------------------------------------------------
  const touched = [...toCreate, ...toRevive, ...toUpdate];
  const idByPhone = await linkTags({ teamId, rows: touched, options });

  // ---- events ------------------------------------------------------------
  if (fireEvents && touched.length > 0) {
    await publishRowEvents({
      teamId,
      userId,
      created: toCreate,
      changed: [...toRevive, ...toUpdate],
      idByPhone,
      previousById,
    });
  }

  return outcome;
}

/**
 * Upsert the non-empty cells of every already-existing row in the batch, in ONE
 * statement.
 *
 * `COALESCE(NULLIF(v.col, ''), c.col)` is the load-bearing bit: a blank cell
 * LEAVES THE EXISTING VALUE ALONE. Anything else means a user who exports,
 * edits one column in Excel, and re-imports wipes every field their spreadsheet
 * didn't happen to include — the single most destructive thing a contact
 * importer can do.
 *
 * `version = version + 1` always, so an in-flight PATCH holding an older
 * version CAS-fails instead of silently overwriting the import (same discipline
 * as the bulk tag-add path).
 */
async function applyUpdates(args: {
  teamId: string;
  rows: PendingRow[];
  resolveStage: (name: string) => string;
}): Promise<number> {
  const { teamId, rows, resolveStage } = args;

  const phones = rows.map((r) => r.phoneNumber);
  const names = rows.map((r) => r.name);
  const firstNames = rows.map((r) => r.firstName ?? "");
  const lastNames = rows.map((r) => r.lastName ?? "");
  const emails = rows.map((r) => r.email ?? "");
  const locations = rows.map((r) => r.location ?? "");
  const languages = rows.map((r) => r.language ?? "");
  const countries = rows.map((r) => r.countryCode ?? "");
  const stageIds = rows.map((r) => (r.stageName ? resolveStage(r.stageName) : ""));
  const customFields = rows.map((r) => JSON.stringify(r.customFields));

  // `name` is special: buildRow falls back to the phone number when the file
  // gives no name, and overwriting a real contact's name with their phone
  // number would be a regression. Send "" for those so COALESCE keeps the
  // existing name.
  const nameValues = rows.map((r, i) => (r.name === phones[i] ? "" : names[i]!));

  return db.$executeRaw`
    UPDATE "Contact" c SET
      name         = COALESCE(NULLIF(v.name, ''), c.name),
      "firstName"  = COALESCE(NULLIF(v.first_name, ''), c."firstName"),
      "lastName"   = COALESCE(NULLIF(v.last_name, ''), c."lastName"),
      email        = COALESCE(NULLIF(v.email, ''), c.email),
      location     = COALESCE(NULLIF(v.location, ''), c.location),
      language     = COALESCE(NULLIF(v.language, ''), c.language),
      "countryCode"= COALESCE(NULLIF(v.country, ''), c."countryCode"),
      "stageId"    = COALESCE(NULLIF(v.stage_id, ''), c."stageId"),
      -- Merge the incoming bag over the existing one, but ONLY if the result
      -- stays within the per-contact field cap; otherwise keep what's there.
      -- Enforcing the cap in SQL keeps it true even for a 200k-row run that
      -- never round-trips a single row through application code.
      "customFields" = CASE
        WHEN (
          SELECT count(*) FROM jsonb_object_keys(c."customFields" || v.custom_fields::jsonb)
        ) <= ${MAX_TOTAL_FIELDS}
        THEN c."customFields" || v.custom_fields::jsonb
        ELSE c."customFields"
      END,
      version      = c.version + 1
    FROM (
      SELECT * FROM UNNEST(
        ${phones}::text[], ${nameValues}::text[], ${firstNames}::text[],
        ${lastNames}::text[], ${emails}::text[], ${locations}::text[],
        ${languages}::text[], ${countries}::text[], ${stageIds}::text[],
        ${customFields}::text[]
      ) AS t(phone, name, first_name, last_name, email, location, language,
             country, stage_id, custom_fields)
    ) v
    WHERE c."teamId" = ${teamId}
      AND c."identityChannel" = ${TRANSFER_IDENTITY_CHANNEL}::"Channel"
      AND c."phoneNumber" = v.phone
      AND c."deletedAt" IS NULL
  `;
}

/**
 * Resolve tag names to ids (get-or-create) and link them, one bulk statement
 * per batch. Returns phone → contact id for the batch, which the event
 * publisher reuses so it doesn't need its own lookup.
 */
async function linkTags(args: {
  teamId: string;
  rows: PendingRow[];
  options: ImportOptions;
}): Promise<Map<string, string>> {
  const { teamId, rows, options } = args;
  if (rows.length === 0) return new Map();

  // One lookup for the whole batch, needed for events regardless of tags.
  const contactRows = await db.contact.findMany({
    where: {
      teamId,
      identityChannel: TRANSFER_IDENTITY_CHANNEL,
      phoneNumber: { in: rows.map((r) => r.phoneNumber) },
      deletedAt: null,
    },
    select: { id: true, phoneNumber: true },
  });
  const idByPhone = new Map(contactRows.map((r) => [r.phoneNumber!, r.id]));

  const rowsWithTags = rows.filter((r) => r.tagNames.length > 0);
  // `replace` has to run even for rows whose tag cell is EMPTY — "replace with
  // nothing" means clear. `merge` on an empty cell is a no-op.
  const rowsToClear =
    options.tagMode === "replace" ? rows.map((r) => idByPhone.get(r.phoneNumber)) : [];

  if (rowsWithTags.length === 0 && rowsToClear.length === 0) return idByPhone;

  const tagIdByNameKey = await resolveTagIds(
    teamId,
    dedupeNames(rowsWithTags),
    options.canManageTags,
  );

  if (options.tagMode === "replace") {
    const ids = rowsToClear.filter((id): id is string => Boolean(id));
    if (ids.length > 0) {
      await db.$executeRaw`
        DELETE FROM "_ContactToTag" WHERE "A" = ANY(${ids}::text[])
      `;
    }
  }

  const contactIds: string[] = [];
  const tagIds: string[] = [];
  const seenPair = new Set<string>();
  for (const r of rowsWithTags) {
    const contactId = idByPhone.get(r.phoneNumber);
    if (!contactId) continue; // lost to a concurrent delete — skip
    for (const t of r.tagNames) {
      const tagId = tagIdByNameKey.get(t.toLowerCase());
      if (!tagId) continue; // unknown name and the caller can't create tags
      const pk = `${contactId}:${tagId}`;
      if (seenPair.has(pk)) continue;
      seenPair.add(pk);
      contactIds.push(contactId);
      tagIds.push(tagId);
    }
  }

  if (contactIds.length > 0) {
    // Prisma's implicit M2M table is "_ContactToTag" with A=Contact.id,
    // B=Tag.id. ON CONFLICT so a re-import or a racing link is a no-op.
    await db.$executeRaw`
      INSERT INTO "_ContactToTag" ("A", "B")
      SELECT * FROM UNNEST(${contactIds}::text[], ${tagIds}::text[])
      ON CONFLICT DO NOTHING
    `;
  }

  return idByPhone;
}

function dedupeNames(rows: PendingRow[]): string[] {
  const byKey = new Map<string, string>();
  for (const r of rows) {
    for (const t of r.tagNames) {
      const k = t.toLowerCase();
      if (!byKey.has(k)) byKey.set(k, t);
    }
  }
  return [...byKey.values()];
}

/**
 * Get-or-create tags by name, keyed by lowercased name. Unknown names are only
 * created when the caller holds `tags:manage` (the same capability the tag CRUD
 * endpoints require); otherwise they're skipped and the link is dropped.
 */
async function resolveTagIds(
  teamId: string,
  names: string[],
  canManageTags: boolean,
): Promise<Map<string, string>> {
  const byKey = new Map<string, string>();
  if (names.length === 0) return byKey;

  const existing = await db.tag.findMany({
    where: { teamId, name: { in: names, mode: "insensitive" } },
    select: { id: true, name: true },
  });
  for (const t of existing) byKey.set(t.name.toLowerCase(), t.id);

  if (!canManageTags) return byKey;

  const missing = names.filter((n) => !byKey.has(n.toLowerCase()));
  if (missing.length === 0) return byKey;
  if (missing.length > TRANSFER_MAX_NEW_TAGS) {
    throw new ImportRejected(
      "too_many_new_tags",
      `This import would create ${missing.length} new tags (limit ${TRANSFER_MAX_NEW_TAGS}). Check that the right column is mapped to Tags.`,
    );
  }

  await db.tag.createMany({
    data: missing.map((name) => ({ teamId, name, color: "slate" })),
    skipDuplicates: true,
  });
  const created = await db.tag.findMany({
    where: { teamId, name: { in: missing, mode: "insensitive" } },
    select: { id: true, name: true },
  });
  for (const t of created) byKey.set(t.name.toLowerCase(), t.id);
  return byKey;
}

/**
 * Per-row `contact.created` / `contact.updated` for the batch.
 *
 * `suppressSocketFanout` keeps the SOCKET on the single coalesced
 * `contact.bulk_updated` the caller emits at the end — without it a 5k-row
 * import is a 5k-frame storm to every open tab. The non-socket subscribers
 * (outbound webhooks, audit, workflow dispatch) still get one granular event
 * per row, which is what makes "On contact created" automations fire.
 *
 * Above IMPORT_EVENT_FANOUT_CAP the caller never calls this at all.
 */
async function publishRowEvents(args: {
  teamId: string;
  userId: string | null;
  created: PendingRow[];
  changed: PendingRow[];
  idByPhone: Map<string, string>;
  previousById: Map<string, PreviousContact>;
}): Promise<void> {
  const { teamId, userId, created, changed, idByPhone, previousById } = args;
  const ids = [...created, ...changed]
    .map((r) => idByPhone.get(r.phoneNumber))
    .filter((id): id is string => Boolean(id));
  if (ids.length === 0) return;

  const hydrated = await db.contact.findMany({
    where: { teamId, id: { in: ids } },
    include: { tags: { select: { id: true } } },
  });
  const createdIds = new Set(
    created.map((r) => idByPhone.get(r.phoneNumber)).filter(Boolean) as string[],
  );
  // A revived row is a brand-new contact to every subscriber (same contract as
  // the single-create revive path), so it publishes `contact.created` too.
  for (const r of args.changed) {
    const id = idByPhone.get(r.phoneNumber);
    if (id && !previousById.has(id)) createdIds.add(id);
  }

  // 16 lanes: each publish awaits an OutboundEvent insert, so a serial loop
  // would add one sequential round-trip per row.
  await runWithConcurrency(hydrated, 16, async (row) => {
    const wire = toContactWire(row, { tagIds: row.tags.map((t) => t.id) });
    if (createdIds.has(row.id)) {
      await publish({
        type: "contact.created",
        teamId,
        contact: wire,
        source: "import",
        createdByUserId: userId,
        suppressSocketFanout: true,
      });
      return;
    }
    const prev = previousById.get(row.id);
    const fieldChanges: Array<{ key: string; previous: string | null; next: string | null }> = [];
    if (prev) {
      for (const key of BUILT_IN_DIFF_KEYS) {
        const before = prev[key] ?? null;
        const after = (row[key] as string | null) ?? null;
        if (before !== after) fieldChanges.push({ key, previous: before, next: after });
      }
    }
    await publish({
      type: "contact.updated",
      teamId,
      contact: wire,
      previousStageId: prev?.stageId ?? null,
      fieldChanges,
      changedByUserId: userId,
      workflowContact: workflowContactSnapshot(row),
      suppressSocketFanout: true,
    });
  });
}

type PreviousContact = {
  id: string;
  stageId: string | null;
  name: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  location: string | null;
  language: string | null;
  countryCode: string | null;
};

/**
 * Built-in columns surfaced as `fieldChanges` on `contact.updated` (so an
 * outbound webhook shows a rename / email edit). Mirrors BUILT_IN_KEYS in
 * contacts.service.ts — workflow dispatch's `contact_field_updated` trigger
 * deliberately EXCLUDES these keys and stays custom-field-only.
 */
const BUILT_IN_DIFF_KEYS = [
  "name",
  "firstName",
  "lastName",
  "email",
  "location",
  "language",
  "countryCode",
] as const satisfies ReadonlyArray<keyof PreviousContact>;

// ---------------------------------------------------------------------------
// Error report
// ---------------------------------------------------------------------------

/**
 * Write the failed rows to an artifact in the SAME format the user uploaded,
 * with their original cells intact plus `_row` and `_error`. The user fixes the
 * file and re-imports it directly — no diffing a summary against a spreadsheet
 * to work out which of 100,000 rows was rejected.
 */
async function writeErrorReport(args: {
  teamId: string;
  jobId: string;
  format: TransferFormat;
  headers: string[];
  errorRows: Array<{ rowNumber: number; reason: string; raw: Row }>;
}): Promise<string> {
  const { teamId, jobId, format, headers, errorRows } = args;
  const path = join(tmpdir(), `ccp-import-errors-${jobId}-${randomUUID()}.${format}`);
  const sink = createSink(format, path, "Errors");
  // Prefix the diagnostic columns so they're the first thing visible, and
  // underscore them so they can't collide with a real header.
  const columns = ["_row", "_error", ...headers];
  try {
    await sink.writeHeader(columns);
    for (let i = 0; i < errorRows.length; i += 1_000) {
      await sink.writeRows(
        errorRows.slice(i, i + 1_000).map((e) => ({
          ...e.raw,
          _row: String(e.rowNumber),
          _error: e.reason,
        })),
      );
    }
    await sink.finish();
    const key = `contact-imports/${teamId}/${jobId}-errors.${format}`;
    await blobStorage.putObjectFromFile({
      key,
      path,
      contentType:
        format === "xlsx"
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "text/csv; charset=utf-8",
    });
    return key;
  } finally {
    await unlink(path).catch(() => {});
  }
}

async function downloadToFile(key: string, path: string): Promise<void> {
  const { createWriteStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");
  const obj = await blobStorage.getObject(key);
  await pipeline(obj.body, createWriteStream(path));
}
