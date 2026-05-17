import type { Prisma } from "@prisma/client";

/**
 * Per-template variable metadata. Lives on `MessageTemplate.variableBindings`.
 *
 * Meta's templates only know positional `{{1}}, {{2}}, …` placeholders — the
 * service is intentionally dumb about what those values mean. Bindings layer
 * our app's view on top:
 *
 *   - a human-readable **label** so the broadcast form can show "first_name"
 *     instead of "{{1}}".
 *   - a **source** that decides whether the agent fills the value once for
 *     the whole broadcast (`manual`) or the runner pulls it per recipient
 *     from each contact (`contact_field` / `contact_custom_field`).
 *   - a **defaultValue** the runner falls back to when a contact source is
 *     empty or missing — so a contact without an email doesn't get an empty
 *     "{{1}}" sent to them.
 *
 * Layered, not replacing: a template synced from Meta before bindings existed
 * resolves to an empty object and every variable degrades to `manual` — the
 * old broadcast behavior. CLAUDE.md rule #1 (provider abstraction): Meta
 * doesn't see this; only our broadcast runner does.
 */

export type ContactFieldKey = "name" | "phoneNumber" | "email" | "location";

export type VariableSource =
  | { kind: "manual" }
  | { kind: "contact_field"; field: ContactFieldKey }
  | { kind: "contact_custom_field"; key: string };

export interface VariableBinding {
  /** Short human-readable handle ("first_name", "order_id", …). UI-only. */
  label: string;
  source: VariableSource;
  /** Used when the resolved contact value is empty or missing. */
  defaultValue?: string;
}

export interface VariableBindings {
  /** One per body `{{n}}`, in order. Missing entries default to `manual`. */
  body: VariableBinding[];
  /** Single header `{{1}}` if the template's HEADER component has a placeholder. */
  header?: VariableBinding;
}

const EMPTY: VariableBindings = { body: [] };

/**
 * Parse a JSONB column value into a typed VariableBindings record. We're
 * generous on input: anything that doesn't match the shape becomes the empty
 * default so a corrupt row (or one synced before bindings existed) doesn't
 * crash the runner.
 */
export function parseVariableBindings(v: Prisma.JsonValue | null | undefined): VariableBindings {
  if (!v || typeof v !== "object" || Array.isArray(v)) return EMPTY;
  const obj = v as Record<string, unknown>;
  const body = Array.isArray(obj.body)
    ? obj.body.map(parseOne).filter((x): x is VariableBinding => x !== null)
    : [];
  const header = parseOne(obj.header);
  return header ? { body, header } : { body };
}

function parseOne(v: unknown): VariableBinding | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const obj = v as Record<string, unknown>;
  const label = typeof obj.label === "string" ? obj.label : "";
  const source = parseSource(obj.source);
  const defaultValue = typeof obj.defaultValue === "string" ? obj.defaultValue : undefined;
  return { label, source, ...(defaultValue !== undefined ? { defaultValue } : {}) };
}

function parseSource(v: unknown): VariableSource {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { kind: "manual" };
  const obj = v as Record<string, unknown>;
  if (obj.kind === "contact_field") {
    const field = obj.field;
    if (field === "name" || field === "phoneNumber" || field === "email" || field === "location") {
      return { kind: "contact_field", field };
    }
    return { kind: "manual" };
  }
  if (obj.kind === "contact_custom_field") {
    const key = typeof obj.key === "string" ? obj.key : "";
    if (key.length === 0) return { kind: "manual" };
    return { kind: "contact_custom_field", key };
  }
  return { kind: "manual" };
}

/**
 * Resolve one binding against one contact. Returns the literal value the
 * runner should plug into `{{n}}` for this specific send.
 *
 *   - `manual`           → the agent-supplied literal from the broadcast form.
 *   - `contact_field`    → the contact's typed field. Empty falls back to
 *                          the binding's defaultValue, then to the agent
 *                          literal — never an empty string.
 *   - `contact_custom_field` → same fallback chain, looking up
 *                              Contact.customFields[key].
 *
 * Always returns a non-empty string when ANY fallback resolves; returns the
 * agent literal as a last resort even when that's empty so the runner can
 * surface a clear "this variable is blank" error rather than us silently
 * sending `{{1}}` to Meta (which it would reject anyway with code 132000).
 */
export interface ContactLike {
  name: string;
  // Nullable for non-phone channels (Instagram/Telegram). resolveBinding
  // treats null the same as "" — the runner already filters non-phone
  // recipients out of WhatsApp template sends, so binding resolution falling
  // back to empty is the right degraded behavior for the rest.
  phoneNumber: string | null;
  email: string | null;
  location: string | null;
  customFields: Prisma.JsonValue;
}

export function resolveBinding(
  binding: VariableBinding | undefined,
  literal: string,
  contact: ContactLike,
): string {
  // No binding row → behave like manual (the legacy path).
  if (!binding) return literal;
  if (binding.source.kind === "manual") return literal;

  let raw = "";
  if (binding.source.kind === "contact_field") {
    const f = binding.source.field;
    raw =
      f === "name"
        ? contact.name
        : f === "phoneNumber"
          ? contact.phoneNumber ?? ""
          : f === "email"
            ? contact.email ?? ""
            : f === "location"
              ? contact.location ?? ""
              : "";
  } else {
    // contact_custom_field
    const bag =
      contact.customFields && typeof contact.customFields === "object" && !Array.isArray(contact.customFields)
        ? (contact.customFields as Record<string, unknown>)
        : {};
    const v = bag[binding.source.key];
    raw = typeof v === "string" ? v : "";
  }

  raw = raw.trim();
  if (raw.length > 0) return raw;
  if (binding.defaultValue && binding.defaultValue.trim().length > 0) {
    return binding.defaultValue;
  }
  return literal;
}
