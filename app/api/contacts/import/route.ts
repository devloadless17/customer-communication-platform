import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { parseCsv } from "@/lib/csv";
import { db } from "@/lib/db";
import { normalizePhoneE164 } from "@/lib/phone";
import { ensureDefaultStage } from "@/lib/queries";

/**
 * Import contacts from a CSV.
 *
 * Dedupe rule: phone number is the WhatsApp identity. We use `upsert` keyed
 * on `(teamId, phoneNumber)` with `update: {}` so existing rows are left
 * untouched — only genuinely-new numbers get inserted. This is the
 * "only append the new ones" behavior the customer asked for, and it means
 * re-uploading the same file twice is a no-op.
 *
 * Column mapping:
 *  - `phone_number` (or `phone`) is required.
 *  - `name`, `email`, `location` map to those Contact columns.
 *  - `source` in the CSV is ignored — imported rows are always tagged
 *    `manual`. Round-trip exports thus correctly mark inbound→manual the
 *    second time around, but only for the rows that were actually new.
 *  - Any other column whose label matches a team-wide ContactFieldDefinition
 *    (case-insensitive) maps to that field's key in `customFields`.
 *  - All other columns are skipped and reported back so the user can decide
 *    whether to add them as team fields and re-import.
 *
 * Body: multipart/form-data with a single `file` part. We accept the raw
 * file rather than a JSON-encoded string because the CSV can be large enough
 * to make JSON encoding wasteful, and Next handles multipart natively.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024; // 5 MiB ought to be more than enough; SMB use case
const MAX_ROWS = 5000;
const MAX_TEXT = 500;

interface ImportResult {
  /** Rows we attempted to process (after header). */
  total: number;
  /** Newly-inserted rows. */
  created: number;
  /** Phone-number matches; left untouched. */
  skippedExisting: number;
  /** Rows we couldn't parse (missing phone, invalid format). */
  errors: Array<{ row: number; reason: string }>;
  /** Header columns that didn't match any known field — listed so the UI
   *  can prompt the user to add them as team fields. */
  unknownColumns: string[];
}

export async function POST(req: Request) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { teamId } = session;

  // Multipart parsing. Using `req.formData()` is fine here — Next streams
  // it; we cap the size below.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing 'file' field" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: `file too large (max ${MAX_BYTES} bytes)` }, { status: 413 });
  }
  const text = await file.text();

  let parsed;
  try {
    parsed = parseCsv(text);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "couldn't parse CSV" },
      { status: 400 },
    );
  }

  if (parsed.headers.length === 0 || parsed.rows.length === 0) {
    return NextResponse.json({ error: "CSV is empty" }, { status: 400 });
  }
  if (parsed.rows.length > MAX_ROWS) {
    return NextResponse.json(
      { error: `too many rows (max ${MAX_ROWS}, got ${parsed.rows.length})` },
      { status: 400 },
    );
  }

  // Build a header → role lookup. Phone, name, email, location are special;
  // `source` is intentionally ignored (imported rows are always 'manual');
  // remaining columns map to a team field by case-insensitive label match.
  const fieldDefs = await db.contactFieldDefinition.findMany({
    where: { teamId },
    select: { key: true, label: true },
  });
  const labelToKey = new Map(fieldDefs.map((d) => [d.label.toLowerCase(), d.key]));

  type Mapping =
    | { kind: "phone" }
    | { kind: "name" }
    | { kind: "email" }
    | { kind: "location" }
    | { kind: "ignore" }
    | { kind: "field"; key: string };

  function classify(header: string): Mapping {
    const h = header.toLowerCase().trim();
    if (h === "phone_number" || h === "phone" || h === "phone number") return { kind: "phone" };
    if (h === "name" || h === "full name") return { kind: "name" };
    if (h === "email" || h === "e-mail") return { kind: "email" };
    if (h === "location" || h === "city") return { kind: "location" };
    if (h === "source" || h === "id") return { kind: "ignore" };
    const key = labelToKey.get(h);
    if (key) return { kind: "field", key };
    return { kind: "ignore" };
  }

  const headerMap = new Map(parsed.headers.map((h) => [h, classify(h)]));
  const unknownColumns: string[] = [];
  for (const [header, mapping] of headerMap) {
    if (mapping.kind === "ignore" && header.toLowerCase() !== "source" && header.toLowerCase() !== "id") {
      unknownColumns.push(header);
    }
  }

  const errors: ImportResult["errors"] = [];

  // Build the list of inserts we'll attempt. Row numbers are 1-indexed from
  // the header (so row 2 is the first data row) — that matches what users
  // see in Excel.
  interface PendingRow {
    rowNumber: number;
    phoneNumber: string;
    name: string;
    email: string | null;
    location: string | null;
    customFields: Record<string, string>;
  }
  const pending: PendingRow[] = [];

  for (let i = 0; i < parsed.rows.length; i++) {
    const rowNumber = i + 2;
    const row = parsed.rows[i] ?? {};
    let phoneRaw: string | undefined;
    let name = "";
    let email = "";
    let location = "";
    const customFields: Record<string, string> = {};

    for (const [header, value] of Object.entries(row)) {
      const mapping = headerMap.get(header);
      if (!mapping) continue;
      switch (mapping.kind) {
        case "phone":
          phoneRaw = value;
          break;
        case "name":
          name = value.slice(0, MAX_TEXT);
          break;
        case "email":
          email = value.slice(0, MAX_TEXT);
          break;
        case "location":
          location = value.slice(0, MAX_TEXT);
          break;
        case "field":
          customFields[mapping.key] = value.slice(0, MAX_TEXT);
          break;
        case "ignore":
          break;
      }
    }

    if (!phoneRaw) {
      errors.push({ row: rowNumber, reason: "missing phone number" });
      continue;
    }
    const phone = normalizePhoneE164(phoneRaw);
    if (!phone) {
      errors.push({ row: rowNumber, reason: `invalid phone "${phoneRaw}"` });
      continue;
    }

    pending.push({
      rowNumber,
      phoneNumber: phone,
      name: name.trim() || phone,
      email: email.trim() || null,
      location: location.trim() || null,
      customFields,
    });
  }

  // Find existing rows in one query so we can report skip vs create accurately.
  // Doing it pre-write also lets us merge customFields into existing rows…
  // but the spec is "only append the new ones", so existing rows are left
  // alone end-to-end.
  const existing = await db.contact.findMany({
    where: { teamId, phoneNumber: { in: pending.map((p) => p.phoneNumber) } },
    select: { phoneNumber: true },
  });
  const existingSet = new Set(existing.map((e) => e.phoneNumber));

  const toCreate = pending.filter((p) => !existingSet.has(p.phoneNumber));
  const skippedExisting = pending.length - toCreate.length;

  // Bulk insert. createMany skips the unique-violation race (skipDuplicates:
  // true) so a webhook landing the same number between our pre-check and
  // insert doesn't error out — that race row counts as "skipped existing"
  // implicitly because it's not in `created` numbers.
  let created = 0;
  if (toCreate.length > 0) {
    // Land all imported rows in the team's default stage. One lookup
    // amortized over the whole batch — much cheaper than calling it
    // per-row, and the result is identical because every row goes to the
    // same destination.
    const defaultStageId = await ensureDefaultStage(teamId);
    const result = await db.contact.createMany({
      data: toCreate.map((p) => ({
        teamId,
        phoneNumber: p.phoneNumber,
        name: p.name,
        email: p.email ?? undefined,
        location: p.location ?? undefined,
        customFields: p.customFields,
        stageId: defaultStageId,
        source: "manual",
      })),
      skipDuplicates: true,
    });
    created = result.count;
  }

  const result: ImportResult = {
    total: parsed.rows.length,
    created,
    skippedExisting: skippedExisting + (toCreate.length - created),
    errors,
    unknownColumns,
  };
  return NextResponse.json(result);
}
