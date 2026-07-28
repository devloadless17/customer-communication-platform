import { localProvider } from "./local";
import { r2Provider } from "./r2";
import type { BlobStorageProvider } from "./types";

/**
 * Active blob storage provider. Cloudflare R2 (private bucket, presigned
 * serving) is the production impl. When we add another (S3, Supabase), this is
 * the only place the wiring changes — every call site already talks to
 * BlobStorageProvider.
 *
 * Mirrors how lib/providers/ keeps a single MetaProvider behind a
 * MessagingProvider interface (CLAUDE.md rule #1).
 *
 * `BLOB_STORAGE_DRIVER=local` swaps in the filesystem impl (local.ts) so CI and
 * offline dev can exercise the media paths for real. It is an EXPLICIT opt-in,
 * never a fallback for missing R2 env: a storage backend that silently degrades
 * to somewhere else is how writes go missing without anyone noticing, and an
 * absent R2 credential must keep failing loudly at first use. Production is
 * refused below regardless of what the env says.
 *
 * Lives in its own module rather than in index.ts so `avatar.ts` — which index
 * imports — can reach the provider without a circular import.
 */
function selectProvider(): BlobStorageProvider {
  if ((process.env.BLOB_STORAGE_DRIVER ?? "").toLowerCase() !== "local") {
    return r2Provider;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "BLOB_STORAGE_DRIVER=local is a test/dev backend and is refused in production — unset it (R2 is the only production blob store).",
    );
  }
  console.warn(
    JSON.stringify({
      event: "blob.local_driver",
      severity: "warn",
      message:
        "blob storage is the LOCAL filesystem driver (BLOB_STORAGE_DRIVER=local) — objects are not durable",
    }),
  );
  return localProvider;
}

export const blobStorage: BlobStorageProvider = selectProvider();
