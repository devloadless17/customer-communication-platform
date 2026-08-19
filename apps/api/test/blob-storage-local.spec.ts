/**
 * The local (filesystem) blob driver — the backend CI runs on, so its contract
 * has to hold as tightly as R2's. Every media assertion in the CI suites
 * (`inapp-recording`, the `whatsapp-call-artifacts` e2e file) is only as
 * trustworthy as this: a driver that quietly returned the wrong bytes, ignored
 * a Range, or resolved a foreign url would make those suites green on nothing.
 *
 * Imports `localProvider` directly rather than `blobStorage`, so the file
 * tests the driver on a developer machine (where R2 is configured and the
 * active provider is r2) exactly as it does in CI.
 *
 *   pnpm --filter @ccp/api exec vitest run test/blob-storage-local.spec.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

// Must be set before the module reads it (the root is resolved once, lazily).
const ROOT = mkdtempSync(path.join(tmpdir(), "ccp-blob-spec-"));
process.env.BLOB_LOCAL_DIR = ROOT;

import { localProvider } from "@/lib/blob-storage/local";
import { BlobObjectNotFoundError } from "@/lib/blob-storage/types";

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

const KEY = "call-recordings/ws_spec/call_spec.ogg";
const BYTES = new TextEncoder().encode("OGGMOCKAUDIO_spec_0123456789");
const CONTENT_TYPE = "audio/ogg; codecs=opus";

describe("local blob driver", () => {
  it("round-trips bytes and content type through putObject/fetch", async () => {
    const put = await localProvider.putObject({
      key: KEY,
      bytes: BYTES,
      contentType: CONTENT_TYPE,
    });
    expect(put.key).toBe(KEY);
    expect(put.sizeBytes).toBe(BYTES.length);

    const byKey = await localProvider.fetch(KEY);
    expect(Buffer.from(byKey.bytes).equals(Buffer.from(BYTES))).toBe(true);
    expect(byKey.mimeType).toBe(CONTENT_TYPE);

    // The stable url is accepted as an alias for the key, like the R2 impl.
    const byUrl = await localProvider.fetch(put.url);
    expect(Buffer.from(byUrl.bytes).equals(Buffer.from(BYTES))).toBe(true);
  });

  it("stores a file body by streaming it (the export path)", async () => {
    const src = path.join(ROOT, "export-source.csv");
    const csv = "id,name\n1,alpha\n2,beta\n";
    writeFileSync(src, csv);

    const key = "contact-exports/ws_spec/export.csv";
    const put = await localProvider.putObjectFromFile({
      key,
      path: src,
      contentType: "text/csv",
    });
    expect(put.sizeBytes).toBe(Buffer.byteLength(csv));

    const back = await localProvider.fetch(key);
    expect(Buffer.from(back.bytes).toString("utf8")).toBe(csv);
    expect(back.mimeType).toBe("text/csv");
    await localProvider.delete(key);
  });

  it("streams a full object and honours Range (audio seeking)", async () => {
    const full = await localProvider.getObject(KEY);
    expect(full.statusCode).toBe(200);
    expect(full.contentLength).toBe(BYTES.length);
    expect(full.contentType).toBe(CONTENT_TYPE);
    expect((await drain(full.body)).equals(Buffer.from(BYTES))).toBe(true);

    const part = await localProvider.getObject(KEY, { range: "bytes=4-9" });
    expect(part.statusCode).toBe(206);
    expect(part.contentRange).toBe(`bytes 4-9/${BYTES.length}`);
    expect(part.contentLength).toBe(6);
    expect((await drain(part.body)).equals(Buffer.from(BYTES).subarray(4, 10))).toBe(
      true,
    );

    const openEnded = await localProvider.getObject(KEY, { range: "bytes=20-" });
    expect(openEnded.contentRange).toBe(`bytes 20-${BYTES.length - 1}/${BYTES.length}`);

    const suffix = await localProvider.getObject(KEY, { range: "bytes=-5" });
    expect(suffix.contentRange).toBe(
      `bytes ${BYTES.length - 5}-${BYTES.length - 1}/${BYTES.length}`,
    );
    expect((await drain(suffix.body)).equals(Buffer.from(BYTES).subarray(-5))).toBe(
      true,
    );

    // Unsatisfiable / malformed ranges degrade to a full 200 rather than
    // serving a wrong slice.
    const past = await localProvider.getObject(KEY, { range: "bytes=9999-" });
    expect(past.statusCode).toBe(200);
    const junk = await localProvider.getObject(KEY, { range: "pages=1-2" });
    expect(junk.statusCode).toBe(200);
  });

  it("keeps the SSRF gate: only its own https urls resolve", async () => {
    expect(localProvider.isOwnUrl("https://local-blob.invalid/local/some/key")).toBe(
      true,
    );
    expect(localProvider.isOwnUrl("http://local-blob.invalid/local/some/key")).toBe(
      false,
    );
    expect(localProvider.isOwnUrl("https://evil.example.com/local/some/key")).toBe(
      false,
    );
    expect(localProvider.isOwnUrl("not a url")).toBe(false);
    await expect(localProvider.fetch("https://evil.example.com/a")).rejects.toThrow(
      /refusing non-local-blob url/,
    );
  });

  it("recovers the key from its own url and only its own", () => {
    // The header-media tenant gate reads the workspace out of this key prefix,
    // so a null here is a closed door and a wrong key is an open one.
    const url = `https://local-blob.invalid/${process.env.R2_BUCKET || "local"}/media/ws_a/2026/07/x-image.jpg`;
    expect(localProvider.keyFromUrl(url)).toBe("media/ws_a/2026/07/x-image.jpg");
    expect(localProvider.keyFromUrl("https://evil.example.com/local/media/ws_a/x")).toBeNull();
    expect(localProvider.keyFromUrl("https://local-blob.invalid/other-bucket/media/ws_a/x")).toBeNull();
    expect(localProvider.keyFromUrl("https://local-blob.invalid/")).toBeNull();
    expect(localProvider.keyFromUrl("nonsense")).toBeNull();
  });

  it("lists by prefix and deletes idempotently", async () => {
    const listed = await localProvider.listKeys!({ limit: 100, prefix: "call-recordings/" });
    expect(listed.keys.map((k) => k.key)).toContain(KEY);

    const others = await localProvider.listKeys!({ limit: 100, prefix: "avatars/" });
    expect(others.keys.map((k) => k.key)).not.toContain(KEY);

    await localProvider.delete(KEY);
    await expect(localProvider.getObject(KEY)).rejects.toBeInstanceOf(
      BlobObjectNotFoundError,
    );
    // A missing key must never throw and counts as removed (no failed keys) —
    // same contract as R2's delete.
    await expect(localProvider.delete(KEY)).resolves.toEqual([]);
  });
});
