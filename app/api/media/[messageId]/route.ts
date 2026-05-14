import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth-helpers";
import { blobStorage } from "@/lib/blob-storage";
import { db } from "@/lib/db";

/**
 * Authenticated redirect to the blob provider's CDN URL. Two reasons we don't
 * hand the CDN URL straight to the browser:
 *   1) Stops anyone with a guessed message id from downloading another team's
 *      attachments — same-team check before we leak the URL.
 *   2) Keeps the public-facing URL stable (`/api/media/<messageId>`) while
 *      the underlying provider can swap. Today UploadThing, tomorrow maybe S3.
 *
 * Performance: a 302 lets the browser cache the resolved CDN URL directly,
 * so subsequent views hit UploadThing's CDN — not our app server. No bytes
 * flow through our process. Disposition + filename are advisory; browsers
 * read the Content-Disposition the CDN returns, not ours.
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
      mediaUrl: true,
      mediaKind: true,
    },
  });
  if (!message?.mediaUrl) {
    return new NextResponse("not found", { status: 404 });
  }
  // Open-redirect guard. mediaUrl is server-written from the provider's CDN
  // response today, but the row sits next to user-influenced columns; a
  // future ingest bug or admin-import path that puts an attacker URL here
  // would turn this authenticated route into a phishing redirect on our
  // origin. Refuse anything outside the active blob provider's hosts.
  if (!blobStorage.isOwnUrl(message.mediaUrl)) {
    return new NextResponse("not found", { status: 404 });
  }

  // 302 (not 301) — the browser refetches the team check on every page load.
  // Caching the redirect itself would silently break access revocation.
  return NextResponse.redirect(message.mediaUrl, { status: 302 });
}
