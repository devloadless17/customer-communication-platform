import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { normalizePhoneE164 } from "@/lib/phone";
import { ensureDefaultStage, listContacts } from "@/lib/queries";
import type { Contact } from "@/lib/types";

/**
 * Team-scoped contacts collection.
 *
 *  GET  — paginated list for the /contacts page. Supports `search`,
 *         `fieldKey`+`fieldValue` (filter on a custom field), and `cursor`.
 *  POST — manually create a contact. Used by the "New contact" dialog and
 *         (later) the template-send flow which needs to attach a phone
 *         number that hasn't messaged us yet.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TEXT = 500;
const MAX_FIELDS = 50;

export async function GET(req: Request) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  const url = new URL(req.url);
  const search = url.searchParams.get("search") ?? undefined;
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const fieldKey = url.searchParams.get("fieldKey") ?? undefined;
  const fieldValue = url.searchParams.get("fieldValue") ?? undefined;
  const sourceParam = url.searchParams.get("source");
  const source =
    sourceParam === "inbound" || sourceParam === "manual" ? sourceParam : undefined;
  // ?tagIds=a,b,c — keep contacts carrying ANY of them.
  const tagIdsParam = url.searchParams.get("tagIds");
  const tagIds = tagIdsParam
    ? tagIdsParam.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    : undefined;
  // ?window=open|closed — 24h customer-service window state.
  const windowParam = url.searchParams.get("window");
  const window = windowParam === "open" || windowParam === "closed" ? windowParam : undefined;
  // ?stageId=<cuid|none> — filter to a specific stage, or to contacts that
  // have no stage at all (the literal string "none").
  const stageParam = url.searchParams.get("stageId");
  const stageId =
    stageParam === "none"
      ? "none"
      : stageParam && stageParam.length > 0
        ? stageParam
        : undefined;

  const page = await listContacts(session.teamId, {
    search,
    cursor,
    fieldFilter: fieldKey && fieldValue ? { key: fieldKey, value: fieldValue } : undefined,
    source,
    tagIds,
    window,
    stageId,
  });

  return NextResponse.json(page);
}

interface PostBody {
  name?: unknown;
  phoneNumber?: unknown;
  email?: unknown;
  location?: unknown;
  customFields?: unknown;
}

export async function POST(req: Request) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  let raw: PostBody;
  try {
    raw = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const phoneRaw = typeof raw.phoneNumber === "string" ? raw.phoneNumber : "";
  const phone = normalizePhoneE164(phoneRaw);
  if (!phone) {
    return NextResponse.json(
      { error: "phoneNumber must be a valid international number (e.g. +1 555 555 0100)" },
      { status: 400 },
    );
  }

  // Default name to the phone number — matches the inbound webhook path
  // (ingest does the same when Meta hasn't given us a profile name yet).
  const name =
    typeof raw.name === "string" && raw.name.trim().length > 0
      ? raw.name.trim().slice(0, MAX_TEXT)
      : phone;

  const email = optionalString(raw.email, "email");
  if (email instanceof NextResponse) return email;

  const location = optionalString(raw.location, "location");
  if (location instanceof NextResponse) return location;

  const customFields = parseCreateCustomFields(raw.customFields);
  if (customFields instanceof NextResponse) return customFields;

  // Every contact lands in the team's default stage on create. Lazy-init
  // covers teams that signed up before the stages migration AND teams whose
  // admin deleted the seeded default — we never want to skip stage
  // assignment silently.
  const stageId = await ensureDefaultStage(session.teamId);

  try {
    const created = await db.contact.create({
      data: {
        teamId: session.teamId,
        phoneNumber: phone,
        name,
        email: email ?? undefined,
        location: location ?? undefined,
        customFields,
        stageId,
        // Manually-created contacts are tagged so the contacts list can show
        // a "Added by you" badge and filter them apart from inbound contacts.
        source: "manual",
      },
    });

    const contact: Contact = {
      id: created.id,
      teamId: created.teamId,
      phoneNumber: created.phoneNumber,
      name: created.name,
      avatarUrl: created.avatarUrl ?? undefined,
      email: created.email ?? undefined,
      location: created.location ?? undefined,
      customFields: normalizeStringMap(created.customFields),
      source: created.source,
      stageId: created.stageId,
    };
    return NextResponse.json({ contact }, { status: 201 });
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      return NextResponse.json(
        { error: "a contact with this phone number already exists" },
        { status: 409 },
      );
    }
    console.error("[api/contacts/POST] failed", err);
    return NextResponse.json({ error: "create failed" }, { status: 500 });
  }
}

/** Returns trimmed string, null (when empty/null), or a 400 NextResponse. */
function optionalString(v: unknown, label: string): string | null | NextResponse {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") {
    return NextResponse.json({ error: `${label} must be a string` }, { status: 400 });
  }
  const trimmed = v.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_TEXT) {
    return NextResponse.json({ error: `${label} too long` }, { status: 400 });
  }
  return trimmed;
}

function parseCreateCustomFields(v: unknown): Record<string, string> | NextResponse {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) {
    return NextResponse.json(
      { error: "customFields must be an object of string values" },
      { status: 400 },
    );
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > MAX_FIELDS) {
    return NextResponse.json(
      { error: `at most ${MAX_FIELDS} customFields entries` },
      { status: 400 },
    );
  }
  const out: Record<string, string> = {};
  for (const [k, val] of entries) {
    if (typeof k !== "string" || !k || k.length > 80) {
      return NextResponse.json({ error: "invalid customFields key" }, { status: 400 });
    }
    if (val === null || val === undefined || val === "") continue;
    if (typeof val !== "string") {
      return NextResponse.json(
        { error: "customFields values must be strings" },
        { status: 400 },
      );
    }
    if (val.length > MAX_TEXT) {
      return NextResponse.json({ error: "customFields value too long" }, { status: 400 });
    }
    out[k] = val;
  }
  return out;
}

function normalizeStringMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
