import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { blobStorage } from "@/lib/blob-storage";
import { emitToTeam } from "@/lib/socket-server";
import type { Contact } from "@/lib/types";

/**
 * Update editable fields on a contact: name, email, location, customFields.
 *
 * Phone number is intentionally NOT editable. It's the WhatsApp identity
 * used to dedupe inbound webhooks and route conversations — changing it
 * would silently break the link to the customer's WhatsApp account.
 * Requests including `phoneNumber` are rejected with 400.
 *
 * customFields is a partial merge: keys with `null` value are removed,
 * string values overwrite, missing keys are left untouched. This means a
 * single PATCH can update one field without the client needing to send the
 * whole bag back.
 *
 * Authz: any signed-in member of the team can edit. Per CLAUDE.md the team
 * is small + trusted; we'll tighten this if/when contact PII becomes
 * sensitive.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  name?: unknown;
  phoneNumber?: unknown;
  email?: unknown;
  location?: unknown;
  customFields?: unknown;
  stageId?: unknown;
}

const MAX_TEXT = 500;
const MAX_FIELDS_PER_PATCH = 50;

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { teamId } = session;
  const { id: contactId } = await ctx.params;

  let raw: Body;
  try {
    raw = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // Phone number is the WhatsApp identity — never editable. Reject loudly
  // rather than silently dropping the field so a buggy client surfaces fast.
  if (raw.phoneNumber !== undefined) {
    return NextResponse.json(
      { error: "phoneNumber is not editable — it's the WhatsApp identity for this contact" },
      { status: 400 },
    );
  }

  // Build the update payload field-by-field so callers can omit anything they
  // don't want to touch. `null` on a nullable column clears it; on `name`
  // (NOT NULL) we reject null/empty.
  const update: {
    name?: string;
    email?: string | null;
    location?: string | null;
    stageId?: string | null;
  } = {};

  if (raw.name !== undefined) {
    if (typeof raw.name !== "string" || raw.name.trim().length === 0) {
      return NextResponse.json({ error: "name must be a non-empty string" }, { status: 400 });
    }
    if (raw.name.length > MAX_TEXT) {
      return NextResponse.json({ error: "name too long" }, { status: 400 });
    }
    update.name = raw.name.trim();
  }

  if (raw.email !== undefined) {
    const v = normalizeNullable(raw.email);
    if (v === INVALID) {
      return NextResponse.json({ error: "email must be a string or null" }, { status: 400 });
    }
    if (v && v.length > MAX_TEXT) {
      return NextResponse.json({ error: "email too long" }, { status: 400 });
    }
    update.email = v;
  }

  if (raw.location !== undefined) {
    const v = normalizeNullable(raw.location);
    if (v === INVALID) {
      return NextResponse.json({ error: "location must be a string or null" }, { status: 400 });
    }
    if (v && v.length > MAX_TEXT) {
      return NextResponse.json({ error: "location too long" }, { status: 400 });
    }
    update.location = v;
  }

  // customFields requires a read-modify-write because Postgres JSONB partial
  // merges aren't first-class in Prisma. Done in a transaction so a parallel
  // edit can't drop a key. The team scope on the WHERE clause means a hostile
  // client can't poke at another tenant's contact even by guessing the id.
  const customFieldsPatch = parseCustomFieldsPatch(raw.customFields);
  if (customFieldsPatch === INVALID) {
    return NextResponse.json(
      { error: "customFields must be an object of string|null values" },
      { status: 400 },
    );
  }

  if (raw.stageId !== undefined) {
    if (raw.stageId === null) {
      update.stageId = null;
    } else if (typeof raw.stageId === "string" && raw.stageId.length > 0) {
      // Confirm the stage belongs to this team. Without this scope check
      // an agent could park their contact in another tenant's stage by id
      // guessing — harmless cosmetically but bad for our boundary story.
      const ok = await db.contactStage.findFirst({
        where: { id: raw.stageId, teamId },
        select: { id: true },
      });
      if (!ok) {
        return NextResponse.json({ error: "stage not found" }, { status: 400 });
      }
      update.stageId = raw.stageId;
    } else {
      return NextResponse.json(
        { error: "stageId must be a string or null" },
        { status: 400 },
      );
    }
  }

  try {
    const updated = await db.$transaction(async (tx) => {
      const existing = await tx.contact.findFirst({
        where: { id: contactId, teamId },
      });
      if (!existing) return null;

      const nextCustom =
        customFieldsPatch === undefined
          ? undefined
          : mergeCustomFields(
              (existing.customFields as Record<string, unknown> | null) ?? {},
              customFieldsPatch,
            );

      return tx.contact.update({
        where: { id: contactId },
        data: {
          ...update,
          ...(nextCustom !== undefined ? { customFields: nextCustom } : {}),
        },
      });
    });

    if (!updated) {
      return NextResponse.json({ error: "contact not found" }, { status: 404 });
    }

    const contact: Contact = {
      id: updated.id,
      teamId: updated.teamId,
      phoneNumber: updated.phoneNumber,
      name: updated.name,
      avatarUrl: updated.avatarUrl ?? undefined,
      email: updated.email ?? undefined,
      location: updated.location ?? undefined,
      customFields: normalizeStringMap(updated.customFields),
      source: updated.source,
      stageId: updated.stageId,
    };
    return NextResponse.json({ contact });
  } catch (err) {
    console.error("[api/contacts/PATCH] failed", err);
    return NextResponse.json({ error: "update failed" }, { status: 500 });
  }
}

/**
 * Delete a contact and everything that hangs off it. Schema cascades handle
 * the row deletes (Conversation, Message, InternalNote, BroadcastRecipient,
 * Tag join rows), but the message media files on disk are NOT covered by
 * the FK cascade — we collect them first and best-effort unlink after the
 * DB commits.
 *
 * Best-effort: a failed file unlink does NOT roll back the DB, since the
 * caller wants the contact gone from their inbox even if disk cleanup hits
 * a transient error. The orphaned bytes will be picked up by a future GC
 * pass (not yet implemented — TODO when storage starts to matter).
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { teamId } = session;
  const { id: contactId } = await ctx.params;

  // Ownership check + blob-key gather in a single round-trip. The
  // `Conversation -> Message` chain is the only source of media artifacts
  // attached to a contact.
  const contact = await db.contact.findFirst({
    where: { id: contactId, teamId },
    select: {
      id: true,
      conversations: {
        select: {
          id: true,
          messages: {
            where: { mediaKey: { not: null } },
            select: { mediaKey: true },
          },
        },
      },
    },
  });

  if (!contact) {
    return NextResponse.json({ error: "contact not found" }, { status: 404 });
  }

  const mediaKeys = contact.conversations
    .flatMap((c) => c.messages)
    .map((m) => m.mediaKey)
    .filter((k): k is string => Boolean(k));
  // Snapshot conversation ids before the delete so we can fan out the
  // socket events afterwards.
  const conversationIds = contact.conversations.map((c) => c.id);

  await db.contact.delete({ where: { id: contactId } });

  // Batched best-effort delete on the blob provider — idempotent and never
  // throws. The contact is already gone from the DB; a transient provider
  // failure here would just leak storage, not orphan rows.
  if (mediaKeys.length > 0) {
    await blobStorage.delete(mediaKeys);
  }

  // Splice the rows out of every connected client's view.
  for (const cid of conversationIds) {
    emitToTeam(teamId, "conversation:deleted", { teamId, conversationId: cid });
  }
  emitToTeam(teamId, "contact:deleted", { teamId, contactId });

  return NextResponse.json({ ok: true });
}

const INVALID = Symbol("invalid");
type Invalid = typeof INVALID;

function normalizeNullable(v: unknown): string | null | Invalid {
  if (v === null) return null;
  if (typeof v !== "string") return INVALID;
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function parseCustomFieldsPatch(
  v: unknown,
): Record<string, string | null> | undefined | Invalid {
  if (v === undefined) return undefined;
  if (!v || typeof v !== "object" || Array.isArray(v)) return INVALID;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > MAX_FIELDS_PER_PATCH) return INVALID;
  const out: Record<string, string | null> = {};
  for (const [k, val] of entries) {
    if (typeof k !== "string" || k.length === 0 || k.length > 80) return INVALID;
    if (val === null) {
      out[k] = null;
    } else if (typeof val === "string") {
      if (val.length > MAX_TEXT) return INVALID;
      out[k] = val;
    } else {
      return INVALID;
    }
  }
  return out;
}

/**
 * Apply a partial patch to a customFields bag.
 *  - string  → set/overwrite
 *  - null    → remove the key
 *  - missing → left untouched
 */
function mergeCustomFields(
  current: Record<string, unknown>,
  patch: Record<string, string | null>,
): Record<string, string> {
  const merged = normalizeStringMap(current);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
  return merged;
}

function normalizeStringMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
