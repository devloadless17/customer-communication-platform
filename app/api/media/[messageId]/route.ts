import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { readMedia } from "@/lib/media-storage";

/**
 * Authenticated media stream. Two reasons we don't serve from /public:
 *   1) Stops anyone with a guessed message id from downloading another team's
 *      attachments — same-team check before we open the file.
 *   2) Media files live outside the Next bundle so they survive deploys.
 *
 * `inline` disposition for previewable types (image/video/audio) so the
 * browser renders inline; `attachment` for documents so they download with
 * the original filename.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ messageId: string }> },
) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  const { messageId } = await ctx.params;

  const message = await db.message.findFirst({
    where: { id: messageId, teamId: session.teamId },
    select: {
      mediaPath: true,
      mediaMimeType: true,
      mediaFilename: true,
      mediaKind: true,
    },
  });
  if (!message?.mediaPath || !message.mediaMimeType) {
    return new NextResponse("not found", { status: 404 });
  }

  let bytes: Buffer;
  try {
    bytes = await readMedia(message.mediaPath);
  } catch (err) {
    console.error(`[api/media] read failed for ${messageId}`, err);
    return new NextResponse("media unavailable", { status: 410 });
  }

  const filename = message.mediaFilename ?? `media-${messageId}`;
  const disposition =
    message.mediaKind === "document"
      ? `attachment; filename="${sanitizeFilename(filename)}"`
      : `inline; filename="${sanitizeFilename(filename)}"`;

  // Copy into a fresh ArrayBuffer — NextResponse's BodyInit type rejects
  // Buffer / Uint8Array<ArrayBufferLike> on some Node+Next combos. Bytes are
  // small relative to a typical request lifecycle, so the extra alloc is fine.
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);

  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": message.mediaMimeType,
      "content-length": String(body.byteLength),
      "content-disposition": disposition,
      // Media is immutable per messageId — let the browser cache aggressively.
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}

function sanitizeFilename(name: string): string {
  // Drop quotes + control chars; clip to 200 chars.
  return name.replace(/["\r\n]/g, "_").slice(0, 200);
}
