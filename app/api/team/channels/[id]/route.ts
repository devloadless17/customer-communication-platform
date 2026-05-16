import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { emitToTeam } from "@/lib/socket/server";
import {
  canDeleteChannel,
  canManageChannel,
} from "@/lib/team-chat/permissions";
import { mapChannel } from "@/lib/team-chat/queries";
import {
  DEFAULT_CHANNEL_NAME,
  isValidChannelName,
  normalizeChannelName,
} from "@/lib/team-chat/types";

/**
 * PATCH  /api/team/channels/[id]  { name?, description? }   — rename / edit
 * DELETE /api/team/channels/[id]                              — admin-only
 *
 * The default channel ("general") is hard-protected: rename refuses to
 * change its name; delete refuses entirely. Without this an admin could
 * accidentally orphan the team's landing route.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PatchBody {
  name?: unknown;
  description?: unknown;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  if (!canManageChannel(session.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;

  let raw: PatchBody;
  try {
    raw = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const existing = await db.teamChannel.findFirst({
    where: { id, teamId: session.teamId },
  });
  if (!existing) {
    return NextResponse.json({ error: "channel not found" }, { status: 404 });
  }

  const data: { name?: string; description?: string | null } = {};

  if (typeof raw.name === "string") {
    const candidate = normalizeChannelName(raw.name);
    if (!isValidChannelName(candidate)) {
      return NextResponse.json({ error: "invalid_name" }, { status: 400 });
    }
    if (existing.isDefault && candidate !== existing.name) {
      return NextResponse.json(
        { error: "default_channel_locked", detail: "The default channel can't be renamed." },
        { status: 409 },
      );
    }
    if (candidate !== existing.name) data.name = candidate;
  }

  if (typeof raw.description === "string") {
    const trimmed = raw.description.trim().slice(0, 280);
    data.description = trimmed || null;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ channel: mapChannel(existing) });
  }

  let updated;
  try {
    updated = await db.teamChannel.update({ where: { id }, data });
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      return NextResponse.json({ error: "name_taken" }, { status: 409 });
    }
    throw err;
  }

  emitToTeam(session.teamId, "team:catalog:changed", {
    teamId: session.teamId,
    scope: "team-channels",
  });

  return NextResponse.json({ channel: mapChannel(updated) });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  if (!canDeleteChannel(session.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;

  const existing = await db.teamChannel.findFirst({
    where: { id, teamId: session.teamId },
  });
  if (!existing) {
    return NextResponse.json({ error: "channel not found" }, { status: 404 });
  }
  if (existing.isDefault || existing.name === DEFAULT_CHANNEL_NAME) {
    return NextResponse.json(
      { error: "default_channel_locked", detail: "The default channel can't be deleted." },
      { status: 409 },
    );
  }

  // FK cascades take care of messages / mentions / reactions / pins /
  // receipts in one shot — see the migration. Single DELETE call.
  await db.teamChannel.delete({ where: { id } });

  emitToTeam(session.teamId, "team:catalog:changed", {
    teamId: session.teamId,
    scope: "team-channels",
  });

  return NextResponse.json({ ok: true });
}
