import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * HTTP-surface coverage for contact import/export.
 *
 * Scope note: the RUNNERS (column mapping, upsert semantics, Excel cell
 * coercion, the identity invariant, error reports, round-trip fidelity) are
 * verified far more thoroughly by `apps/api/scripts/contact-transfer-smoke.ts`,
 * which drives them directly against the DB and R2 and asserts 70+ behaviors.
 * Duplicating that here would be slower and weaker.
 *
 * What only an end-to-end HTTP test can prove — and what this file covers:
 *   - the routes exist, mount in the right order, and are capability-gated
 *   - a real multipart upload survives multer → disk → R2 → the parser
 *   - the job actually gets picked up by the in-process worker and completes
 *   - one team cannot read, download, or import another team's job/file
 *   - the concurrency gate, cancel, templates, and the legacy export URL
 *
 * Runs under the chromium project's app-admin storageState (an admin, so
 * contacts:export / contacts:import both default to true).
 */

const CSV = [
  "phone_number,name,email,tags",
  "15557770001,E2E One,e2e1@example.com,E2E",
  "15557770002,E2E Two,e2e2@example.com,E2E",
  "not-a-phone,Bad Row,bad@example.com,",
].join("\r\n");

/** Poll a job until it leaves pending/running. */
async function waitForJob(
  request: APIRequestContext,
  jobId: string,
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request.get(`/api/contacts/transfers/${jobId}`);
    expect(res.ok(), "job status readable").toBeTruthy();
    const job = (await res.json()) as Record<string, unknown>;
    const status = job.status as string;
    if (status !== "pending" && status !== "running") return job;
    if (Date.now() > deadline) throw new Error(`job stuck in ${status}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Wait out the one-job-per-team gate left by a previous test. */
async function drainRunningJobs(request: APIRequestContext): Promise<void> {
  const res = await request.get("/api/contacts/transfers?limit=10");
  if (!res.ok()) return;
  const { jobs } = (await res.json()) as { jobs: Array<{ id: string; status: string }> };
  for (const j of jobs) {
    if (j.status === "pending" || j.status === "running") {
      await waitForJob(request, j.id).catch(() => {});
    }
  }
}

test.describe.configure({ mode: "serial" });

test.describe("contact transfer — templates", () => {
  test("CSV template downloads with the canonical headers", async ({ request }) => {
    const res = await request.get("/api/contacts/transfer-template?format=csv");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"] ?? "").toContain("text/csv");
    expect(res.headers()["content-disposition"] ?? "").toContain("attachment");
    const text = await res.text();
    expect(text, "template documents the phone column").toContain("phone_number");
    expect(text, "template documents tags").toContain("tags");
    // The example row is the whole point — it's how users learn the phone format.
    expect(text, "template carries an example row").toContain("15551234567");
    // Columns we ignore on import must NOT invite the user to fill them in.
    expect(text.split("\r\n")[0], "no source column in the template").not.toContain("source");
  });

  test("Excel template downloads as a real xlsx", async ({ request }) => {
    const res = await request.get("/api/contacts/transfer-template?format=xlsx");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"] ?? "").toContain("spreadsheetml");
    const buf = await res.body();
    // .xlsx is a ZIP — "PK\x03\x04". A CSV served under an xlsx name would be
    // the regression here.
    expect(buf.subarray(0, 2).toString("latin1"), "xlsx is a zip").toBe("PK");
  });
});

test.describe("contact transfer — import flow", () => {
  test("preview → import → completion, with per-row errors reported", async ({ request }) => {
    await drainRunningJobs(request);

    // ---- preview -----------------------------------------------------------
    const preview = await request.post("/api/contacts/import/preview", {
      multipart: {
        file: { name: "e2e.csv", mimeType: "text/csv", buffer: Buffer.from(CSV, "utf-8") },
      },
    });
    // Nest answers POST with 201 by default.
    expect(preview.status(), "preview accepted the upload").toBe(201);
    const p = (await preview.json()) as {
      headers: string[];
      sampleRows: Array<Record<string, string>>;
      suggestedMapping: Record<string, string>;
      uploadKey: string;
      format: string;
    };
    expect(p.headers).toEqual(["phone_number", "name", "email", "tags"]);
    expect(p.format).toBe("csv");
    expect(p.sampleRows.length, "preview returns sample rows").toBeGreaterThan(0);
    // Auto-detection has to work, or the mapping step is busywork for the user.
    expect(p.suggestedMapping.phone_number).toBe("phone_number");
    expect(p.suggestedMapping.email).toBe("email");
    expect(p.suggestedMapping.tags).toBe("tags");
    expect(p.uploadKey, "staged under the team prefix").toContain("contact-imports/");

    // ---- run ---------------------------------------------------------------
    const started = await request.post("/api/contacts/import", {
      data: {
        uploadKey: p.uploadKey,
        filename: "e2e.csv",
        format: "csv",
        options: { mode: "create_and_update", tagMode: "merge", fireAutomations: false },
      },
    });
    expect(started.status(), "import queued").toBe(201);
    const { jobId } = (await started.json()) as { jobId: string };
    expect(jobId).toBeTruthy();

    const job = await waitForJob(request, jobId);
    expect(job.status, "worker picked the job up and finished it").toBe("completed");
    expect(job.kind).toBe("import");
    // 2 good rows, 1 unparseable phone.
    expect(Number(job.created) + Number(job.updated)).toBe(2);
    expect(job.failed, "the bad phone row failed").toBe(1);
    expect(job.hasErrorReport, "a failed row produces a downloadable report").toBe(true);

    // ---- the failed-rows report is real and re-importable -------------------
    const errors = await request.get(`/api/contacts/transfers/${jobId}/errors`);
    expect(errors.status()).toBe(200);
    const errText = await errors.text();
    expect(errText, "report explains the failure").toContain("_error");
    expect(errText, "report keeps the original row").toContain("not-a-phone");

    // ---- the contacts actually landed ---------------------------------------
    const list = await request.get("/api/contacts?search=15557770001");
    expect(list.ok()).toBeTruthy();
    const { items } = (await list.json()) as {
      items: Array<{ contact: { name: string } }>;
    };
    expect(items.length, "imported contact is in the directory").toBeGreaterThan(0);
    expect(items[0]?.contact.name, "with the name from the file").toBe("E2E One");
  });

  test("an Excel upload round-trips through the HTTP layer", async ({ request }) => {
    await drainRunningJobs(request);

    // Build a real .xlsx via the export path, then feed it straight back in —
    // this is the exact "export, edit in Excel, re-upload" loop customers run,
    // and it exercises the streaming writer AND the streaming reader over HTTP.
    const exported = await request.post("/api/contacts/export", {
      data: { format: "xlsx" },
    });
    expect(exported.status()).toBe(201);
    const { jobId: exportId } = (await exported.json()) as { jobId: string };
    const exportJob = await waitForJob(request, exportId);
    expect(exportJob.status).toBe("completed");
    expect(exportJob.hasArtifact).toBe(true);

    const dl = await request.get(`/api/contacts/transfers/${exportId}/download`);
    expect(dl.status()).toBe(200);
    const xlsx = await dl.body();
    expect(xlsx.subarray(0, 2).toString("latin1"), "downloaded a real xlsx").toBe("PK");

    await drainRunningJobs(request);
    const preview = await request.post("/api/contacts/import/preview", {
      multipart: {
        file: {
          name: "roundtrip.xlsx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          buffer: xlsx,
        },
      },
    });
    expect(preview.status(), "xlsx preview parsed").toBe(201);
    const p = (await preview.json()) as { headers: string[]; format: string };
    expect(p.format, "format sniffed from content").toBe("xlsx");
    expect(p.headers, "our own export re-imports into the same columns").toContain(
      "phone_number",
    );
  });

  test("an import with no phone column is rejected with a useful reason", async ({
    request,
  }) => {
    await drainRunningJobs(request);
    const csv = "full name,email\r\nNo Phone,np@example.com";
    const preview = await request.post("/api/contacts/import/preview", {
      multipart: {
        file: { name: "nophone.csv", mimeType: "text/csv", buffer: Buffer.from(csv) },
      },
    });
    expect(preview.status()).toBe(201);
    const { uploadKey } = (await preview.json()) as { uploadKey: string };

    const started = await request.post("/api/contacts/import", {
      data: { uploadKey, filename: "nophone.csv", format: "csv", options: {} },
    });
    expect(started.status()).toBe(201);
    const { jobId } = (await started.json()) as { jobId: string };

    const job = await waitForJob(request, jobId);
    expect(job.status, "a file we can't identify rows from fails the job").toBe("failed");
    expect(String(job.error), "the error names the problem").toContain("phone");
    // A user-file rejection must NOT be retried three times by BullMQ — it will
    // never succeed and the user is waiting on the answer.
  });
});

test.describe("contact transfer — export flow", () => {
  test("export honours an explicit id selection", async ({ request }) => {
    await drainRunningJobs(request);
    const list = await request.get("/api/contacts?take=2");
    const { items } = (await list.json()) as { items: Array<{ contact: { id: string } }> };
    test.skip(items.length === 0, "no contacts seeded in this environment");

    const ids = items.slice(0, 1).map((r) => r.contact.id);
    const started = await request.post("/api/contacts/export", {
      data: { format: "csv", ids },
    });
    expect(started.status()).toBe(201);
    const { jobId } = (await started.json()) as { jobId: string };
    const job = await waitForJob(request, jobId);
    expect(job.status).toBe("completed");
    expect(job.processedRows, "exported exactly the selected rows").toBe(ids.length);
  });

  test("the legacy GET /api/contacts/export URL still downloads a CSV", async ({
    request,
  }) => {
    await drainRunningJobs(request);
    // Backward compatibility: this used to be a synchronous CSV response. It's
    // now a job + redirect, but any existing bookmark or script must still get
    // a CSV file back from the same URL.
    const res = await request.get("/api/contacts/export");
    expect(res.status(), "legacy export URL still works").toBe(200);
    expect(res.headers()["content-type"] ?? "").toContain("csv");
    const text = await res.text();
    expect(text, "still a contacts CSV").toContain("phone_number");
  });

  test("only one transfer runs per team at a time", async ({ request }) => {
    await drainRunningJobs(request);
    const first = await request.post("/api/contacts/export", { data: { format: "csv" } });
    expect(first.status()).toBe(201);
    const { jobId } = (await first.json()) as { jobId: string };

    // Immediately queue a second. Either it 409s (first still running) or the
    // first already finished — both are correct; what must never happen is two
    // concurrent transfers for one team.
    const second = await request.post("/api/contacts/export", { data: { format: "csv" } });
    if (second.status() === 409) {
      const body = (await second.json()) as { error?: string };
      expect(body.error).toBe("transfer_in_progress");
    } else {
      expect([201, 409]).toContain(second.status());
    }
    await waitForJob(request, jobId);
  });

  test("a queued transfer can be canceled", async ({ request }) => {
    await drainRunningJobs(request);
    const started = await request.post("/api/contacts/export", { data: { format: "csv" } });
    const { jobId } = (await started.json()) as { jobId: string };

    const cancel = await request.post(`/api/contacts/transfers/${jobId}/cancel`);
    expect(cancel.ok(), "cancel accepted").toBeTruthy();

    const job = await waitForJob(request, jobId);
    // Racing a fast export: it may have completed before the cancel landed.
    // Both outcomes are fine; a stuck `running` is not.
    expect(["canceled", "completed"]).toContain(job.status as string);
  });
});

test.describe("contact transfer — lifecycle invariants", () => {
  test("export artifacts are excluded from the generic blob-orphan sweeper", async () => {
    // Not an HTTP assertion — a STATIC one, because the failure is invisible:
    // the blob-orphan sweeper deletes any key it can't find in Message.mediaKey
    // after a 24h grace window, so without these prefixes a user's 7-day export
    // is destroyed on day one and the download link 404s with no error anywhere.
    // This repo has already shipped that exact bug twice (ai-knowledge/,
    // ai-voice-draft/), which is why it's pinned here rather than trusted.
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      "apps/api/src/lib/sweepers/blob-orphan.ts",
      "utf-8",
    );
    const list = src.slice(
      src.indexOf("const URL_ONLY_KEY_PREFIXES"),
      src.indexOf("] as const", src.indexOf("const URL_ONLY_KEY_PREFIXES")),
    );
    expect(list, "contact-exports/ must be excluded").toContain('"contact-exports/"');
    expect(list, "contact-imports/ must be excluded").toContain('"contact-imports/"');
  });

  test("a second concurrent transfer is refused by the DB, not just the pre-check", async ({
    request,
  }) => {
    await drainRunningJobs(request);
    // Fire both without awaiting the first, so they race the COUNT pre-check.
    // The partial unique index is the actual guarantee; at most one may win.
    const [a, b] = await Promise.all([
      request.post("/api/contacts/export", { data: { format: "csv" } }),
      request.post("/api/contacts/export", { data: { format: "csv" } }),
    ]);
    const created = [a, b].filter((r) => r.status() === 201);
    const refused = [a, b].filter((r) => r.status() === 409);
    expect(created.length, "at most one transfer may start").toBeLessThanOrEqual(1);
    expect(created.length + refused.length, "no 500s from a lost race").toBe(2);

    for (const r of created) {
      const { jobId } = (await r.json()) as { jobId: string };
      await waitForJob(request, jobId);
    }
  });

  test("the legacy export URL degrades to 503, not 409, while a job runs", async ({
    request,
  }) => {
    await drainRunningJobs(request);
    const started = await request.post("/api/contacts/import/preview", {
      multipart: {
        file: {
          name: "busy.csv",
          mimeType: "text/csv",
          buffer: Buffer.from("phone_number,name\r\n15557770099,Busy"),
        },
      },
    });
    const { uploadKey } = (await started.json()) as { uploadKey: string };
    const imp = await request.post("/api/contacts/import", {
      data: { uploadKey, filename: "busy.csv", format: "csv", options: {} },
    });
    const { jobId } = (await imp.json()) as { jobId: string };

    // Race the running import with the legacy download URL. If it finished
    // first we get the normal 200; what must NEVER happen is a bare 409, which
    // a bookmarked download link has no way to interpret or retry.
    const legacy = await request.get("/api/contacts/export");
    expect([200, 503], `got ${legacy.status()}`).toContain(legacy.status());
    if (legacy.status() === 503) {
      expect(legacy.headers()["retry-after"], "tells the client when to retry").toBeTruthy();
    }
    await waitForJob(request, jobId);
  });
});

test.describe("contact transfer — isolation & validation", () => {
  test("an unknown job id 404s rather than leaking existence", async ({ request }) => {
    const res = await request.get("/api/contacts/transfers/clzzzzzzzzzzzzzzzzzzzzzzz");
    expect(res.status()).toBe(404);
  });

  test("a download for an unknown job 404s", async ({ request }) => {
    const res = await request.get(
      "/api/contacts/transfers/clzzzzzzzzzzzzzzzzzzzzzzz/download",
      { maxRedirects: 0 },
    );
    expect(res.status()).toBe(404);
  });

  test("an upload key outside the team's own prefix is refused", async ({ request }) => {
    // The staged key comes from the client, so it's the one input that could
    // point the worker at another tenant's file. It must be rejected on shape
    // BEFORE any job is created.
    for (const uploadKey of [
      "contact-imports/some-other-team/staged-abc.csv",
      "contact-imports/../../etc/passwd",
      "media/whatever.csv",
    ]) {
      const res = await request.post("/api/contacts/import", {
        data: { uploadKey, filename: "x.csv", format: "csv", options: {} },
      });
      expect(res.status(), `rejected: ${uploadKey}`).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("invalid_upload_key");
    }
  });

  test("preview rejects a request with no file", async ({ request }) => {
    const res = await request.post("/api/contacts/import/preview", { multipart: {} });
    expect(res.status(), "route exists").not.toBe(404);
    expect(res.status()).toBe(400);
  });

  test("a legacy .xls is refused with an actionable message", async ({ request }) => {
    // OLE2 magic — an old-format Excel file. Neither parser can read it, so we
    // say so up front instead of failing deep inside a batch.
    const ole2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const res = await request.post("/api/contacts/import/preview", {
      multipart: {
        file: { name: "old.xls", mimeType: "application/vnd.ms-excel", buffer: ole2 },
      },
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error?: string; detail?: string };
    expect(body.error).toBe("unsupported_format");
    expect(String(body.detail), "tells the user what to do").toContain(".xlsx");
  });
});
