import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import {
  SendTemplateValidationError,
  sendTemplateInternal,
} from "@/lib/messaging/send-template-internal";
import { normalizeMetaSendError } from "@/lib/providers/meta";

/**
 * Outbound template send. Unlike `/api/messages` (free-form text), this is
 * the *only* legal send shape outside the 24h customer-service window, and
 * it's also legal inside the window.
 *
 * Body: `{ conversationId, templateId, variables: { body: string[], header?: string }, clientTempId? }`
 *
 * The validation + the actual send live in lib/messaging/send-template-internal.ts —
 * this route owns auth, request parsing, and HTTP error mapping. The same
 * helper is called by lib/workflows/steps/send-template.ts so the workflow
 * path and the agent path produce identical message rows.
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

const ERROR_STATUS: Record<SendTemplateValidationError["code"], number> = {
  conversation_not_found: 404,
  template_not_found: 404,
  template_not_approved: 409,
  wrong_body_var_count: 400,
  header_var_required: 400,
  contact_has_no_phone: 400,
  provider_not_configured: 409,
  provider_no_template_support: 501,
};

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

  const conversationId = typeof raw.conversationId === "string" ? raw.conversationId : null;
  const templateId = typeof raw.templateId === "string" ? raw.templateId : null;
  const variables = parseVariables(raw.variables);

  if (!conversationId || !templateId) {
    return NextResponse.json(
      { error: "conversationId and templateId required" },
      { status: 400 },
    );
  }

  try {
    const result = await sendTemplateInternal({
      teamId,
      conversationId,
      templateId,
      variables,
      senderUserId: userId,
      sentVia: "api/messages/template",
    });
    return NextResponse.json({ ok: true, messageId: result.messageId });
  } catch (err) {
    if (err instanceof SendTemplateValidationError) {
      return NextResponse.json(
        { error: err.code, ...(err.detail ? { detail: err.detail } : {}) },
        { status: ERROR_STATUS[err.code] },
      );
    }
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
