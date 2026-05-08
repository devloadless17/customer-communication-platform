import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth-helpers";
import { serializeCsv } from "@/lib/csv";
import { db } from "@/lib/db";

/**
 * Export every contact in the team as a CSV. Columns: phone_number, name,
 * email, location, source, plus one column per team-wide custom field
 * (using the field's label as the header, so the file is self-describing
 * for re-import).
 *
 * No pagination — the contact set is small (capped at the team level by
 * usage; no enterprise tier yet) and a single SELECT keeps the response
 * deterministic. Per-contact one-off custom field keys ARE included as
 * additional columns so a round-trip export-then-import preserves them.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { teamId } = session;

  const [contacts, fieldDefs] = await Promise.all([
    db.contact.findMany({
      where: { teamId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    db.contactFieldDefinition.findMany({
      where: { teamId },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    }),
  ]);

  // Collect any per-contact one-off keys we encounter. Render them after the
  // team-wide columns so the schema-defined fields stay in a stable order.
  const teamKeys = new Set(fieldDefs.map((d) => d.key));
  const oneOffKeys = new Set<string>();
  for (const c of contacts) {
    if (c.customFields && typeof c.customFields === "object" && !Array.isArray(c.customFields)) {
      for (const k of Object.keys(c.customFields as Record<string, unknown>)) {
        if (!teamKeys.has(k)) oneOffKeys.add(k);
      }
    }
  }

  const baseColumns = ["phone_number", "name", "email", "location", "source"];
  const teamColumns = fieldDefs.map((d) => d.label);
  const oneOffColumns = Array.from(oneOffKeys).sort();
  const columns = [...baseColumns, ...teamColumns, ...oneOffColumns];

  const rows = contacts.map((c) => {
    const cf =
      c.customFields && typeof c.customFields === "object" && !Array.isArray(c.customFields)
        ? (c.customFields as Record<string, unknown>)
        : {};
    const row: Record<string, string> = {
      phone_number: c.phoneNumber,
      name: c.name,
      email: c.email ?? "",
      location: c.location ?? "",
      source: c.source,
    };
    for (const def of fieldDefs) {
      const v = cf[def.key];
      row[def.label] = typeof v === "string" ? v : "";
    }
    for (const key of oneOffColumns) {
      const v = cf[key];
      row[key] = typeof v === "string" ? v : "";
    }
    return row;
  });

  const csv = serializeCsv(columns, rows);
  // Stamp the filename with the date so multiple exports in a day don't
  // overwrite each other in Downloads.
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="contacts-${stamp}.csv"`,
    },
  });
}
