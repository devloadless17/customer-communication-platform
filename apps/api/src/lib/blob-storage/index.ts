import "server-only";

import { uploadthingProvider } from "./uploadthing";
import type { BlobStorageProvider } from "./types";

/**
 * Active blob storage provider. Today UploadThing is the only impl, so the
 * switch is hard-coded. When we add S3 / R2 / Supabase, this is the only place
 * the wiring changes — every call site already talks to BlobStorageProvider.
 *
 * Mirrors how lib/providers/ keeps a single MetaProvider behind a
 * MessagingProvider interface (CLAUDE.md rule #1).
 */
export const blobStorage: BlobStorageProvider = uploadthingProvider;

export type { BlobStorageProvider, UploadInput, UploadResult, MediaNameContext } from "./types";
