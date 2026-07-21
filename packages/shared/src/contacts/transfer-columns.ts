/**
 * The ONE canonical column table for contact import/export (CSV + Excel).
 *
 * Before this file the same table existed in four places that had to be kept
 * in sync by hand and didn't stay that way: the server importer's `classify()`,
 * the server exporter's `baseColumns`, the import-template builder, and the web
 * import dialog's `BUILTIN_FIELDS`. A header alias added on the server but not
 * the client meant the dialog silently offered "ignore" for a column the server
 * would happily have mapped.
 *
 * Lives in @ccp/shared (not apps/api) precisely so the browser mapping UI and
 * the Node importer read the SAME definition. Framework-agnostic: no Prisma, no
 * React, no Zod — just data plus two pure lookups.
 */

/** Where a mapped column's value lands on the Contact row. */
export type TransferColumnId =
  | "phone_number"
  | "name"
  | "first_name"
  | "last_name"
  | "email"
  | "location"
  | "language"
  | "country"
  | "tags"
  | "stage"
  | "source"
  | "id";

export interface TransferColumn {
  id: TransferColumnId;
  /** Canonical header written by export + the downloadable template. */
  header: string;
  /** Human label for the mapping UI. */
  label: string;
  /**
   * Extra headers accepted on IMPORT, lowercased. The canonical `header` is
   * always accepted and does not need to be repeated here.
   */
  aliases: readonly string[];
  /**
   * `false` for columns we emit on export but deliberately ignore on import
   * (`source` — imported rows are always `manual`; `id` — a foreign row id is
   * meaningless in this team). Kept in the table rather than special-cased in
   * the importer so "why is this column ignored?" has one answer.
   */
  importable: boolean;
  /** Example cell for the downloadable template. */
  example?: string;
}

export const TRANSFER_COLUMNS: readonly TransferColumn[] = [
  {
    id: "phone_number",
    header: "phone_number",
    label: "Phone number",
    // "mobile"/"whatsapp" show up constantly in real CRM exports.
    aliases: ["phone", "phone number", "phonenumber", "mobile", "mobile number", "msisdn", "whatsapp", "whatsapp number"],
    importable: true,
    example: "15551234567",
  },
  {
    id: "name",
    header: "name",
    label: "Full name",
    aliases: ["full name", "full_name", "fullname", "contact name", "display name"],
    importable: true,
    example: "John Example",
  },
  {
    id: "first_name",
    header: "first_name",
    label: "First name",
    aliases: ["firstname", "first name", "given_name", "given name"],
    importable: true,
    example: "John",
  },
  {
    id: "last_name",
    header: "last_name",
    label: "Last name",
    aliases: ["lastname", "last name", "surname", "family_name", "family name"],
    importable: true,
    example: "Example",
  },
  {
    id: "email",
    header: "email",
    label: "Email",
    aliases: ["e-mail", "email_address", "email address", "mail"],
    importable: true,
    example: "john@example.com",
  },
  {
    id: "location",
    header: "location",
    label: "Location",
    aliases: ["city", "town"],
    importable: true,
    example: "New York",
  },
  {
    id: "language",
    header: "language",
    label: "Language",
    aliases: ["locale", "lang"],
    importable: true,
    example: "en",
  },
  {
    id: "country",
    header: "country",
    label: "Country",
    aliases: ["country_code", "country code", "countrycode", "iso_country"],
    importable: true,
    example: "US",
  },
  {
    id: "tags",
    header: "tags",
    label: "Tags",
    aliases: ["tag", "labels", "label"],
    importable: true,
    example: "VIP, Lead",
  },
  {
    id: "stage",
    header: "stage",
    label: "Stage",
    aliases: ["stage_name", "stage name", "pipeline", "pipeline_stage"],
    importable: true,
    example: "Stage 1",
  },
  // Emitted by export so a file is self-describing; ignored on import.
  { id: "source", header: "source", label: "Source", aliases: [], importable: false },
  { id: "id", header: "id", label: "Contact ID", aliases: ["contact_id", "contact id"], importable: false },
];

/** Canonical export/template header order. */
export const TRANSFER_COLUMN_HEADERS: readonly string[] = TRANSFER_COLUMNS.map((c) => c.header);

/** Headers export writes but import ignores — used for the "unknown column" report. */
const IGNORED_HEADERS = new Set<string>(
  TRANSFER_COLUMNS.filter((c) => !c.importable).flatMap((c) => [c.header, ...c.aliases]),
);

/** header (lowercased) → column, built once. */
const BY_HEADER = new Map<string, TransferColumn>();
for (const col of TRANSFER_COLUMNS) {
  BY_HEADER.set(col.header.toLowerCase(), col);
  for (const alias of col.aliases) BY_HEADER.set(alias.toLowerCase(), col);
}

/**
 * Resolve a raw file header to a built-in column, or `null` when it matches
 * none (the caller then tries the team's custom-field labels, and failing that
 * reports it as an unknown column).
 *
 * Whitespace and case are normalized because spreadsheet headers arrive as
 * "Phone Number " far more often than "phone_number".
 */
export function matchTransferColumn(header: string): TransferColumn | null {
  return BY_HEADER.get(header.trim().toLowerCase().replace(/\s+/g, " ")) ?? null;
}

/**
 * True for a header that is a known column we intentionally skip on import.
 * Distinct from "unknown": re-importing an exported file shouldn't warn the
 * user about the `source` and `id` columns WE wrote.
 */
export function isIgnoredTransferHeader(header: string): boolean {
  return IGNORED_HEADERS.has(header.trim().toLowerCase().replace(/\s+/g, " "));
}

/** Columns offered as mapping targets in the UI (built-ins only). */
export const IMPORTABLE_TRANSFER_COLUMNS: readonly TransferColumn[] = TRANSFER_COLUMNS.filter(
  (c) => c.importable,
);

/**
 * How the importer resolves each row's identity. Phone/WhatsApp is the only
 * mode: it's the sole channel whose natural key a person can actually type into
 * a spreadsheet (social channels key on a vendor-issued `externalContactId`).
 * An imported email is stored but NEVER treated as a strong identity key — see
 * docs/identity.md; letting a hand-typed address merge two Customers is the
 * impersonation hole that was closed in the widget pre-chat flow.
 */
export const TRANSFER_IDENTITY_CHANNEL = "whatsapp" as const;

/** Write modes for an import run. */
export type ImportMode = "create_only" | "create_and_update" | "update_only";
export const IMPORT_MODES: readonly ImportMode[] = [
  "create_only",
  "create_and_update",
  "update_only",
];

/** What an import does with tags on a row that already has some. */
export type ImportTagMode = "merge" | "replace";
export const IMPORT_TAG_MODES: readonly ImportTagMode[] = ["merge", "replace"];

/** File formats both directions support. */
export type TransferFormat = "csv" | "xlsx";
export const TRANSFER_FORMATS: readonly TransferFormat[] = ["csv", "xlsx"];

export const TRANSFER_FORMAT_EXTENSION: Record<TransferFormat, string> = {
  csv: "csv",
  xlsx: "xlsx",
};

export const TRANSFER_FORMAT_MIME: Record<TransferFormat, string> = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

// ---------------------------------------------------------------------------
// Limits — shared so the browser can pre-validate with the EXACT server numbers
// instead of a hand-copied approximation that drifts.
// ---------------------------------------------------------------------------

/** Max upload size for an import file. */
export const TRANSFER_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Max data rows in one import. The in-file phone de-dupe set holds one
 * normalized string per row; 200k bounds it to a few tens of MB, which is the
 * real constraint on a 2 GB-limit API container (§16).
 */
export const TRANSFER_MAX_IMPORT_ROWS = 200_000;

/**
 * Max rows in one export. Excel's own worksheet limit is 1,048,576 including
 * the header, so anything above this can't be opened in Excel at all.
 */
export const TRANSFER_MAX_EXPORT_ROWS = 1_000_000;

/**
 * Above this row count an import STOPS publishing per-row `contact.created` /
 * `contact.updated`. Those events drive workflow dispatch and outbound-webhook
 * deliveries — at 100k rows that is 100k workflow runs and 100k HTTP deliveries
 * on a single-VPS deployment, the same failure mode the "never subscribe audit
 * or workflow to broadcast.*" invariant exists to prevent (CLAUDE.md §9).
 * Under the cap, behavior is byte-identical to the pre-job importer.
 */
export const IMPORT_EVENT_FANOUT_CAP = 5_000;

/** Max distinct NEW tag names one import may auto-create (catalog protection). */
export const TRANSFER_MAX_NEW_TAGS = 100;

/** Max failed rows written to the downloadable error report. */
export const TRANSFER_MAX_ERROR_ROWS = 50_000;
