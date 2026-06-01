// Canonical home for `normalizeStringMap`, which had drifted into 7 byte-for-
// byte copies (workflows steps, dispatcher, contacts, external-v1). Coerce an
// `unknown` JSON value into a flat string→string map, dropping any non-string
// values and non-object inputs. Used for `Contact.customFields` and workflow
// metadata where the column is JSONB but the contract is string-valued.
export function normalizeStringMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
