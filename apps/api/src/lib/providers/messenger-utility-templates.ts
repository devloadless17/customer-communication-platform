/**
 * UTILITY MESSAGES — Messenger's approved-template system, and the only way to
 * message a customer OUTSIDE the 24-hour window that still exists.
 *
 * ## Why this is the most important thing in the Messenger surface
 *
 * Meta deprecated `CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE` and
 * `POST_PURCHASE_UPDATE` on 2026-04-27 — every request carrying one now returns
 * error 100. Their stated migration target is utility messages. `HUMAN_AGENT`
 * survives, but it is scoped to "issues that cannot be resolved within the 24
 * hour standard messaging window" and explicitly disallows "automated messages"
 * — so it cannot carry an order update or an appointment reminder.
 *
 * That leaves this as the whole of proactive Messenger messaging. Without it a
 * broadcast can only reach people whose window happens to be open.
 *
 * ## Not mirrored locally, on purpose
 *
 * There is no `MessengerTemplate` table. Meta owns this catalog, approval lands
 * "within seconds of creation", and templates are editable in Business Suite —
 * so a local mirror would be a second truth that drifts and needs a reconciler,
 * for no gain. This reads through, exactly like the profile and persona surfaces.
 *
 * WhatsApp mirrors its catalog for a reason that does not apply here: the
 * broadcast composer needs `variableBindings` (which audience column fills which
 * `{{1}}`), and that is OUR data, not Meta's. If Messenger broadcasts later need
 * the same, the binding is what earns a table — not the template.
 *
 * ## The case trap
 *
 * Component types are UPPERCASE when CREATING a template (`BODY`, `BUTTONS`,
 * `HEADER`) and lowercase when SENDING one (`body`, `buttons`). Meta's own
 * examples show both, one line apart, and the mismatch is not rejected loudly —
 * it fails as a parameter-count error that reads like the caller passed the wrong
 * number of variables. Both spellings are produced here deliberately, and pinned
 * by a test.
 */

import { GRAPH_BASE, graphGetJson, graphPostJson } from "@/lib/providers/meta-graph";
import type { SocialSendTarget } from "@/lib/providers/meta-social";
import type { SendTextResult } from "@ccp/shared/providers/types";

/**
 * How a template's variables are addressed. Mirrors WhatsApp's
 * `MessageTemplate.parameterFormat`, and matters for the same reason: it is the
 * single authority on positional-vs-named and must never be re-derived from a
 * regex over the body text.
 */
export type UtilityParameterFormat = "POSITIONAL" | "NAMED";

export interface UtilityTemplateSummary {
  id: string;
  name: string;
  language: string | null;
  /** Meta's own review state: APPROVED | PENDING | REJECTED. */
  status: string | null;
  category: string | null;
  parameterFormat: UtilityParameterFormat;
  /** The raw component array, as Meta returns it — see `components` below. */
  components: unknown[];
}

/** A body variable at SEND time. `name` is required for NAMED templates. */
export interface UtilityBodyParameter {
  text: string;
  /** Required when the template was created with `parameter_format: NAMED`. */
  name?: string;
}

/**
 * A button variable at SEND time. Meta's two documented shapes:
 *   POSTBACK — `{ type: "POSTBACK", payload }`
 *   URL      — `{ type: "URL", url }`, where `url` is the SUFFIX substituted into
 *              the template's `{{1}}`, not a whole URL.
 *
 * The URL suffix stays POSITIONAL even on a NAMED template — Meta: "URL button
 * suffixes continue to use positional parameters" — which is why it carries no
 * `name` field at all.
 */
export type UtilityButtonParameter =
  | { type: "POSTBACK"; payload: string }
  | { type: "URL"; urlSuffix: string };

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * The Page's utility templates (`GET /{PAGE_ID}/message_templates`).
 *
 * `parameter_format` is read from Meta and defaulted to POSITIONAL when absent,
 * never inferred from the body text. A template whose copy legitimately contains
 * `{{word}}` would otherwise be misread as NAMED and fail every send — the exact
 * WhatsApp bug this codebase already carries an invariant about.
 */
export async function listUtilityTemplates(
  opts: SocialSendTarget,
): Promise<UtilityTemplateSummary[]> {
  const res = await graphGetJson(
    `${GRAPH_BASE}/${opts.graphVersion}/${encodeURIComponent(opts.accountId)}/message_templates` +
      `?fields=id,name,language,status,category,parameter_format,components&limit=200`,
    opts.accessToken,
    { retry: true },
    opts.appSecret,
  );
  const data = Array.isArray(res.data) ? (res.data as Array<Record<string, unknown>>) : [];
  return data.flatMap((row) => {
    const id = str(row.id);
    const name = str(row.name);
    if (!id || !name) return [];
    return [
      {
        id,
        name,
        language: str(row.language),
        status: str(row.status),
        category: str(row.category),
        parameterFormat: str(row.parameter_format)?.toUpperCase() === "NAMED" ? "NAMED" : "POSITIONAL",
        components: Array.isArray(row.components) ? row.components : [],
      },
    ];
  });
}

/**
 * Create a Page-owned utility template.
 *
 * `components` is passed through as the caller built it, because the component
 * grammar is Meta's and re-modelling every variant here would be a second schema
 * to keep in sync. What this function DOES own is the two things that are easy to
 * get silently wrong: `category` is forced to `UTILITY` (the only category this
 * endpoint accepts for this product), and `parameter_format` is sent only when
 * NAMED, because sending `POSITIONAL` explicitly is not documented.
 *
 * Approval is near-instant — Meta: "Receive approval (within seconds of
 * creation)" — so the returned `status` is usually already APPROVED and the
 * caller can send immediately rather than polling.
 */
export async function createUtilityTemplate(
  args: {
    name: string;
    language: string;
    components: unknown[];
    parameterFormat?: UtilityParameterFormat;
  },
  opts: SocialSendTarget,
): Promise<{ id: string; status: string | null; category: string | null }> {
  const res = await graphPostJson(
    `${GRAPH_BASE}/${opts.graphVersion}/${encodeURIComponent(opts.accountId)}/message_templates`,
    opts.accessToken,
    {
      name: args.name,
      language: args.language,
      category: "UTILITY",
      ...(args.parameterFormat === "NAMED" ? { parameter_format: "NAMED" } : {}),
      components: args.components,
    },
    opts.appSecret,
  );
  const id = str(res.id);
  if (!id) throw new Error(`${opts.label} createUtilityTemplate: response missing id`);
  return { id, status: str(res.status), category: str(res.category) };
}

/**
 * Send a utility message.
 *
 * Three things this gets right that a hand-rolled body usually doesn't:
 *
 *  1. `messaging_type: "UTILITY"` — a fourth enum value alongside RESPONSE /
 *     UPDATE / MESSAGE_TAG. Sending a template under `MESSAGE_TAG` does not work.
 *  2. Component types are LOWERCASE here and uppercase at create time. See the
 *     module header.
 *  3. `parameter_name` is emitted for body parameters only when the template is
 *     NAMED, and never for the URL button suffix, which stays positional in both
 *     formats.
 *
 * There is no window check: bypassing the 24-hour window is the entire point of
 * this message type, so the caller must NOT gate it the way a free-form send is
 * gated.
 */
export async function sendUtilityMessage(
  args: {
    to: string;
    templateName: string;
    languageCode: string;
    parameterFormat?: UtilityParameterFormat;
    bodyParameters?: UtilityBodyParameter[];
    buttonParameters?: UtilityButtonParameter[];
    personaId?: string;
  },
  opts: SocialSendTarget,
): Promise<SendTextResult> {
  const named = args.parameterFormat === "NAMED";
  const components: Array<Record<string, unknown>> = [];

  if (args.bodyParameters?.length) {
    components.push({
      type: "body",
      parameters: args.bodyParameters.map((p) => ({
        type: "text",
        text: p.text,
        // Meta: "If your template was created with parameter_format set to
        // NAMED, you must include the parameter_name field in each body
        // parameter." Emitting it on a POSITIONAL template is equally wrong.
        ...(named && p.name ? { parameter_name: p.name } : {}),
      })),
    });
  }

  if (args.buttonParameters?.length) {
    components.push({
      type: "buttons",
      parameters: args.buttonParameters.map((b) =>
        b.type === "POSTBACK"
          ? { type: "POSTBACK", payload: b.payload }
          : // `url` here is the SUFFIX substituted into the template's `{{1}}`,
            // not a full URL — sending a whole URL double-prefixes it.
            { type: "URL", url: b.urlSuffix },
      ),
    });
  }

  const res = await graphPostJson(
    `${GRAPH_BASE}/${opts.graphVersion}/${opts.accountId}/messages`,
    opts.accessToken,
    {
      recipient: { id: args.to },
      messaging_type: "UTILITY",
      ...(args.personaId ? { persona_id: args.personaId } : {}),
      message: {
        template: {
          name: args.templateName,
          language: { code: args.languageCode },
          ...(components.length ? { components } : {}),
        },
      },
    },
    opts.appSecret,
  );
  const messageId = str(res.message_id);
  if (!messageId) {
    throw new Error(`${opts.label} sendUtilityMessage: response missing message_id`);
  }
  return { externalId: messageId, timestamp: new Date() };
}
