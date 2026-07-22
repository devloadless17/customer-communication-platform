/**
 * WhatsApp template placeholder rendering — SINGLE SOURCE OF TRUTH.
 *
 * Used by the server (send-template-internal + broadcast-runner, which store
 * the RENDERED body on the message row) and the client (the reply-box
 * optimistic preview + the template picker). Keeping one copy means the
 * optimistic bubble can't drift from what actually gets persisted/sent — the
 * same reason `mediaPreviewLabel` lives in shared.
 */

/**
 * Render a template body for preview/storage by substituting `{{n}}`
 * placeholders with positional values. Missing/empty positions are left as
 * `{{n}}` so an agent can spot the one they forgot before sending.
 */
export function renderTemplateBody(text: string, vars: string[]): string {
  return text.replace(/\{\{(\d+)\}\}/g, (_match, idxStr) => {
    const idx = Number(idxStr) - 1;
    const v = vars[idx];
    return v && v.length > 0 ? v : `{{${idxStr}}}`;
  });
}

/**
 * Highest `{{n}}` placeholder index in a template body (0 if none). Drives
 * variable-count validation. Ignores gaps — `"Hi {{1}}, see {{3}}"` returns 3,
 * matching Meta's rule that you must supply 1..N consecutively.
 */
export function countTemplatePlaceholders(text: string): number {
  let max = 0;
  const re = /\{\{(\d+)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/**
 * Placeholder names of a NAMED-format template body (`parameter_format: NAMED`,
 * `"Hi {{name}}, order {{order_id}} shipped"` → `["name", "order_id"]`), in
 * first-appearance order and de-duplicated.
 *
 * A named placeholder starts with a letter or underscore, which is exactly what
 * distinguishes it from the positional `{{1}}` form — so the two counters never
 * both fire on the same body. Without this, a NAMED body scored 0 positional
 * placeholders, validation happily accepted zero variables, and Meta rejected
 * the send for missing body parameters with nothing actionable in the error.
 */
export function templateNamedPlaceholders(text: string): string[] {
  const seen = new Set<string>();
  const re = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    if (name) seen.add(name);
  }
  return [...seen];
}

/**
 * Render a NAMED-format body for preview/storage. Unsupplied names are left as
 * `{{name}}`, mirroring {@link renderTemplateBody}'s positional behavior.
 */
export function renderTemplateBodyNamed(
  text: string,
  vars: ReadonlyArray<{ name: string; text: string }>,
): string {
  const byName = new Map(vars.map((v) => [v.name, v.text]));
  return text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (match, name: string) => {
    const v = byName.get(name);
    return v && v.length > 0 ? v : match;
  });
}

/** A send-time parameter a template's BUTTONS component demands. */
export interface RequiredTemplateButtonParam {
  index: number;
  subType: "url" | "copy_code";
}

/**
 * Which buttons on a template REQUIRE a send-time parameter, read from the
 * `components` array exactly as Meta returned it.
 *
 * Only two button kinds are unambiguous:
 *   - a URL button whose url contains a `{{n}}` suffix placeholder, and
 *   - a COPY_CODE (coupon) button.
 * Both are rejected by Meta when sent without their parameter, so surfacing them
 * up front strictly improves on the status quo.
 *
 * QUICK_REPLY is deliberately NOT reported: its payload is optional on the wire,
 * and demanding one would break templates that send correctly today. Static URL
 * buttons (no placeholder) carry no parameter either.
 */
export function requiredTemplateButtonParams(components: unknown): RequiredTemplateButtonParam[] {
  if (!Array.isArray(components)) return [];
  const required: RequiredTemplateButtonParam[] = [];
  for (const raw of components) {
    if (typeof raw !== "object" || raw === null) continue;
    const comp = raw as { type?: unknown; buttons?: unknown };
    if (typeof comp.type !== "string" || comp.type.toUpperCase() !== "BUTTONS") continue;
    if (!Array.isArray(comp.buttons)) continue;
    comp.buttons.forEach((b, index) => {
      if (typeof b !== "object" || b === null) return;
      const btn = b as { type?: unknown; url?: unknown };
      const type = typeof btn.type === "string" ? btn.type.toUpperCase() : "";
      if (type === "COPY_CODE") {
        required.push({ index, subType: "copy_code" });
      } else if (type === "URL" && typeof btn.url === "string" && btn.url.includes("{{")) {
        required.push({ index, subType: "url" });
      }
    });
  }
  return required;
}

// ---------------------------------------------------------------------------
// Meta field limits.
// ---------------------------------------------------------------------------

/**
 * The hard limits Meta enforces on a template's components, from the WhatsApp
 * Business "Template fundamentals" documentation.
 *
 * Enforced BEFORE the Graph call rather than letting Meta reject: a rejection
 * arrives as an opaque `#100 Invalid parameter` with no field name, so an
 * author who pasted a 1,200-character body learns only that "something" was
 * wrong. Checking here names the field and the number.
 *
 * These are Meta's numbers, not ours — do not tighten them to be "safe". A
 * limit stricter than the provider's silently blocks templates that would have
 * been accepted, which is indistinguishable from a bug.
 */
export const TEMPLATE_LIMITS = {
  /** `^[a-z0-9_]{1,512}$` — lowercase, digits and underscores only. */
  nameMaxLength: 512,
  bodyMaxLength: 1024,
  headerMaxLength: 60,
  footerMaxLength: 60,
  buttonTextMaxLength: 25,
  /** Quick-reply button labels are capped tighter than CTA labels. */
  quickReplyTextMaxLength: 25,
  maxQuickReplyButtons: 10,
  maxCallToActionButtons: 2,
  maxButtons: 10,
} as const;

export const TEMPLATE_NAME_PATTERN = /^[a-z0-9_]{1,512}$/;

export interface TemplateValidationIssue {
  /** `body` · `header` · `footer` · `name` · `buttons` — the field to highlight. */
  field: string;
  message: string;
}

interface ValidatableComponent {
  type?: string;
  format?: string;
  text?: string;
  buttons?: Array<{ type?: string; text?: string }>;
}

/**
 * Check a template's name + components against Meta's limits.
 *
 * Pure, so the create form and the API share ONE definition of the rules — the
 * counter under the textarea and the server's rejection can't disagree about
 * what "too long" means.
 *
 * Returns every issue rather than the first, so an author fixes one form pass
 * instead of playing whack-a-mole with a 400 per field.
 */
export function validateTemplateComponents(
  name: string,
  components: ReadonlyArray<unknown>,
): TemplateValidationIssue[] {
  const issues: TemplateValidationIssue[] = [];

  if (!TEMPLATE_NAME_PATTERN.test(name)) {
    issues.push({
      field: "name",
      message:
        "Name must be lowercase letters, digits and underscores only (up to 512 characters).",
    });
  }

  const comps = components.filter(
    (c): c is ValidatableComponent => Boolean(c) && typeof c === "object",
  );

  const body = comps.find((c) => c.type === "BODY");
  if ((body?.text?.length ?? 0) > TEMPLATE_LIMITS.bodyMaxLength) {
    issues.push({
      field: "body",
      message: `Body is ${body!.text!.length} characters — the limit is ${TEMPLATE_LIMITS.bodyMaxLength}.`,
    });
  }

  const header = comps.find((c) => c.type === "HEADER");
  // Only a TEXT header has a length limit; media headers carry no text.
  if (header?.format === "TEXT" && (header.text?.length ?? 0) > TEMPLATE_LIMITS.headerMaxLength) {
    issues.push({
      field: "header",
      message: `Header is ${header.text!.length} characters — the limit is ${TEMPLATE_LIMITS.headerMaxLength}.`,
    });
  }

  const footer = comps.find((c) => c.type === "FOOTER");
  if ((footer?.text?.length ?? 0) > TEMPLATE_LIMITS.footerMaxLength) {
    issues.push({
      field: "footer",
      message: `Footer is ${footer!.text!.length} characters — the limit is ${TEMPLATE_LIMITS.footerMaxLength}.`,
    });
  }

  const buttons = comps.find((c) => c.type === "BUTTONS")?.buttons ?? [];
  if (buttons.length > TEMPLATE_LIMITS.maxButtons) {
    issues.push({
      field: "buttons",
      message: `A template can have at most ${TEMPLATE_LIMITS.maxButtons} buttons.`,
    });
  }
  const quickReplies = buttons.filter((b) => b.type === "QUICK_REPLY");
  if (quickReplies.length > TEMPLATE_LIMITS.maxQuickReplyButtons) {
    issues.push({
      field: "buttons",
      message: `At most ${TEMPLATE_LIMITS.maxQuickReplyButtons} quick-reply buttons.`,
    });
  }
  const ctas = buttons.filter((b) => b.type === "URL" || b.type === "PHONE_NUMBER");
  if (ctas.length > TEMPLATE_LIMITS.maxCallToActionButtons) {
    issues.push({
      field: "buttons",
      message: `At most ${TEMPLATE_LIMITS.maxCallToActionButtons} call-to-action buttons (URL or phone).`,
    });
  }
  for (const [i, b] of buttons.entries()) {
    if ((b.text?.length ?? 0) > TEMPLATE_LIMITS.buttonTextMaxLength) {
      issues.push({
        field: "buttons",
        message: `Button ${i + 1} label is ${b.text!.length} characters — the limit is ${TEMPLATE_LIMITS.buttonTextMaxLength}.`,
      });
    }
  }

  return issues;
}
