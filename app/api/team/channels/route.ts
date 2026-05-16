import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { emitToTeam } from "@/lib/socket/server";
import { canCreateChannel } from "@/lib/team-chat/permissions";
import { listChannelsForUser, mapChannel } from "@/lib/team-chat/queries";
import {
  isValidChannelName,
  normalizeChannelName,
} from "@/lib/team-chat/types";

/**
 * GET  /api/team/channels                 — list channels for the sidebar
 * POST /api/team/channels  { name, description? }
 *                                          — create (admin/manager only)
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  const items = await listChannelsForUser(session.teamId, session.userId);
  return NextResponse.json({ items });
}

interface CreateBody {
  name?: unknown;
  description?: unknown;
}

export async function POST(req: Request) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  if (!canCreateChannel(session.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let raw: CreateBody;
  try {
    raw = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const nameInput = typeof raw.name === "string" ? raw.name : "";
  const description =
    typeof raw.description === "string" ? raw.description.trim().slice(0, 280) : "";
  const name = normalizeChannelName(nameInput);
  if (!isValidChannelName(name)) {
    return NextResponse.json(
      { error: "invalid_name", detail: "Channel names must be lowercase letters, digits, or dashes (1–32 chars)." },
      { status: 400 },
    );
  }

  // Race-safe: rely on the @@unique([teamId, name]) constraint instead of a
  // pre-flight findFirst. Two simultaneous creates would otherwise both pass
  // the check and one would crash with a less helpful error.
  let created;
  try {
    created = await db.teamChannel.create({
      data: {
        teamId: session.teamId,
        name,
        description: description || null,
        createdById: session.userId,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return NextResponse.json(
        { error: "name_taken", detail: "A channel with that name already exists." },
        { status: 409 },
      );
    }
    throw err;
  }

  emitToTeam(session.teamId, "team:catalog:changed", {
    teamId: session.teamId,
    scope: "team-channels",
  });

  return NextResponse.json({ channel: mapChannel(created) }, { status: 201 });
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P2002"
  );
}
