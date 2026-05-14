import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { getMetaProvider } from "@/lib/providers";
import { getMetaSendConfig, ProviderNotConfiguredError } from "@/lib/providers/config";
import {
  MetaSendError,
  MissingAppIdError,
} from "@/lib/providers/meta";

/**
 * Resumable upload for a template's media header.
 *
 * Accepts multipart/form-data with one `file` part. The browser POSTs the
 * file here; we forward to Meta's app-scoped resumable upload and return the
 * opaque `header_handle` for the form to embed in the eventual create call.
 *
 * Why a server-side hop instead of direct browser → Meta:
 *   - The access token belongs to the team's Meta app — we never want it
 *     touching client code.
 *   - The two-leg resumable flow needs the `OAuth <token>` header on leg 2,
 *     which is awkward and surprising; centralizing here keeps it in one
 *     place behind a normal-looking endpoint.
 *
 * Size limit: 16 MB. Larger files won't fit through Meta's session anyway
 * (the resumable upload supports chunking but we don't bother in v1 — header
 * media tops out under 10 MB in practice).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 16 * 1024 * 1024;

const ALLOWED_MIME = new Set<string>([
  // images
  "image/jpeg",
  "image/png",
  // videos
  "video/mp4",
  "video/3gpp",
  // documents
  "application/pdf",
]);

export async function POST(req: Request) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { teamId } = session;

  // Step 0: multipart parse.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "invalid multipart" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "file part missing" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      {
        error: "file too large",
        detail: `Header media must be under ${Math.floor(MAX_BYTES / 1024 / 1024)} MB.`,
      },
      { status: 413 },
    );
  }
  const mimeType = file.type || "application/octet-stream";
  if (!ALLOWED_MIME.has(mimeType)) {
    return NextResponse.json(
      {
        error: "unsupported media type",
        detail: `Got ${mimeType}. Supported: ${Array.from(ALLOWED_MIME).join(", ")}.`,
      },
      { status: 415 },
    );
  }
  const filename =
    form.get("filename") instanceof File
      ? (form.get("filename") as File).name
      : typeof form.get("filename") === "string"
        ? (form.get("filename") as string)
        : file instanceof File
          ? file.name
          : "upload";

  // Step 1: provider config.
  let config;
  try {
    config = await getMetaSendConfig(teamId);
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      return NextResponse.json(
        { error: "whatsapp not connected", detail: err.message },
        { status: 409 },
      );
    }
    throw err;
  }

  const provider = getMetaProvider();
  if (!provider.uploadHeaderMedia) {
    return NextResponse.json(
      { error: "provider does not support template media uploads" },
      { status: 501 },
    );
  }

  // Step 2: forward to Meta.
  const ab = await file.arrayBuffer();
  const bytes = new Uint8Array(ab);
  try {
    const result = await provider.uploadHeaderMedia(
      { bytes, mimeType, filename },
      config,
    );
    return NextResponse.json({ ok: true, headerHandle: result.headerHandle });
  } catch (err) {
    if (err instanceof MissingAppIdError) {
      return NextResponse.json(
        {
          error: "app id missing",
          detail:
            "Add your Meta App ID in Settings → WhatsApp before uploading template media.",
        },
        { status: 409 },
      );
    }
    if (err instanceof MetaSendError) {
      return NextResponse.json(
        { error: "meta rejected upload", status: err.httpStatus, detail: err.body.slice(0, 500) },
        { status: 422 },
      );
    }
    console.error("[api/templates/upload-media] failed", err);
    return NextResponse.json(
      { error: "upload failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
