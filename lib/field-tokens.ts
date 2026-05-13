import type { Prisma } from "@prisma/client";

import type { ContactFieldDefinition } from "@/lib/types";

/**
 * Field-token syntax for per-recipient substitution in user-authored text.
 *
 * Anywhere we accept agent-typed copy that has to be personalized per contact
 * — broadcast variable inputs today, snippet bodies, future automation reply
 * bodies tomorrow — tokens look like `$var.<namespace>.<field>`:
 *
 *   $var.contact.name              → Contact.name
 *   $var.contact.phone             → Contact.phoneNumber
 *   $var.contact.email             → Contact.email (nullable)
 *   $var.contact.location          → Contact.location (nullable)
 *   $var.contact.<custom_field_key> → Contact.customFields[<custom_field_key>]
 *
 * The `$var.` prefix is intentionally distinct from Meta's positional `{{n}}`
 * placeholders so the two systems can coexist inside the same template body
 * without ambiguity. Meta only sees a fully-resolved string — tokens are an
 * app-level concept the runner substitutes before the send.
 *
 * The token surface stays small on purpose: we only expose the bag of fields
 * that a) every contact has and b) the agent already configured at the team
 * level (ContactFieldDefinition). Adding event-context namespaces for
 * automations (e.g. `$var.message.body`) is straightforward — pass an
 * additional context object into `resolveFieldTokens`.
 */

const BUILTIN_KEYS = ["name", "phone", "email", "location"] as const;
type BuiltinKey = (typeof BUILTIN_KEYS)[number];

/**
 * One token the picker UI can offer. `token` is what gets inserted into the
 * text input ("$var.contact.name"); `label` is what the agent sees in the
 * dropdown.
 */
export interface TokenSpec {
  token: string;
  label: string;
  /** "builtin" for Contact's typed fields, "custom" for ContactFieldDefinitions. */
  group: "builtin" | "custom";
}

const BUILTIN_TOKENS: TokenSpec[] = [
  { token: "$var.contact.name", label: "Contact name", group: "builtin" },
  { token: "$var.contact.phone", label: "Phone number", group: "builtin" },
  { token: "$var.contact.email", label: "Email", group: "builtin" },
  { token: "$var.contact.location", label: "Location", group: "builtin" },
];

/**
 * The full list of tokens the picker should show for this team. Built-ins
 * always appear first; custom fields follow in the order admins configured.
 */
export function listAvailableTokens(
  fieldDefinitions: ContactFieldDefinition[],
): TokenSpec[] {
  const customs: TokenSpec[] = fieldDefinitions.map((def) => ({
    token: `$var.contact.${def.key}`,
    label: def.label,
    group: "custom" as const,
  }));
  return [...BUILTIN_TOKENS, ...customs];
}

/**
 * Regex for `$var.contact.<field>`.
 *
 * Word-boundary on the trailing side (`\b`) so adjacent punctuation in
 * normal prose ("Hi $var.contact.name, …") doesn't get sucked into the
 * field name. The lookbehind on the leading side guards against accidental
 * matches inside identifiers like `email$var.contact.name`.
 */
const TOKEN_RE = /(?<![A-Za-z0-9_])\$var\.contact\.([a-z][a-z0-9_]*)\b/g;

/**
 * Strip tokens out of a string and return the unique tokens used. Cheap
 * pre-flight check the broadcast form uses to highlight unknown tokens.
 */
export function extractFieldTokens(text: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  // Reset lastIndex defensively — the regex is module-scope.
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    out.add(m[1]!);
  }
  return Array.from(out);
}

/**
 * Same shape the broadcast runner already passes around — defined here so
 * downstream callers don't have to import the runner just to type a Contact
 * argument.
 */
export interface ContactLike {
  name: string;
  phoneNumber: string;
  // Optional in both senses (DB row uses null; UI Contact dto omits the
  // field entirely when absent). Resolvers fall back to empty string.
  email?: string | null;
  location?: string | null;
  customFields: Prisma.JsonValue;
}

/**
 * Replace every `$var.contact.<field>` in `text` with the matching value from
 * `contact`. Unknown fields resolve to an empty string (NOT left as the raw
 * token) so we never accidentally ship literal "$var.contact.foo" to a
 * customer's WhatsApp. The broadcast form warns about unknown tokens before
 * the agent gets here so this empty-string fallback is mostly a safety net.
 *
 * Tokens are matched case-sensitively (lowercase + underscore only) so a
 * stray "$Var.Contact.Name" stays in the output — that's a typo the agent
 * should fix, not silently rewrite for them.
 */
export function resolveFieldTokens(text: string, contact: ContactLike): string {
  return text.replace(
    /(?<![A-Za-z0-9_])\$var\.contact\.([a-z][a-z0-9_]*)\b/g,
    (_, key: string) => resolveOne(key, contact),
  );
}

function resolveOne(key: string, contact: ContactLike): string {
  if (BUILTIN_KEYS.includes(key as BuiltinKey)) {
    switch (key as BuiltinKey) {
      case "name":
        return contact.name ?? "";
      case "phone":
        return contact.phoneNumber ?? "";
      case "email":
        return contact.email ?? "";
      case "location":
        return contact.location ?? "";
      default:
        return "";
    }
  }
  const bag =
    contact.customFields &&
    typeof contact.customFields === "object" &&
    !Array.isArray(contact.customFields)
      ? (contact.customFields as Record<string, unknown>)
      : {};
  const v = bag[key];
  return typeof v === "string" ? v : "";
}

/**
 * Render the token string with a SAMPLE contact, for the live preview the
 * broadcast form shows under each variable input. Sample values mirror what
 * a real recipient would see for the same token, so what-you-see-is-what-
 * you-send.
 */
export const SAMPLE_CONTACT: ContactLike = {
  name: "Sara Khalil",
  phoneNumber: "15551234567",
  email: "sara@example.com",
  location: "Beirut",
  customFields: {} as Prisma.JsonValue,
};

/**
 * Return the set of token keys in `text` that DON'T resolve against the
 * provided field schema. Used by the form to highlight typos before send.
 */
export function findUnknownTokens(
  text: string,
  fieldDefinitions: ContactFieldDefinition[],
): string[] {
  const valid = new Set<string>([
    ...BUILTIN_KEYS,
    ...fieldDefinitions.map((d) => d.key),
  ]);
  return extractFieldTokens(text).filter((t) => !valid.has(t));
}
