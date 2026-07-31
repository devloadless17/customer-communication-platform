/**
 * 100,000-contact load harness for contact import/export.
 *
 *   pnpm --filter @ccp/api exec tsx scripts/contact-transfer-load.ts [rows]
 *
 * The product claim is "this works at 100k on a single 8 GB VPS". That claim is
 * only real if it has been MEASURED — reading the code and concluding it
 * streams is exactly the reasoning that produces a 2 GB-limit container getting
 * OOM-killed in production (CLAUDE.md §16). So this seeds a throwaway team with
 * N contacts and runs, with peak RSS + heap sampled throughout:
 *
 *   export CSV → export XLSX → import the CSV back (create_only, all skips)
 *   → import the CSV back (create_and_update, all updates)
 *
 * The last two matter most: re-importing a 100k export is the single heaviest
 * realistic operation (100k lookups + 100k updates), and it's what a customer
 * doing "export, edit in Excel, re-upload" actually does.
 *
 * RUN IT UNDER A HARD HEAP CAP — this is the part that actually proves
 * anything:
 *
 *   NODE_OPTIONS="--max-old-space-size=384" pnpm --filter @ccp/api exec tsx \
 *     scripts/contact-transfer-load.ts 100000
 *
 * Without a cap, V8 lets garbage pile up to ~1 GB before collecting and
 * `heapUsed` reports numbers that look alarming but mean nothing. Under a cap,
 * a genuinely streaming implementation still completes (GC reclaims each
 * batch); one that buffers the file OOMs. The cap is the test.
 *
 * MEASURED 2026-07-21, 100,000 contacts, --max-old-space-size=384:
 *
 *   export CSV                            10.9s   peak heap 288 MB   10.1 MB out
 *   export XLSX                            9.7s   peak heap 170 MB    7.4 MB out
 *   import CSV create_only  (100k skips)   7.0s   peak heap 170 MB
 *   import CSV upsert       (100k updates) 20.1s  peak heap 167 MB
 *
 * 384 MB is a QUARTER of the api container's ~1536 MB heap budget (2 GB
 * mem_limit, heap ≤ ~75% — CLAUDE.md §16), so there is real headroom for a
 * transfer to run alongside the inbox rather than instead of it.
 *
 * Cleans up the team (and its contacts) at the end.
 */

import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { config as loadEnv } from "dotenv";

loadEnv({ path: resolve(__dirname, "../../../.env") });

const { db, setSharedDb } = require("../src/lib/db") as typeof import("../src/lib/db");
const { PrismaPg } = require("@prisma/adapter-pg") as typeof import("@prisma/adapter-pg");
const { PrismaClient } = require("@prisma/client") as typeof import("@prisma/client");

setSharedDb(
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  }) as never,
);

const { blobStorage } = require("../src/lib/blob-storage") as typeof import("../src/lib/blob-storage");
const { IMPORT_EVENT_FANOUT_CAP, TRANSFER_MAX_IMPORT_ROWS } =
  require("@ccp/shared/contacts/transfer-columns") as typeof import("@ccp/shared/contacts/transfer-columns");
const { runContactExport } =
  require("../src/lib/contact-transfer/export-runner") as typeof import("../src/lib/contact-transfer/export-runner");
const { runContactImport } =
  require("../src/lib/contact-transfer/import-runner") as typeof import("../src/lib/contact-transfer/import-runner");

const ROWS = Number(process.argv[2] ?? 100_000);
/** --keep: leave the seeded workspace behind (search/analytics probing at
 *  scale reuses it); blob artifacts are still deleted. Clean up later with a
 *  workspace delete on the printed id. */
const KEEP = process.argv.includes("--keep");

/**
 * Peak heap budget for one transfer. Set just above the measured worst case
 * (288 MB) so a regression to "buffer the whole file" trips it immediately,
 * with enough slack that GC timing jitter doesn't make it flaky.
 */
const HEAP_CEILING_MB = 400;

let peakHeapMb = 0;
let peakRssMb = 0;
let sampler: NodeJS.Timeout | null = null;

function startSampling(): void {
  peakHeapMb = 0;
  peakRssMb = 0;
  sampler = setInterval(() => {
    const m = process.memoryUsage();
    peakHeapMb = Math.max(peakHeapMb, m.heapUsed / 1048576);
    peakRssMb = Math.max(peakRssMb, m.rss / 1048576);
  }, 100);
  sampler.unref();
}

function stopSampling(): { heap: number; rss: number } {
  if (sampler) clearInterval(sampler);
  sampler = null;
  return { heap: Math.round(peakHeapMb), rss: Math.round(peakRssMb) };
}

let failures = 0;
function assertUnder(label: string, mb: number): void {
  if (mb > HEAP_CEILING_MB) {
    failures += 1;
    console.error(`  ✗ ${label}: peak heap ${mb} MB EXCEEDS the ${HEAP_CEILING_MB} MB budget`);
  } else {
    console.log(`  ✓ ${label}: peak heap ${mb} MB (budget ${HEAP_CEILING_MB} MB)`);
  }
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  startSampling();
  const t0 = Date.now();
  const out = await fn();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const { heap, rss } = stopSampling();
  console.log(`\n${label}`);
  console.log(`  wall ${secs}s · peak heap ${heap} MB · peak rss ${rss} MB`);
  assertUnder(label, heap);
  return out;
}

async function main(): Promise<void> {
  const runTag = `transfer-load-${randomUUID().slice(0, 8)}`;
  // A workspace requires an owning organization since the org→workspace
  // restructure; the throwaway org cascades away with the cleanup below.
  const team = await db.workspace.create({
    data: {
      name: runTag,
      organization: { create: { name: runTag } },
    },
    select: { id: true, organizationId: true },
  });
  const workspaceId = team.id;
  const organizationId = team.organizationId;
  console.log(`team ${workspaceId} · ${ROWS.toLocaleString()} rows\n`);

  try {
    await seed(workspaceId, ROWS);

    const csv = await timed("export CSV", () =>
      runContactExport({
        workspaceId,
        jobId: `load-csv-${randomUUID().slice(0, 8)}`,
        format: "csv",
        scope: { filters: {} },
      }),
    );
    console.log(`  rows=${csv.rowCount} size=${(csv.artifactBytes / 1048576).toFixed(1)} MB`);
    if (csv.rowCount !== ROWS) {
      failures += 1;
      console.error(`  ✗ exported ${csv.rowCount}, expected ${ROWS}`);
    }

    const xlsx = await timed("export XLSX", () =>
      runContactExport({
        workspaceId,
        jobId: `load-xlsx-${randomUUID().slice(0, 8)}`,
        format: "xlsx",
        scope: { filters: {} },
      }),
    );
    console.log(`  rows=${xlsx.rowCount} size=${(xlsx.artifactBytes / 1048576).toFixed(1)} MB`);

    // The import cap (TRANSFER_MAX_IMPORT_ROWS = 200k/file) is a deliberate
    // product guardrail — the runner tells users to split larger files. Above
    // it, this harness does exactly what a real customer does: split the
    // export into ≤cap parts and import them sequentially. The split scans
    // byte offsets (no whole-file string) so the heap cap keeps meaning
    // something; part buffers are slices + one ~20 MB concat each.
    const sourceParts: string[] = [];
    if (ROWS > TRANSFER_MAX_IMPORT_ROWS) {
      // STREAM the artifact (blobStorage.fetch caps whole-buffer reads at
      // 100 MB — a legitimate DoS guard the product never needs to exceed,
      // since real imports are ≤200k rows ≈ 20 MB; a 1M export is bigger).
      const { body } = await blobStorage.getObject(csv.artifactKey);
      let header: Buffer | null = null;
      let carry = Buffer.alloc(0);
      let lines = 0;
      let part = 0;
      let chunkPieces: Buffer[] = [];
      const flushPart = async () => {
        if (!header || chunkPieces.length === 0) return;
        const key = `transfers/${workspaceId}/load-part-${part}.csv`;
        await blobStorage.putObject({
          key,
          bytes: Buffer.concat([header, ...chunkPieces]),
          contentType: "text/csv",
        });
        sourceParts.push(key);
        chunkPieces = [];
        lines = 0;
        part += 1;
      };
      for await (const raw of body) {
        let buf: Buffer = Buffer.concat([carry, raw as Buffer]);
        if (!header) {
          const he = buf.indexOf(0x0a);
          if (he === -1) {
            carry = buf;
            continue;
          }
          header = Buffer.from(buf.subarray(0, he + 1));
          buf = buf.subarray(he + 1);
        }
        // Count newlines, slicing one piece per run of complete lines; the
        // partial tail carries into the next stream chunk.
        let pos = 0;
        let runStart = 0;
        while (pos < buf.length) {
          const nl = buf.indexOf(0x0a, pos);
          if (nl === -1) break;
          lines += 1;
          pos = nl + 1;
          if (lines >= TRANSFER_MAX_IMPORT_ROWS) {
            chunkPieces.push(Buffer.from(buf.subarray(runStart, pos)));
            await flushPart();
            runStart = pos;
          }
        }
        if (pos > runStart) chunkPieces.push(Buffer.from(buf.subarray(runStart, pos)));
        carry = Buffer.from(buf.subarray(pos));
      }
      if (carry.length > 0) {
        chunkPieces.push(carry);
        lines += 1;
      }
      await flushPart();
      console.log(
        `\nsplit ${ROWS.toLocaleString()} rows into ${sourceParts.length} parts of ≤${TRANSFER_MAX_IMPORT_ROWS.toLocaleString()} (the documented split-and-import flow)`,
      );
    } else {
      sourceParts.push(csv.artifactKey);
    }

    type ImportCounters = Awaited<ReturnType<typeof runContactImport>>;
    const importAllParts = async (
      label: string,
      mode: "create_only" | "create_and_update",
      fireAutomations: boolean,
    ): Promise<Pick<ImportCounters, "processedRows" | "skipped" | "updated" | "failed" | "automationsSkipped">> => {
      const total = { processedRows: 0, skipped: 0, updated: 0, failed: 0, automationsSkipped: false };
      for (let i = 0; i < sourceParts.length; i++) {
        const run = await runContactImport({
          workspaceId,
          userId: null,
          jobId: `${label}-${i}-${randomUUID().slice(0, 8)}`,
          format: "csv",
          sourceKey: sourceParts[i]!,
          resumeFrom: 0,
          options: { mode, tagMode: "merge", fireAutomations, canManageTags: true },
        });
        total.processedRows += run.processedRows;
        total.skipped += run.skipped;
        total.updated += run.updated;
        total.failed += run.failed;
        total.automationsSkipped ||= run.automationsSkipped;
      }
      return total;
    };

    // Re-import the CSV export. Every row already exists, so create_only is
    // N lookups + N skips — the cheapest realistic re-import.
    // (fireAutomations: true — above IMPORT_EVENT_FANOUT_CAP the runner
    // forces it off; passing true exercises that gate rather than bypassing it.)
    const skipRun = await timed("import CSV (create_only, all existing)", () =>
      importAllParts("load-imp-skip", "create_only", true),
    );
    console.log(
      `  processed=${skipRun.processedRows} skipped=${skipRun.skipped} failed=${skipRun.failed} automationsSkipped=${skipRun.automationsSkipped}`,
    );
    if (skipRun.skipped !== ROWS) {
      failures += 1;
      console.error(`  ✗ skipped ${skipRun.skipped}, expected ${ROWS}`);
    }
    // The runner suppresses only ABOVE the cap (rowsSeen > cap), so this
    // assertion is meaningful only when ROWS exceeds it.
    if (ROWS > IMPORT_EVENT_FANOUT_CAP && !skipRun.automationsSkipped) {
      failures += 1;
      console.error("  ✗ per-row event fanout was NOT suppressed above the cap");
    }

    // The heaviest realistic path: N bulk UPDATEs.
    const upsertRun = await timed("import CSV (create_and_update, all updates)", () =>
      importAllParts("load-imp-upsert", "create_and_update", false),
    );
    console.log(
      `  processed=${upsertRun.processedRows} updated=${upsertRun.updated} failed=${upsertRun.failed}`,
    );
    if (upsertRun.updated !== ROWS) {
      failures += 1;
      console.error(`  ✗ updated ${upsertRun.updated}, expected ${ROWS}`);
    }

    // Round-trip integrity at scale: the data must be intact, not just fast.
    // Sample the middle row so the check works at any ROWS.
    const sampleRow = Math.floor(ROWS / 2);
    const sample = await db.contact.findFirst({
      where: { workspaceId, phoneNumber: `1555${String(sampleRow).padStart(7, "0")}` },
      select: { name: true, email: true, customFields: true },
    });
    if (sample?.name !== `Contact ${sampleRow}`) {
      failures += 1;
      console.error("  ✗ round-trip corrupted a sampled row", sample);
    } else {
      console.log("\n  ✓ sampled row survived export → import intact");
    }

    await blobStorage
      .delete([
        csv.artifactKey,
        xlsx.artifactKey,
        ...sourceParts.filter((k) => k !== csv.artifactKey),
      ])
      .catch(() => {});
  } finally {
    if (KEEP) {
      console.log(`\n--keep: workspace ${workspaceId} (org ${organizationId}) left in place`);
    } else {
      // Contacts cascade with the team; 100k deletes in one statement is fine.
      await db.workspace.delete({ where: { id: workspaceId } }).catch((e) => console.error("cleanup", e));
      await db.organization
        .delete({ where: { id: organizationId } })
        .catch((e) => console.error("cleanup org", e));
    }
  }

  console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
  if (failures > 0) process.exitCode = 1;
}

/**
 * Seed N contacts with createMany in chunks.
 *
 * NOT part of the measurement — but it has to fit in the same heap budget as
 * the thing being measured, or the harness OOMs in its own fixture and tells
 * you nothing about the subsystem (which is exactly what a 5,000-row chunk
 * did here). 1,000 keeps the fixture well under the runners' own footprint.
 */
async function seed(workspaceId: string, n: number): Promise<void> {
  const CHUNK = 1_000;
  const t0 = Date.now();
  for (let i = 0; i < n; i += CHUNK) {
    const rows = [];
    for (let j = i; j < Math.min(i + CHUNK, n); j++) {
      rows.push({
        workspaceId,
        identityChannel: "whatsapp" as const,
        // Deterministic, valid E.164-able US numbers.
        phoneNumber: `1555${String(j).padStart(7, "0")}`,
        name: `Contact ${j}`,
        email: `contact${j}@example.com`,
        location: "Beirut",
        customFields: { company: `Co ${j % 500}` },
      });
    }
    await db.contact.createMany({ data: rows, skipDuplicates: true });
    process.stdout.write(`\rseeding ${Math.min(i + CHUNK, n).toLocaleString()}/${n.toLocaleString()}`);
  }
  console.log(`\rseeded ${n.toLocaleString()} contacts in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect().catch(() => {});
    process.exit(process.exitCode ?? 0);
  });
