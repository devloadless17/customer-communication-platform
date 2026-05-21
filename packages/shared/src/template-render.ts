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
