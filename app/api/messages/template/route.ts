import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { createOutboundMessageIdempotent } from "@/lib/messages/idempotent-create";
import { getMetaProvider } from "@/lib/providers";
import { getMetaSendConfig, ProviderNotConfiguredError } from "@/lib/providers/config";
import {
  countTemplatePlaceholders,
  normalizeMetaSendError,
  renderTemplateBody,
} from "@/lib/providers/meta";
import type { TemplateComponent } from "@/lib/providers/types";
import { emitToTeam } from "@/lib/socket/server";
import type { Message } from "@/lib/types";

/**
 * Outbound template send. Unlike `/api/messages` (free-form text), this is
 * the *only* legal send shape outside the 24h customer-service window, and
 * it's also legal inside the window.
 *
 * Body: `{ conversationId, templateId, variables: { body: string[], header?: string }, clientTempId? }`
 *
 * Server-side validation:
 *   - Template belongs to this team (no cross-tenant leakage).
 *   - Template status is `approved` — pending / rejected / paused / disabled
 *     would all get rejected by Meta anyway, but we want a clearer error.
 *   - Variable count matches the template's `{{N}}` placeholders.
 *
 * On success: persists a message row with the *rendered* preview body so the
 * thread shows the customer-visible string ("Hi John, your order is ready"),
 * not the raw template ("Hi {{1}}, your order is {{2}}").
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  conversationId?: unknown;
  templateId?: unknown;
  variables?: unknown;
  clientTempId?: unknown;
}

interface Variables {
  body: string[];
  header?: string;
}

export async function POST(req: Request) {
  // See app/api/messages/route.ts — receive-time stamping keeps row order
  // aligned with the user's send sequence across mixed text/media/template
  // sends regardless of Meta-API latency variation.
  const receivedAt = new Date();
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { userId, teamId } = session;

  let raw: Body;
  try {
    raw = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const conversationId = typeof raw.conversationId === "string" ? raw.conversationId : null;
  const templateId = typeof raw.templateId === "string" ? raw.templateId : null;
  const clientTempId =
    typeof raw.clientTempId === "string" && raw.clientTempId
      ? raw.clientTempId
      : undefined;
  const variables = parseVariables(raw.variables);

  if (!conversationId || !templateId) {
    return NextResponse.json(
      { error: "conversationId and templateId required" },
      { status: 400 },
    );
  }

  const [conversation, template] = await Promise.all([
    db.conversation.findFirst({
      where: { id: conversationId, teamId },
      include: { contact: true },
    }),
    db.messageTemplate.findFirst({ where: { id: templateId, teamId } }),
  ]);

  if (!conversation) {
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  }
  if (!template) {
    return NextResponse.json({ error: "template not found" }, { status: 404 });
  }
  if (template.status !== "approved") {
    return NextResponse.json(
      {
        error: "template not approved",
        detail: `Template is ${template.status}. Only approved templates can be sent.`,
      },
      { status: 409 },
    );
  }

  // Validate the variable shape matches the template's placeholder count.
  // Saves a round-trip to Meta for the most common mistake: agent forgot
  // to fill in a {{2}} value.
  const bodyVarCount = countTemplatePlaceholders(template.bodyText);
  if (variables.body.length !== bodyVarCount) {
    return NextResponse.json(
      {
        error: "wrong variable count",
        detail: `Template body expects ${bodyVarCount} variable(s), got ${variables.body.length}.`,
      },
      { status: 400 },
    );
  }

  // If the template has a TEXT header with a `{{1}}`, the agent must fill it.
  // Headers with media / no placeholder ignore the header variable entirely.
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

  let sendConfig;
  try {
    sendConfig = await getMetaSendConfig(teamId);
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
  if (!provider.sendTemplate) {
    return NextResponse.json(
      { error: "provider does not support templates" },
      { status: 501 },
    );
  }

  if (!conversation.contact.phoneNumber) {
    return NextResponse.json(
      { error: "contact_has_no_phone", detail: "This contact has no WhatsApp number." },
      { status: 400 },
    );
  }
  let send;
  try {
    send = await provider.sendTemplate(
      {
        to: conversation.contact.phoneNumber,
        name: template.name,
        language: template.language,
        variables: {
          body: variables.body,
          ...(variables.header ? { header: variables.header } : {}),
        },
      },
      sendConfig,
    );
  } catch (err) {
    const normalized = normalizeMetaSendError(err);
    if (normalized) {
      return NextResponse.json(
        {
          error: normalized.code,
          message: normalized.message,
          status: normalized.httpStatus,
          detail: normalized.detail,
        },
        { status: 422 },
      );
    }
    console.error("[api/messages/template] send failed", err);
    return NextResponse.json(
      { error: "send_failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  // Render the customer-visible body for the thread bubble. We store this in
  // `body` instead of the raw template so the inbox UI shows the same thing
  // the customer received — searching for "your order is ready" should hit.
  const renderedBody = renderTemplateBody(template.bodyText, variables.body);
  const previewBody = renderedBody.slice(0, 200);

  const created = await createOutboundMessageIdempotent({
    teamId,
    conversationId,
    externalId: send.externalId,
    senderUserId: userId,
    body: renderedBody,
    direction: "out",
    provider: "meta_cloud",
    status: "sent",
    rawPayload: {
      sentVia: "api/messages/template",
      templateId: template.id,
      templateName: template.name,
      templateLanguage: template.language,
      variables: {
        body: variables.body,
        ...(variables.header ? { header: variables.header } : {}),
      },
    } as Prisma.InputJsonValue,
    timestamp: receivedAt,
  });

  await db.conversation.update({
    where: { id: conversationId },
    data: {
      lastMessageAt: send.timestamp,
      lastMessagePreview: previewBody,
    },
  });

  const message: Message = {
    id: created.id,
    teamId,
    conversationId,
    externalId: send.externalId,
    senderUserId: userId,
    body: renderedBody,
    direction: "out",
    provider: "meta_cloud",
    status: "sent",
    rawPayload: {
      sentVia: "api/messages/template",
      templateId: template.id,
      templateName: template.name,
    },
    timestamp: receivedAt.toISOString(),
  };

  emitToTeam(teamId, "message:new", {
    teamId,
    conversationId,
    message,
    preview: previewBody,
    lastMessageAt: send.timestamp.toISOString(),
    unreadDelta: 0,
    ...(clientTempId ? { clientTempId } : {}),
  });

  return NextResponse.json({ ok: true, messageId: created.id });
}

function parseVariables(v: unknown): Variables {
  if (typeof v !== "object" || v === null) return { body: [] };
  const obj = v as { body?: unknown; header?: unknown };
  const body = Array.isArray(obj.body)
    ? obj.body.filter((x): x is string => typeof x === "string")
    : [];
  const header = typeof obj.header === "string" ? obj.header : undefined;
  return { body, ...(header ? { header } : {}) };
}
