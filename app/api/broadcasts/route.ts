import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { startBroadcast } from "@/lib/broadcast-runner";
import { countTemplatePlaceholders } from "@/lib/providers/meta";
import { resolveAudienceGroupMembers } from "@/lib/queries";
import type { TemplateComponent } from "@/lib/providers/types";

/**
 * Broadcasts: create + list.
 *
 *   POST  → create a Broadcast row, snapshot recipients into
 *           BroadcastRecipient rows, fire-and-forget the runner.
 *           Returns the new broadcast id immediately so the UI can redirect.
 *   GET   → list the team's broadcasts, newest first, summary fields only.
 *
 * Audience modes (v1):
 *   - "all":      every contact in the team at creation time
 *   - "selected": the contact ids provided in the body
 *
 * Filter-based audiences (e.g. "all closed-window contacts") would land here
 * but aren't in v1.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  templateId?: unknown;
  variables?: unknown;
  audience?: unknown;
}

interface AudiencePayload {
  mode: "all" | "selected" | "by_tag" | "group";
  contactIds: string[];
  tagIds: string[];
  groupId: string | null;
}

export async function POST(req: Request) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { userId, teamId } = session;

  let raw: Body;
  try {
    raw = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const templateId = typeof raw.templateId === "string" ? raw.templateId : null;
  const audience = parseAudience(raw.audience);
  const variables = parseVariables(raw.variables);

  if (!templateId) {
    return NextResponse.json({ error: "templateId required" }, { status: 400 });
  }

  const template = await db.messageTemplate.findFirst({
    where: { id: templateId, teamId },
  });
  if (!template) {
    return NextResponse.json({ error: "template not found" }, { status: 404 });
  }
  if (template.status !== "approved") {
    return NextResponse.json(
      {
        error: "template not approved",
        detail: `Template is ${template.status}. Only approved templates can be broadcast.`,
      },
      { status: 409 },
    );
  }

  // Variable count sanity check — caught here so the UI can correct before
  // we even create the broadcast row.
  const bodyVarCount = countTemplatePlaceholders(template.bodyText);
  if (variables.body.length !== bodyVarCount) {
    return NextResponse.json(
      {
        error: "wrong variable count",
        detail: `Template expects ${bodyVarCount} body variable(s), got ${variables.body.length}.`,
      },
      { status: 400 },
    );
  }
  const components = Array.isArray(template.components)
    ? (template.components as unknown as TemplateComponent[])
    : [];
  const headerComp = components.find((c) => c.type === "HEADER");
  const headerVarCount =
    headerComp?.format === "TEXT" && headerComp.text
      ? countTemplatePlaceholders(headerComp.text)
      : 0;
  if (headerVarCount > 0 && (!variables.header || variables.header.length === 0)) {
    return NextResponse.json(
      {
        error: "header variable required",
        detail: "This template's header has a placeholder — fill it in.",
      },
      { status: 400 },
    );
  }

  // Resolve recipient contact ids based on audience mode.
  // `by_tag` resolves to the union of contacts carrying ANY of the selected
  // tags — semantically "OR", which matches how segmentation tools usually
  // behave. Snapshot is taken at this moment; later tagging changes don't
  // affect an already-created broadcast.
  let recipientIds: string[] = [];
  let validatedTagIds: string[] = [];
  let resolvedGroupId: string | null = null;
  let resolvedGroupName: string | null = null;
  if (audience.mode === "all") {
    recipientIds = (
      await db.contact.findMany({ where: { teamId }, select: { id: true } })
    ).map((c) => c.id);
  } else if (audience.mode === "by_tag") {
    if (audience.tagIds.length === 0) {
      return NextResponse.json(
        { error: "no tags selected", detail: "Pick at least one tag." },
        { status: 400 },
      );
    }
    // Validate tag ownership before the contact lookup — a foreign-team id
    // would silently yield zero recipients otherwise.
    const tagRows = await db.tag.findMany({
      where: { teamId, id: { in: audience.tagIds } },
      select: { id: true },
    });
    validatedTagIds = tagRows.map((t) => t.id);
    if (validatedTagIds.length === 0) {
      return NextResponse.json(
        { error: "no valid tags", detail: "None of the selected tags belong to this team." },
        { status: 400 },
      );
    }
    const taggedContacts = await db.contact.findMany({
      where: { teamId, tags: { some: { id: { in: validatedTagIds } } } },
      select: { id: true },
    });
    recipientIds = taggedContacts.map((c) => c.id);
  } else if (audience.mode === "group") {
    if (!audience.groupId) {
      return NextResponse.json(
        { error: "groupId required", detail: "Pick a saved group." },
        { status: 400 },
      );
    }
    const group = await db.audienceGroup.findFirst({
      where: { id: audience.groupId, teamId },
      include: {
        tags: { select: { id: true } },
        contacts: { select: { id: true } },
      },
    });
    if (!group) {
      return NextResponse.json(
        { error: "group not found", detail: "This audience group no longer exists." },
        { status: 404 },
      );
    }
    // Snapshot resolution: expand the group's tag + manual membership into a
    // concrete contact id set RIGHT NOW. New contacts that match the tag
    // criteria after this point won't join the in-flight broadcast.
    recipientIds = await resolveAudienceGroupMembers(teamId, {
      tagIds: group.tags.map((t) => t.id),
      manualContactIds: group.contacts.map((c) => c.id),
    });
    resolvedGroupId = group.id;
    resolvedGroupName = group.name;
  } else {
    recipientIds = Array.from(
      new Set(
        (
          await db.contact.findMany({
            where: { teamId, id: { in: audience.contactIds } },
            select: { id: true },
          })
        ).map((c) => c.id),
      ),
    );
  }

  if (recipientIds.length === 0) {
    return NextResponse.json(
      {
        error: "empty audience",
        detail: "Pick at least one contact (or 'All contacts') to broadcast to.",
      },
      { status: 400 },
    );
  }

  const broadcast = await db.broadcast.create({
    data: {
      teamId,
      createdById: userId,
      status: "queued",
      templateId: template.id,
      templateName: template.name,
      templateLanguage: template.language,
      variables: variables as unknown as Prisma.InputJsonValue,
      audienceMode: audience.mode,
      audienceTagIds: validatedTagIds,
      audienceGroupId: resolvedGroupId,
      audienceGroupName: resolvedGroupName,
      totalCount: recipientIds.length,
      recipients: {
        create: recipientIds.map((id) => ({ contactId: id })),
      },
    },
    select: { id: true, totalCount: true },
  });

  // Fire-and-forget the runner. The response returns before any sends happen
  // so the UI can redirect to the detail page and start watching progress.
  startBroadcast(broadcast.id);

  return NextResponse.json({
    ok: true,
    broadcastId: broadcast.id,
    totalCount: broadcast.totalCount,
  });
}

export async function GET() {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { teamId } = session;
  const rows = await db.broadcast.findMany({
    where: { teamId },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      createdBy: { select: { id: true, name: true } },
    },
  });
  return NextResponse.json({
    broadcasts: rows.map((b) => ({
      id: b.id,
      status: b.status,
      templateName: b.templateName,
      templateLanguage: b.templateLanguage,
      audienceMode: b.audienceMode,
      totalCount: b.totalCount,
      sentCount: b.sentCount,
      failedCount: b.failedCount,
      createdById: b.createdById,
      createdByName: b.createdBy?.name ?? "Removed user",
      createdAt: b.createdAt.toISOString(),
      startedAt: b.startedAt?.toISOString() ?? null,
      completedAt: b.completedAt?.toISOString() ?? null,
    })),
  });
}

function parseAudience(v: unknown): AudiencePayload {
  const empty: AudiencePayload = {
    mode: "selected",
    contactIds: [],
    tagIds: [],
    groupId: null,
  };
  if (typeof v !== "object" || v === null) return empty;
  const obj = v as {
    mode?: unknown;
    contactIds?: unknown;
    tagIds?: unknown;
    groupId?: unknown;
  };
  const ids = Array.isArray(obj.contactIds)
    ? obj.contactIds.filter((x): x is string => typeof x === "string")
    : [];
  const tagIds = Array.isArray(obj.tagIds)
    ? obj.tagIds.filter((x): x is string => typeof x === "string")
    : [];
  const groupId = typeof obj.groupId === "string" ? obj.groupId : null;
  if (obj.mode === "all") {
    return { mode: "all", contactIds: [], tagIds: [], groupId: null };
  }
  if (obj.mode === "by_tag") {
    return { mode: "by_tag", contactIds: [], tagIds, groupId: null };
  }
  if (obj.mode === "group") {
    return { mode: "group", contactIds: [], tagIds: [], groupId };
  }
  return { mode: "selected", contactIds: ids, tagIds: [], groupId: null };
}

function parseVariables(v: unknown): { body: string[]; header?: string } {
  if (typeof v !== "object" || v === null) return { body: [] };
  const obj = v as { body?: unknown; header?: unknown };
  const body = Array.isArray(obj.body)
    ? obj.body.filter((x): x is string => typeof x === "string")
    : [];
  const header = typeof obj.header === "string" ? obj.header : undefined;
  return { body, ...(header ? { header } : {}) };
}
