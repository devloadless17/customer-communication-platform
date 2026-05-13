import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { getSession } from "@/lib/current-user";
import { db } from "@/lib/db";
import { getMetaProvider } from "@/lib/providers";
import { getMetaSendConfig, ProviderNotConfiguredError } from "@/lib/providers/config";
import { MetaSendError, MissingWabaIdError } from "@/lib/providers/meta";
import type { ProviderTemplate, TemplateComponent } from "@/lib/providers/types";
import type { TemplateDto } from "@/lib/types";

/**
 * Template catalog.
 *
 *   GET  → returns the team's cached templates (no Meta call)
 *   POST → forces a re-sync from Meta and returns the fresh list
 *
 * The picker UI hits GET when it opens, and POST when the agent clicks
 * "Refresh from Meta". Splitting the two keeps the happy path fast (single
 * DB query) and the refresh button explicit.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { teamId } = await getSession();
  // Two queries in parallel: the catalog rows + a quick check on whether the
  // team has a WABA id configured. The picker uses `hasWabaId` to decide
  // between the "go set up your WABA" nudge and the "click refresh / no
  // templates yet" path before any POST round-trip.
  const [rows, team] = await Promise.all([
    db.messageTemplate.findMany({
      where: { teamId },
      orderBy: [{ status: "asc" }, { name: "asc" }, { language: "asc" }],
    }),
    db.team.findUnique({
      where: { id: teamId },
      select: { metaWabaId: true, metaPhoneNumberId: true },
    }),
  ]);
  return NextResponse.json({
    templates: rows.map(toDto),
    hasWabaId: Boolean(team?.metaWabaId),
    connected: Boolean(team?.metaPhoneNumberId),
  });
}

/**
 * Force a sync from Meta and return the refreshed catalog. Any agent on the
 * team can trigger this — it's read-only against Meta and idempotent locally
 * (upsert by `(teamId, name, language)`).
 */
export async function POST() {
  const { teamId } = await getSession();

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
  if (!provider.fetchTemplates) {
    return NextResponse.json(
      { error: "provider does not support templates" },
      { status: 501 },
    );
  }

  let fetched: ProviderTemplate[];
  try {
    fetched = await provider.fetchTemplates(config);
  } catch (err) {
    if (err instanceof MissingWabaIdError) {
      return NextResponse.json(
        {
          error: "waba id missing",
          detail:
            "Add your WhatsApp Business Account ID in Settings → WhatsApp to load templates.",
        },
        { status: 409 },
      );
    }
    if (err instanceof MetaSendError) {
      return NextResponse.json(
        { error: "meta rejected request", status: err.httpStatus, detail: err.body.slice(0, 500) },
        { status: 422 },
      );
    }
    console.error("[api/team/whatsapp/templates] sync failed", err);
    return NextResponse.json(
      { error: "sync failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  // Upsert each template by the natural key. We don't delete rows that
  // disappeared from Meta — admins occasionally pause + un-pause templates
  // and we want the local row's status to flip through the lifecycle, not
  // vanish and reappear. (Deleted-on-Meta rows will get status=disabled on
  // the next refresh.)
  const now = new Date();
  await db.$transaction(
    fetched.map((t) =>
      db.messageTemplate.upsert({
        where: {
          teamId_name_language: { teamId, name: t.name, language: t.language },
        },
        create: {
          teamId,
          externalId: t.externalId ?? null,
          name: t.name,
          language: t.language,
          category: t.category,
          status: t.status,
          bodyText: t.bodyText,
          components: t.components as unknown as Prisma.InputJsonValue,
          syncedAt: now,
        },
        update: {
          externalId: t.externalId ?? null,
          category: t.category,
          status: t.status,
          bodyText: t.bodyText,
          components: t.components as unknown as Prisma.InputJsonValue,
          syncedAt: now,
        },
      }),
    ),
  );

  const rows = await db.messageTemplate.findMany({
    where: { teamId },
    orderBy: [{ status: "asc" }, { name: "asc" }, { language: "asc" }],
  });

  return NextResponse.json({
    templates: rows.map(toDto),
    syncedCount: fetched.length,
  });
}

function toDto(row: {
  id: string;
  externalId: string | null;
  name: string;
  language: string;
  category: string;
  status: string;
  bodyText: string;
  components: Prisma.JsonValue;
  variableBindings: Prisma.JsonValue;
  syncedAt: Date;
}): TemplateDto {
  return {
    id: row.id,
    externalId: row.externalId,
    name: row.name,
    language: row.language,
    category: row.category,
    status: row.status,
    bodyText: row.bodyText,
    components: Array.isArray(row.components)
      ? (row.components as unknown as TemplateComponent[])
      : [],
    variableBindings: row.variableBindings ?? {},
    syncedAt: row.syncedAt.toISOString(),
  };
}
