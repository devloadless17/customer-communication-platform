import "server-only";

import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { generateApiKey } from "@/lib/api-key";

/**
 * Team API key management.
 *
 *   GET  → list (never returns plaintext — only prefix)
 *   POST → create. Body: `{ name: string }`. Returns plaintext token ONCE.
 *
 * Admin-only — these keys grant access to /api/external/v1, which can send
 * WhatsApp messages on behalf of the team. Issuing should match the same
 * trust level as inviting an admin.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;

  const keys = await db.teamApiKey.findMany({
    where: { teamId: session.teamId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      tokenPrefix: true,
      createdAt: true,
      lastUsedAt: true,
      revokedAt: true,
    },
  });
  return NextResponse.json({
    keys: keys.map((k) => ({
      id: k.id,
      name: k.name,
      tokenPrefix: k.tokenPrefix,
      createdAt: k.createdAt.toISOString(),
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      revokedAt: k.revokedAt?.toISOString() ?? null,
    })),
  });
}

interface CreateBody {
  name?: unknown;
}

export async function POST(req: Request) {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }
  if (name.length > 80) {
    return NextResponse.json({ error: "name too long (max 80)" }, { status: 400 });
  }

  const generated = generateApiKey();
  const row = await db.teamApiKey.create({
    data: {
      teamId: session.teamId,
      name,
      tokenHash: generated.tokenHash,
      tokenPrefix: generated.tokenPrefix,
      createdById: session.userId,
    },
    select: { id: true, name: true, tokenPrefix: true, createdAt: true },
  });

  // The ONLY response that contains the plaintext. The client copies it now
  // or has to rotate.
  return NextResponse.json({
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    createdAt: row.createdAt.toISOString(),
    token: generated.token,
  });
}
