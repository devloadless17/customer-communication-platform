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
