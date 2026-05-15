import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
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
 *
 * 302s are NOT in the HTTP default-cacheable status list — without explicit
 * Cache-Control headers, browsers refetch the redirect on every render. For
 * a thread with N images, that's N × (session lookup + DB query + 302) per
 * paint. We set `private, max-age=600` to let each user's browser cache the
 * redirect for 10 min, dropping the repeat-render cost to ~0. `private` keeps
 * shared proxies out; 10 min is short enough that a team-removal becomes
 * visible quickly, long enough to cover normal scrollback patterns.
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

  // 302 (not 301) — keeps the same path the browser knows, and gives us a
  // ceiling on cache lifetime via max-age. The Cache-Control header opts
  // browsers into caching the redirect for the bounded window above.
  const res = NextResponse.redirect(message.mediaUrl, { status: 302 });
  res.headers.set("Cache-Control", "private, max-age=600");
  return res;
}
