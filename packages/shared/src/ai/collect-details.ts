/**
 * What the AI assistant may ask a customer for, and in what order.
 *
 * `AiAssistantConfig.collectFields` is an ORDERED list of these. Order IS the
 * priority: the assistant asks for the first entry it doesn't already have,
 * one per reply, so an admin who cares more about the email than the location
 * puts the email first. An empty list means the assistant never asks for
 * anything, which is the default.
 *
 * Shared because both halves must agree on the vocabulary: the settings UI
 * renders the picker from it, the save-time validator accepts exactly these
 * targets, and the reply engine routes a collected answer onto its column.
 *
 * PHONE IS DELIBERATELY ABSENT, and this is the load-bearing part of the file.
 * `Contact.phoneNumber` is an unconditional auto-merge strong key
 * (`findExistingCustomerIdByStrongKey`), and a number a customer TYPES is not
 * vendor-verified — a transposed digit or a partner's number would fuse two
 * people into one Customer, exposing one person's threads under the other's
 * profile. §6 permits a strong key only on a vendor-verified identity, so the
 * assistant collects none. Every target below is safe by construction: name is
 * never a key (no fuzzy matching, ever), location is free text, and email is
 * only a key under `trustEmailAsStrongKey`, which this path never sets.
 */

/** A built-in `Contact` column the assistant can fill. */
export const COLLECT_BUILTIN_TARGETS = [
  {
    target: "email",
    label: "Email address",
    /** How the assistant refers to it when asking. */
    noun: "email address",
  },
  { target: "full_name", label: "Full name", noun: "name" },
  { target: "location", label: "Location", noun: "location" },
] as const;

export type CollectBuiltinTarget = (typeof COLLECT_BUILTIN_TARGETS)[number]["target"];

export const COLLECT_BUILTIN_SET: ReadonlySet<string> = new Set(
  COLLECT_BUILTIN_TARGETS.map((t) => t.target),
);

/** One entry in `AiAssistantConfig.collectFields`. */
export interface CollectFieldSpec {
  /** A built-in column, or `custom` for a `ContactFieldDefinition`. */
  target: CollectBuiltinTarget | "custom";
  /** `ContactFieldDefinition.key`. Required when `target` is "custom", ignored otherwise. */
  key?: string;
  /**
   * Optional one-line reason quoted to the customer ("so we can send your
   * receipt"). Blank is fine — the assistant then asks without justifying,
   * which reads better than an invented reason.
   */
  purpose?: string;
}

/**
 * When the assistant makes its first ask on a thread.
 *
 *  - `opening` : in its FIRST reply of a new conversation, up front.
 *  - `natural` : once it has answered what the customer actually came for.
 */
export type CollectTiming = "opening" | "natural";

export const COLLECT_TIMINGS: readonly CollectTiming[] = ["opening", "natural"];

/**
 * The stable identifier for one collectible detail — the key the model names
 * in its reply and the key the per-conversation "already asked" marker uses.
 * Namespaced so a custom field called `email` can never collide with the
 * built-in column.
 */
export function detailKey(spec: CollectFieldSpec): string {
  return spec.target === "custom" ? `custom:${spec.key ?? ""}` : spec.target;
}

/**
 * Parse whatever is in the JSON column into a well-formed list, dropping
 * anything unrecognised. Reading tolerantly (rather than throwing) matters
 * because the column outlives any single deploy: a target removed in a later
 * version must degrade to "don't ask for it", never to a failed reply.
 *
 * Duplicates collapse to the first occurrence, so the ordering stays a strict
 * priority with no repeated asks.
 */
export function parseCollectFields(value: unknown): CollectFieldSpec[] {
  if (!Array.isArray(value)) return [];
  const out: CollectFieldSpec[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const target = typeof row.target === "string" ? row.target : "";
    const key = typeof row.key === "string" ? row.key.trim() : "";
    const purpose = typeof row.purpose === "string" ? row.purpose.trim().slice(0, 200) : "";

    let spec: CollectFieldSpec;
    if (target === "custom") {
      if (!key) continue; // a custom entry naming no field asks for nothing
      spec = { target: "custom", key };
    } else if (COLLECT_BUILTIN_SET.has(target)) {
      spec = { target: target as CollectBuiltinTarget };
    } else {
      continue;
    }
    if (purpose) spec.purpose = purpose;

    const k = detailKey(spec);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(spec);
    if (out.length >= 12) break; // a customer will never answer more than a few
  }
  return out;
}

export function parseCollectTiming(value: unknown): CollectTiming {
  return value === "opening" ? "opening" : "natural";
}
