import "server-only";

import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { hashToken, looksLikeApiKey } from "@/lib/auth/api-key";

/**
 * Bearer-token auth for /api/external/v1.
 *
 * Pattern mirrors lib/auth/helpers.ts: callers do
 *
 *   const auth = await authenticateApiKey(req);
 *   if (auth instanceof NextResponse) return auth;
 *
 * On success, returns `{ teamId, apiKeyId }`. `lastUsedAt` is bumped lazily
 * (best-effort, fire-and-forget) to avoid blocking the hot path on a DB
 * write that doesn't affect the response.
 */

export interface ExternalAuth {
  teamId: string;
  apiKeyId: string;
}

export async function authenticateApiKey(
  req: Request,
): Promise<ExternalAuth | NextResponse> {
  const header = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    return jsonError(401, "missing bearer token");
  }
  const token = header.slice(7).trim();
  if (!looksLikeApiKey(token)) {
    // Don't reveal whether the shape was wrong vs. the key was wrong — both
    // map to the same error.
    return jsonError(401, "invalid api key");
  }
  const tokenHash = hashToken(token);
  const row = await db.teamApiKey.findUnique({
    where: { tokenHash },
    select: { id: true, teamId: true, revokedAt: true },
  });
  if (!row || row.revokedAt) {
    return jsonError(401, "invalid api key");
  }

  // Bump lastUsedAt without blocking. We don't care if it fails — this is
  // diagnostic-only data, not a security boundary.
  void db.teamApiKey
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return { teamId: row.teamId, apiKeyId: row.id };
}

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json(
    { error: message },
    { status, headers: { "WWW-Authenticate": 'Bearer realm="external"' } },
  );
}
