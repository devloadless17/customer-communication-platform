import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { getMetaProvider } from "@/lib/providers";
import { getMetaSendConfig, ProviderNotConfiguredError } from "@/lib/providers/config";
import { MetaSendError, MissingWabaIdError } from "@/lib/providers/meta";
import type {
  TemplateCategory,
  TemplateComponent,
} from "@/lib/providers/types";
import { emitCatalogChange } from "@/lib/socket/server";

/**
 * Create a new WhatsApp template.
 *
 * Flow:
 *   1. Validate the request body (name, language, category, components,
 *      bindings — same shape we cache for reads).
 *   2. POST to Meta. They return `pending` status almost always; approval
 *      lands asynchronously via the next `fetchTemplates` sync.
 *   3. Upsert the local cache row by the natural key (teamId, name, language)
 *      so a re-submit after a Meta-side reject overwrites cleanly. The body
 *      text is derived from the BODY component for cheap previews / search.
 *
 * What we deliberately DON'T do:
 *   - Edit existing templates. Meta restricts what's editable on
 *     APPROVED templates and forbids edits on PENDING. The UI hides "edit"
 *     and asks the user to delete + recreate, which keeps this route simple.
 *   - Validate Meta's per-category quirks. Meta's own error messages are far
 *     more informative than anything we'd reimplement; we surface them as-is.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  name?: unknown;
  language?: unknown;
  category?: unknown;
  components?: unknown;
  variableBindings?: unknown;
}

export async function POST(req: Request) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { teamId } = session;

  let raw: Body;
  try {
    raw = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const language = typeof raw.language === "string" ? raw.language.trim() : "";
  const category = parseCategory(raw.category);
  const components = parseComponents(raw.components);
  const variableBindings = raw.variableBindings ?? {};

  if (!/^[a-z0-9_]{1,512}$/.test(name)) {
    return NextResponse.json(
      {
        error: "invalid name",
        detail: "Template name must be lowercase letters, digits and underscores only.",
      },
      { status: 400 },
    );
  }
  if (!language || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(language)) {
    return NextResponse.json(
      { error: "invalid language", detail: "Use a Meta language code like en_US, fr, pt_BR." },
      { status: 400 },
    );
  }
  if (!category) {
    return NextResponse.json(
      { error: "invalid category", detail: "Pick marketing, utility or authentication." },
      { status: 400 },
    );
  }
  if (components.length === 0) {
    return NextResponse.json(
      { error: "components required", detail: "At least a BODY component is required." },
      { status: 400 },
    );
  }
  const body = components.find((c) => c.type === "BODY");
  if (!body || !body.text || body.text.trim().length === 0) {
    return NextResponse.json(
      { error: "body required", detail: "Add a body — it's the only required component." },
      { status: 400 },
    );
  }

  // -------------------------------------------------------------------------
  // Provider call
  // -------------------------------------------------------------------------
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
  if (!provider.createTemplate) {
    return NextResponse.json(
      { error: "provider cannot create templates" },
      { status: 501 },
    );
  }

  let created;
  try {
    created = await provider.createTemplate(
      { name, language, category, components },
      config,
    );
  } catch (err) {
    if (err instanceof MissingWabaIdError) {
      return NextResponse.json(
        {
          error: "waba id missing",
          detail:
            "Add your WhatsApp Business Account ID in Settings → WhatsApp before creating templates.",
        },
        { status: 409 },
      );
    }
    if (err instanceof MetaSendError) {
      return NextResponse.json(
        { error: "meta rejected request", status: err.httpStatus, detail: err.body.slice(0, 1000) },
        { status: 422 },
      );
    }
    console.error("[api/templates/create] failed", err);
    return NextResponse.json(
      { error: "create failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  // -------------------------------------------------------------------------
  // Local cache upsert
  // -------------------------------------------------------------------------
  const now = new Date();
  const saved = await db.messageTemplate.upsert({
    where: { teamId_name_language: { teamId, name, language } },
    create: {
      teamId,
      externalId: created.externalId,
      name,
      language,
      category,
      status: created.status,
      bodyText: body.text,
      components: components as unknown as Prisma.InputJsonValue,
      variableBindings: variableBindings as Prisma.InputJsonValue,
      syncedAt: now,
    },
    update: {
      externalId: created.externalId,
      category,
      status: created.status,
      bodyText: body.text,
      components: components as unknown as Prisma.InputJsonValue,
      variableBindings: variableBindings as Prisma.InputJsonValue,
      syncedAt: now,
    },
  });

  emitCatalogChange(teamId, "whatsapp-templates");
  return NextResponse.json({ ok: true, templateId: saved.id, status: saved.status });
}

function parseCategory(v: unknown): TemplateCategory | null {
  if (v === "marketing" || v === "utility" || v === "authentication") return v;
  return null;
}

/**
 * Loose parser for the request body's `components` array. We don't try to
 * mirror Meta's full type tree — anything Meta later rejects comes back as a
 * 422 with their own error message. We only enforce shape sanity (it's an
 * array of objects with a known `type`).
 */
function parseComponents(v: unknown): TemplateComponent[] {
  if (!Array.isArray(v)) return [];
  const out: TemplateComponent[] = [];
  for (const c of v) {
    if (!c || typeof c !== "object") continue;
    const obj = c as Record<string, unknown>;
    if (
      obj.type !== "HEADER" &&
      obj.type !== "BODY" &&
      obj.type !== "FOOTER" &&
      obj.type !== "BUTTONS"
    ) {
      continue;
    }
    // Cast once; the provider relays the shape to Meta without inspecting it.
    out.push(obj as unknown as TemplateComponent);
  }
  return out;
}
