/**
 * Avatar storage — the user/contact picture path, which reaches blob storage
 * through `BlobStorageProvider` like everything else (it used to hold a raw
 * S3 client, which is why it was the one media path a non-R2 driver couldn't
 * serve).
 *
 * What's pinned here:
 *   - the mime allowlist. SVG is excluded because an avatar is served back to
 *     a browser and an SVG is a script document; GIF is excluded on product
 *     grounds. Neither exclusion had a test.
 *   - the size + empty guards, and that each rejection carries its own code
 *     (the web surfaces them as distinct messages).
 *   - the DETERMINISTIC key: a replace overwrites in place, so there is never
 *     an orphan to GC and the serve route can presign knowing only the id.
 *   - delete is idempotent, and a contact capture rejects a non-image response
 *     rather than storing whatever the CDN returned.
 *
 * Runs against the filesystem driver whatever the environment's R2 config is,
 * so it behaves identically here and in CI — and never writes to a real bucket.
 *
 *   pnpm --filter @ccp/api exec vitest run test/avatar-blob.spec.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const ROOT = mkdtempSync(path.join(tmpdir(), "ccp-avatar-spec-"));
process.env.BLOB_LOCAL_DIR = ROOT;

// The active provider is env-selected at import time; pin it to the filesystem
// driver so this spec never depends on (or writes to) a real bucket.
vi.mock("@/lib/blob-storage/provider", async () => {
  const { localProvider } = await import("@/lib/blob-storage/local");
  return { blobStorage: localProvider };
});

const { localProvider } = await import("@/lib/blob-storage/local");
const {
  AvatarUploadError,
  avatarObjectKey,
  captureRemoteContactAvatar,
  contactAvatarObjectKey,
  deleteAvatar,
  uploadAvatar,
} = await import("@/lib/blob-storage/avatar");

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A real 1x1 PNG — the avatar path trusts the declared mime, but using
 *  genuine bytes keeps the fixture honest if a sniff is ever added. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("avatar storage", () => {
  it("stores a PNG under the deterministic key and reads it back", async () => {
    const userId = "user_avatar_spec";
    const res = await uploadAvatar({ userId, bytes: PNG, mimeType: "image/png" });
    expect(res.key).toBe(avatarObjectKey(userId));
    expect(res.sizeBytes).toBe(PNG.length);

    const stored = await localProvider.fetch(res.key);
    expect(Buffer.from(stored.bytes).equals(PNG)).toBe(true);
    expect(stored.mimeType).toBe("image/png");

    // Replace overwrites in place — same key, new bytes, nothing orphaned.
    const replacement = Buffer.concat([PNG, Buffer.from([0])]);
    const again = await uploadAvatar({
      userId,
      bytes: replacement,
      mimeType: "image/png",
    });
    expect(again.key).toBe(res.key);
    expect(
      Buffer.from((await localProvider.fetch(res.key)).bytes).equals(replacement),
    ).toBe(true);

    await deleteAvatar(userId);
    await expect(localProvider.fetch(res.key)).rejects.toThrow();
    // Deleting what isn't there must not throw — a cleared avatar is a normal
    // profile update, not a failure.
    await expect(deleteAvatar(userId)).resolves.toBeUndefined();
  });

  it("refuses SVG, GIF, and anything else off the allowlist", async () => {
    for (const mimeType of ["image/svg+xml", "image/gif", "application/pdf", "text/html"]) {
      await expect(
        uploadAvatar({ userId: "user_reject", bytes: PNG, mimeType }),
      ).rejects.toMatchObject({ code: "unsupported_mime" });
    }
    // A charset/parameter suffix must not smuggle a type past the allowlist.
    expect(
      await uploadAvatar({
        userId: "user_param",
        bytes: PNG,
        mimeType: "image/png; charset=binary",
      }),
    ).toMatchObject({ key: avatarObjectKey("user_param") });
    await deleteAvatar("user_param");
  });

  it("refuses an empty file and one over the 2 MiB cap", async () => {
    await expect(
      uploadAvatar({ userId: "u", bytes: new Uint8Array(0), mimeType: "image/png" }),
    ).rejects.toMatchObject({ code: "empty_file" });

    const tooBig = Buffer.alloc(2 * 1024 * 1024 + 1);
    await expect(
      uploadAvatar({ userId: "u", bytes: tooBig, mimeType: "image/png" }),
    ).rejects.toMatchObject({ code: "too_large" });

    // Exactly at the cap is allowed (the guard is `>`), so the boundary can't
    // silently drift into rejecting a legal file.
    const exact = Buffer.alloc(2 * 1024 * 1024);
    PNG.copy(exact);
    await expect(
      uploadAvatar({ userId: "u_edge", bytes: exact, mimeType: "image/png" }),
    ).resolves.toMatchObject({ sizeBytes: 2 * 1024 * 1024 });
    await deleteAvatar("u_edge");

    expect(new AvatarUploadError("too_large", "x")).toBeInstanceOf(Error);
  });

  it("captures a remote contact picture, and declines a non-image response", async () => {
    const contactId = "contact_capture_spec";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(PNG, {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      ),
    );
    const stored = await captureRemoteContactAvatar(
      contactId,
      "https://cdn.example.com/pic.jpg",
    );
    // Same-origin serving path with a content-hash cache buster — never the
    // provider's short-lived CDN url.
    expect(stored).toMatch(new RegExp(`^/api/contacts/${contactId}/avatar\\?v=[0-9a-f]{16}$`));
    expect(
      Buffer.from((await localProvider.fetch(contactAvatarObjectKey(contactId))).bytes).equals(
        PNG,
      ),
    ).toBe(true);

    // Unchanged bytes → same path, and the caller can skip the DB write.
    expect(
      await captureRemoteContactAvatar(contactId, "https://cdn.example.com/pic.jpg", stored),
    ).toBe(stored);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("<html>not an image</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    expect(
      await captureRemoteContactAvatar("contact_html", "https://cdn.example.com/x"),
    ).toBeNull();

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    expect(
      await captureRemoteContactAvatar("contact_404", "https://cdn.example.com/x"),
    ).toBeNull();

    await localProvider.delete(contactAvatarObjectKey(contactId));
  });
});
