/**
 * End-to-end smoke + correctness harness for contact import/export.
 *
 * Runs the REAL runners against the REAL dev database and REAL R2 — not mocks.
 * The whole point of this subsystem is behavior under conditions that are hard
 * to reason about on paper (Excel's typed cells, formula injection, blank-cell
 * upsert semantics, the identity invariant), so it is verified by execution.
 *
 *   pnpm --filter @ccp/api exec tsx scripts/contact-transfer-smoke.ts
 *
 * Creates a throwaway team, exercises every path, and deletes the team at the
 * end (cascade removes contacts/tags/jobs). Safe to run repeatedly.
 */

import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { config as loadEnv } from "dotenv";

// Standalone under tsx: load the repo .env before anything touches process.env
// (the Prisma + R2 clients read it at construction).
loadEnv({ path: resolve(__dirname, "../../../.env") });

// Imported AFTER loadEnv (tsx compiles to CJS here, so these are `require`d
// eagerly at module scope — hence the explicit requires rather than
// top-of-file `import`s, which would construct the Prisma/R2 clients before
// the .env is on process.env).
const { db, setSharedDb } = require("../src/lib/db") as typeof import("../src/lib/db");
const { PrismaPg } = require("@prisma/adapter-pg") as typeof import("@prisma/adapter-pg");
const { PrismaClient } = require("@prisma/client") as typeof import("@prisma/client");

// `db` is a Proxy that refuses to resolve until DbService boots (it exists to
// stop a second pool being created behind Nest's back). Standing up the whole
// Nest app for a script would be slower and would start every worker + sweeper,
// so bind ONE client through the module's own seam instead.
setSharedDb(
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  }) as never,
);
const { blobStorage } =
  require("../src/lib/blob-storage") as typeof import("../src/lib/blob-storage");
const { createSink, createSource, cellToString } =
  require("../src/lib/contact-transfer/formats") as typeof import("../src/lib/contact-transfer/formats");
const { runContactExport } =
  require("../src/lib/contact-transfer/export-runner") as typeof import("../src/lib/contact-transfer/export-runner");
const { runContactImport } =
  require("../src/lib/contact-transfer/import-runner") as typeof import("../src/lib/contact-transfer/import-runner");

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}`, detail === undefined ? "" : detail);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected), {
    actual,
    expected,
  });
}

async function main(): Promise<void> {
  const suffix = randomUUID().slice(0, 8);
  const team = await db.workspace.create({
    data: { name: `transfer-smoke-${suffix}` },
    select: { id: true },
  });
  const workspaceId = team.id;
  console.log(`\nteam ${workspaceId}\n`);

  try {
    await testFormats();
    await testExportImportRoundTrip(workspaceId);
    await testUpsertSemantics(workspaceId);
    await testIdentityInvariant(workspaceId);
    await testCollidingCustomField(workspaceId);
    await testErrorReportAndCaps(workspaceId);
    await testTenantIsolation(workspaceId);
  } finally {
    await db.workspace.delete({ where: { id: workspaceId } }).catch((e) => {
      console.error("cleanup failed", e);
    });
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------

async function testFormats(): Promise<void> {
  console.log("format layer");

  // cellToString is where naive importers break — assert each hazard directly.
  eq("numeric phone renders without exponent", cellToString(15551234567), "15551234567");
  eq("big numeric phone", cellToString(972501234567), "972501234567");
  eq("formula cell uses cached result", cellToString({ formula: 'A1&"x"', result: "15559999" }), "15559999");
  eq("error cell → empty", cellToString({ error: "#N/A" }), "");
  eq("rich text flattened", cellToString({ richText: [{ text: "Ali " }, { text: "Ahmad" }] }), "Ali Ahmad");
  eq("hyperlink uses text", cellToString({ text: "a@b.com", hyperlink: "mailto:a@b.com" }), "a@b.com");
  eq("date → ISO", cellToString(new Date("2020-01-02T03:04:05Z")), "2020-01-02T03:04:05.000Z");
  eq("null → empty", cellToString(null), "");
  eq("decimal keeps precision", cellToString(1.5), "1.5");

  // Round-trip nasty values through BOTH formats.
  const nasty: Record<string, string> = {
    phone_number: "15550000001",
    name: 'Ali "The, Great" Ahmad\nSecond line',
    email: "=HYPERLINK(\"http://evil\")",
    location: "بيروت 🇱🇧 😀",
    language: "ar",
  };
  const columns = Object.keys(nasty);

  for (const format of ["csv", "xlsx"] as const) {
    const path = join(tmpdir(), `smoke-${randomUUID()}.${format}`);
    const sink = createSink(format, path);
    await sink.writeHeader(columns);
    await sink.writeRows([nasty]);
    await sink.finish();

    const source = createSource(format, path);
    const headers = await source.headers();
    const rows: Array<Record<string, string>> = [];
    for await (const r of source.rows()) rows.push(r.cells);
    await source.close();
    await unlink(path).catch(() => {});

    eq(`${format}: headers round-trip`, headers, columns);
    eq(`${format}: one data row`, rows.length, 1);
    const got = rows[0] ?? {};
    eq(`${format}: quotes/commas/newlines preserved`, got.name, nasty.name);
    eq(`${format}: unicode + emoji preserved`, got.location, nasty.location);
    eq(`${format}: phone preserved`, got.phone_number, nasty.phone_number);
    if (format === "csv") {
      // CSV must DEFUSE the formula (leading ') so a spreadsheet treats it as
      // text; the value therefore comes back with the quote attached.
      check(
        "csv: formula-injection defused on write",
        (got.email ?? "").startsWith("'="),
        got.email,
      );
    } else {
      // XLSX writes typed strings, so `=` is inert and the value is verbatim.
      eq("xlsx: formula text stored inert", got.email, nasty.email);
    }
  }
}

// ---------------------------------------------------------------------------

async function testExportImportRoundTrip(workspaceId: string): Promise<void> {
  console.log("\nexport → import round trip");

  const stage = await db.contactStage.create({
    data: { workspaceId, name: "Qualified", position: 0, isDefault: true },
    select: { id: true, name: true },
  });
  await db.contactFieldDefinition.create({
    data: { workspaceId, key: "company", label: "Company", order: 0 },
  });
  const tag = await db.tag.create({ data: { workspaceId, name: "VIP" }, select: { id: true } });

  await db.contact.create({
    data: {
      workspaceId,
      identityChannel: "whatsapp",
      phoneNumber: "15551110001",
      name: "Round Trip",
      email: "rt@example.com",
      location: "بيروت 😀",
      stageId: stage.id,
      customFields: { company: "Loadless, Inc." },
      tags: { connect: [{ id: tag.id }] },
    },
  });

  for (const format of ["csv", "xlsx"] as const) {
    const jobId = `smoke-export-${format}-${randomUUID().slice(0, 8)}`;
    const res = await runContactExport({ workspaceId, jobId, format, scope: { filters: {} } });
    eq(`${format}: exported 1 row`, res.rowCount, 1);

    // Pull the artifact back and re-read it.
    const localPath = join(tmpdir(), `smoke-dl-${randomUUID()}.${format}`);
    await downloadArtifact(res.artifactKey, localPath);
    const source = createSource(format, localPath);
    const rows: Array<Record<string, string>> = [];
    for await (const r of source.rows()) rows.push(r.cells);
    await source.close();

    const row = rows[0] ?? {};
    eq(`${format}: phone exported`, row.phone_number, "15551110001");
    eq(`${format}: unicode name/location survived R2`, row.location, "بيروت 😀");
    eq(`${format}: tag name exported`, row.tags, "VIP");
    eq(`${format}: stage name exported`, row.stage, "Qualified");
    eq(`${format}: custom field exported under LABEL`, row.Company, "Loadless, Inc.");

    // Re-import the exact artifact into the same team: everything already
    // exists, so create_only must be a pure no-op.
    const sourceKey = `contact-imports/${workspaceId}/smoke-${format}-${randomUUID().slice(0, 8)}.${format}`;
    await blobStorage.putObjectFromFile({
      key: sourceKey,
      path: localPath,
      contentType: "application/octet-stream",
    });
    const imported = await runContactImport({
      workspaceId,
      userId: null,
      jobId: `smoke-import-${format}`,
      format,
      sourceKey,
      resumeFrom: 0,
      options: {
        mode: "create_only",
        tagMode: "merge",
        fireAutomations: false,
        canManageTags: true,
      },
    });
    eq(`${format}: re-import created nothing`, imported.created, 0);
    eq(`${format}: re-import skipped the existing row`, imported.skipped, 1);
    eq(`${format}: re-import reported no unknown columns`, imported.unknownColumns, []);
    eq(`${format}: no row failures`, imported.failed, 0);

    await unlink(localPath).catch(() => {});
  }
}

// ---------------------------------------------------------------------------

async function testUpsertSemantics(workspaceId: string): Promise<void> {
  console.log("\nwrite modes");

  await db.contact.create({
    data: {
      workspaceId,
      identityChannel: "whatsapp",
      phoneNumber: "15552220002",
      name: "Original Name",
      email: "original@example.com",
      location: "Beirut",
      customFields: { company: "OldCo" },
    },
  });

  // A file that sets email + company but leaves name and location BLANK.
  const path = join(tmpdir(), `smoke-upsert-${randomUUID()}.csv`);
  const sink = createSink("csv", path);
  const columns = ["phone_number", "name", "email", "location", "Company", "tags"];
  await sink.writeHeader(columns);
  await sink.writeRows([
    {
      phone_number: "15552220002",
      name: "",
      email: "updated@example.com",
      location: "",
      Company: "NewCo",
      tags: "Imported",
    },
  ]);
  await sink.finish();
  const sourceKey = `contact-imports/${workspaceId}/upsert-${randomUUID().slice(0, 8)}.csv`;
  await blobStorage.putObjectFromFile({ key: sourceKey, path, contentType: "text/csv" });

  // create_only must NOT touch it.
  const skipRun = await runContactImport({
    workspaceId, userId: null, jobId: `smoke-skip-${randomUUID().slice(0, 8)}`, format: "csv",
    sourceKey, resumeFrom: 0,
    options: { mode: "create_only", tagMode: "merge", fireAutomations: false, canManageTags: true },
  });
  eq("create_only skips an existing contact", skipRun.skipped, 1);
  eq("create_only updated nothing", skipRun.updated, 0);
  const afterSkip = await getContact(workspaceId, "15552220002");
  eq("create_only left email untouched", afterSkip?.email, "original@example.com");

  // create_and_update applies non-empty cells only.
  const upsertRun = await runContactImport({
    workspaceId, userId: null, jobId: `smoke-upsert-${randomUUID().slice(0, 8)}`, format: "csv",
    sourceKey, resumeFrom: 0,
    options: { mode: "create_and_update", tagMode: "merge", fireAutomations: false, canManageTags: true },
  });
  eq("create_and_update updated 1", upsertRun.updated, 1);
  const after = await getContact(workspaceId, "15552220002");
  eq("non-empty cell overwrote email", after?.email, "updated@example.com");
  eq("BLANK cell did NOT wipe name", after?.name, "Original Name");
  eq("BLANK cell did NOT wipe location", after?.location, "Beirut");
  eq("custom field merged", (after?.customFields as Record<string, string>)?.company, "NewCo");
  check("version bumped (CAS)", (after?.version ?? 0) > 0, after?.version);
  const tags = await db.contact.findFirst({
    where: { workspaceId, phoneNumber: "15552220002" },
    select: { tags: { select: { name: true } } },
  });
  check("tag linked on update", tags?.tags.some((t) => t.name === "Imported") ?? false, tags?.tags);

  // update_only must not create.
  const path2 = join(tmpdir(), `smoke-updateonly-${randomUUID()}.csv`);
  const sink2 = createSink("csv", path2);
  await sink2.writeHeader(["phone_number", "name"]);
  await sink2.writeRows([{ phone_number: "15559990009", name: "Should Not Exist" }]);
  await sink2.finish();
  const key2 = `contact-imports/${workspaceId}/updateonly-${randomUUID().slice(0, 8)}.csv`;
  await blobStorage.putObjectFromFile({ key: key2, path: path2, contentType: "text/csv" });
  const updateOnly = await runContactImport({
    workspaceId, userId: null, jobId: `smoke-uo-${randomUUID().slice(0, 8)}`, format: "csv",
    sourceKey: key2, resumeFrom: 0,
    options: { mode: "update_only", tagMode: "merge", fireAutomations: false, canManageTags: true },
  });
  eq("update_only created nothing", updateOnly.created, 0);
  eq("update_only skipped the absent row", updateOnly.skipped, 1);
  eq(
    "update_only really did not insert",
    await db.contact.count({ where: { workspaceId, phoneNumber: "15559990009" } }),
    0,
  );

  await unlink(path).catch(() => {});
  await unlink(path2).catch(() => {});
}

// ---------------------------------------------------------------------------

async function testIdentityInvariant(workspaceId: string): Promise<void> {
  console.log("\nidentity invariant (docs/identity.md)");

  // A contact on a DIFFERENT channel that already owns an email + a Customer.
  const customer = await db.customer.create({ data: { workspaceId, name: "Existing Person" } });
  await db.contact.create({
    data: {
      workspaceId,
      identityChannel: "instagram",
      externalContactId: `ig-${randomUUID().slice(0, 8)}`,
      name: "Existing Person",
      email: "shared@example.com",
      customerId: customer.id,
    },
  });
  const customersBefore = await db.customer.count({ where: { workspaceId } });

  // Import a WhatsApp row carrying the SAME email. It must NOT fold the two
  // people together — a hand-typed spreadsheet address is not a verified
  // identity, and treating it as one is the impersonation hole closed in the
  // widget pre-chat flow.
  const path = join(tmpdir(), `smoke-identity-${randomUUID()}.csv`);
  const sink = createSink("csv", path);
  await sink.writeHeader(["phone_number", "name", "email"]);
  await sink.writeRows([
    { phone_number: "15553330003", name: "Someone Else", email: "shared@example.com" },
  ]);
  await sink.finish();
  const key = `contact-imports/${workspaceId}/identity-${randomUUID().slice(0, 8)}.csv`;
  await blobStorage.putObjectFromFile({ key, path, contentType: "text/csv" });

  const run = await runContactImport({
    workspaceId, userId: null, jobId: `smoke-identity-${randomUUID().slice(0, 8)}`, format: "csv",
    sourceKey: key, resumeFrom: 0,
    options: { mode: "create_and_update", tagMode: "merge", fireAutomations: false, canManageTags: true },
  });
  eq("imported the new whatsapp contact", run.created, 1);

  const created = await getContact(workspaceId, "15553330003");
  eq("imported email stored", created?.email, "shared@example.com");
  check(
    "imported contact was NOT auto-merged into the existing customer",
    created?.customerId !== customer.id,
    { got: created?.customerId, existing: customer.id },
  );
  eq(
    "no customers were merged away",
    await db.customer.count({ where: { workspaceId } }),
    customersBefore,
  );

  await unlink(path).catch(() => {});
}

// ---------------------------------------------------------------------------

/**
 * A custom field whose LABEL a built-in column would shadow ("Language" vs the
 * built-in `language`).
 *
 * The reserved-name guard rejects these at create time, but pre-guard rows and
 * (until now) /v1-created rows exist in real databases — this team's dev DB had
 * exactly one. Without the `custom:<key>` header form the export emits TWO
 * columns that both resolve to the built-in on re-import, the last one wins,
 * and the custom field's value is silently replaced by the built-in's.
 */
async function testCollidingCustomField(workspaceId: string): Promise<void> {
  console.log("\ncustom field colliding with a built-in column");

  // Insert directly — the API guard (correctly) refuses to create this.
  await db.contactFieldDefinition.create({
    data: { workspaceId, key: "language", label: "Language", order: 5 },
  });
  await db.contact.create({
    data: {
      workspaceId,
      identityChannel: "whatsapp",
      phoneNumber: "15556660006",
      name: "Collide Case",
      language: "en", // the BUILT-IN column
      customFields: { language: "Klingon" }, // the CUSTOM field
    },
  });

  const res = await runContactExport({
    workspaceId,
    jobId: `smoke-collide-${randomUUID().slice(0, 8)}`,
    format: "csv",
    scope: { filters: { search: "15556660006" } },
  });
  const path = join(tmpdir(), `smoke-collide-${randomUUID()}.csv`);
  await downloadArtifact(res.artifactKey, path);
  const src = createSource("csv", path);
  const headers = await src.headers();
  const rows: Array<Record<string, string>> = [];
  for await (const r of src.rows()) rows.push(r.cells);
  await src.close();

  const lower = headers.map((h) => h.toLowerCase());
  eq(
    "no duplicate header (built-in vs colliding label)",
    lower.length,
    new Set(lower).size,
  );
  check("colliding field exported as custom:<key>", headers.includes("custom:language"), headers);
  check("plain 'Language' label NOT emitted", !headers.includes("Language"), headers);

  const row = rows[0] ?? {};
  eq("built-in language kept its own value", row.language, "en");
  eq("custom field kept its own value", row["custom:language"], "Klingon");

  // Round-trip into a clean team: both values must survive, still separated.
  const other = await db.workspace.create({
    data: { name: `collide-${randomUUID().slice(0, 8)}` },
    select: { id: true },
  });
  try {
    await db.contactFieldDefinition.create({
      data: { workspaceId: other.id, key: "language", label: "Language", order: 0 },
    });
    const key = `contact-imports/${other.id}/collide-${randomUUID().slice(0, 8)}.csv`;
    await blobStorage.putObjectFromFile({ key, path, contentType: "text/csv" });
    const run = await runContactImport({
      workspaceId: other.id,
      userId: null,
      jobId: `smoke-collide-imp-${randomUUID().slice(0, 8)}`,
      format: "csv",
      sourceKey: key,
      resumeFrom: 0,
      options: {
        mode: "create_and_update",
        tagMode: "merge",
        fireAutomations: false,
        canManageTags: true,
      },
    });
    eq("colliding-column file imports cleanly", run.failed, 0);
    // The clean team has no "Company" field, so reporting THAT as unknown is
    // correct. What must not happen is either language column being unknown.
    check(
      "neither language column reported unknown",
      !run.unknownColumns.some((c) => c.toLowerCase().includes("language")),
      run.unknownColumns,
    );

    const landed = await db.contact.findFirst({
      where: { workspaceId: other.id, phoneNumber: "15556660006" },
      select: { language: true, customFields: true },
    });
    eq("built-in language round-tripped", landed?.language, "en");
    eq(
      "custom field round-tripped SEPARATELY",
      (landed?.customFields as Record<string, string>)?.language,
      "Klingon",
    );
  } finally {
    await db.workspace.delete({ where: { id: other.id } }).catch(() => {});
    await unlink(path).catch(() => {});
  }
}

// ---------------------------------------------------------------------------

async function testErrorReportAndCaps(workspaceId: string): Promise<void> {
  console.log("\nrow errors + error report");

  const path = join(tmpdir(), `smoke-errors-${randomUUID()}.csv`);
  const sink = createSink("csv", path);
  await sink.writeHeader(["phone_number", "name", "mystery_column"]);
  await sink.writeRows([
    { phone_number: "15554440004", name: "Good", mystery_column: "x" },
    { phone_number: "", name: "No Phone", mystery_column: "x" },
    { phone_number: "not-a-phone", name: "Bad Phone", mystery_column: "x" },
    { phone_number: "15554440004", name: "Dup In File", mystery_column: "x" },
  ]);
  await sink.finish();
  const key = `contact-imports/${workspaceId}/errors-${randomUUID().slice(0, 8)}.csv`;
  await blobStorage.putObjectFromFile({ key, path, contentType: "text/csv" });

  const run = await runContactImport({
    workspaceId, userId: null, jobId: `smoke-errors-${randomUUID().slice(0, 8)}`, format: "csv",
    sourceKey: key, resumeFrom: 0,
    options: { mode: "create_only", tagMode: "merge", fireAutomations: false, canManageTags: true },
  });

  eq("one good row created", run.created, 1);
  eq("three rows failed", run.failed, 3);
  eq("counters cover every row", run.processedRows, 4);
  eq("unknown column reported", run.unknownColumns, ["mystery_column"]);
  check("error report artifact written", Boolean(run.errorArtifactKey), run.errorArtifactKey);
  check(
    "missing-phone reason is specific",
    run.errorSample.some((e) => e.reason.includes("missing phone")),
    run.errorSample,
  );
  check(
    "invalid-phone reason names the value",
    run.errorSample.some((e) => e.reason.includes("not-a-phone")),
    run.errorSample,
  );
  check(
    "in-file duplicate detected",
    run.errorSample.some((e) => e.reason.includes("duplicate")),
    run.errorSample,
  );

  // The error report must be re-readable and carry the original cells.
  if (run.errorArtifactKey) {
    const dl = join(tmpdir(), `smoke-errrep-${randomUUID()}.csv`);
    await downloadArtifact(run.errorArtifactKey, dl);
    const src = createSource("csv", dl);
    const headers = await src.headers();
    const rows: Array<Record<string, string>> = [];
    for await (const r of src.rows()) rows.push(r.cells);
    await src.close();
    check("error report leads with _row/_error", headers[0] === "_row" && headers[1] === "_error", headers);
    eq("error report has one row per failure", rows.length, 3);
    check(
      "error report preserves the original cells",
      rows.every((r) => "name" in r),
      rows[0],
    );
    await unlink(dl).catch(() => {});
  }

  // Row numbers must match what the user sees in a spreadsheet (header = 1).
  check(
    "row numbers are spreadsheet line numbers",
    run.errorSample.every((e) => e.row >= 2 && e.row <= 5),
    run.errorSample,
  );

  await unlink(path).catch(() => {});
}

// ---------------------------------------------------------------------------

async function testTenantIsolation(workspaceId: string): Promise<void> {
  console.log("\ntenant isolation");

  const other = await db.workspace.create({
    data: { name: `other-${randomUUID().slice(0, 8)}` },
    select: { id: true },
  });
  try {
    await db.contact.create({
      data: {
        workspaceId: other.id,
        identityChannel: "whatsapp",
        phoneNumber: "15558880008",
        name: "Other Team Contact",
      },
    });

    const jobId = `smoke-iso-${randomUUID().slice(0, 8)}`;
    const res = await runContactExport({ workspaceId, jobId, format: "csv", scope: { filters: {} } });
    const path = join(tmpdir(), `smoke-iso-${randomUUID()}.csv`);
    await downloadArtifact(res.artifactKey, path);
    const src = createSource("csv", path);
    const rows: Array<Record<string, string>> = [];
    for await (const r of src.rows()) rows.push(r.cells);
    await src.close();
    await unlink(path).catch(() => {});

    check(
      "export never includes another team's contact",
      !rows.some((r) => r.phone_number === "15558880008"),
      rows.map((r) => r.phone_number),
    );

    // Explicit-id export with a FOREIGN id must yield nothing, not that row.
    const foreign = await db.contact.findFirst({
      where: { workspaceId: other.id },
      select: { id: true },
    });
    const idRes = await runContactExport({
      workspaceId,
      jobId: `smoke-iso2-${randomUUID().slice(0, 8)}`,
      format: "csv",
      scope: { ids: [foreign!.id] },
    });
    eq("foreign id in an explicit selection exports 0 rows", idRes.rowCount, 0);
  } finally {
    await db.workspace.delete({ where: { id: other.id } }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------

async function getContact(workspaceId: string, phoneNumber: string) {
  return db.contact.findFirst({
    where: { workspaceId, phoneNumber, identityChannel: "whatsapp" },
    select: {
      name: true,
      email: true,
      location: true,
      customFields: true,
      version: true,
      customerId: true,
    },
  });
}

async function downloadArtifact(key: string, path: string): Promise<void> {
  const { createWriteStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");
  const obj = await blobStorage.getObject(key);
  await pipeline(obj.body, createWriteStream(path));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect().catch(() => {});
    // The S3 client keeps pooled sockets alive, which would hold the event
    // loop open after every assertion has run. Exit explicitly.
    process.exit(process.exitCode ?? 0);
  });
