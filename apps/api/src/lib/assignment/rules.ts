import type {
  AssignmentContext,
  AssignmentRuleConditions,
} from "@ccp/shared/assignment/types";

/**
 * PURE rule matching — which policy handles this conversation.
 *
 * Semantics, chosen to be the least surprising thing an admin could expect:
 *   - Rules are ordered; the FIRST enabled rule whose conditions all match
 *     wins. No scoring, no "most specific" heuristic — an admin reading the
 *     list top to bottom can predict the outcome exactly.
 *   - Within one rule, every PRESENT clause must match (AND). Within a clause,
 *     any listed value matches (OR). "VIP tag AND WhatsApp" is one rule with
 *     two clauses; "VIP OR Gold" is one clause with two tag ids.
 *   - An absent or empty clause is "don't care", so `{}` is a catch-all.
 *   - A clause whose context field is MISSING fails closed (no match). A rule
 *     must never fire on data the caller couldn't actually see — that's how a
 *     "keyword: refund" rule would otherwise capture every broadcast
 *     assignment, which carries no message text.
 */

/** Narrow untyped JSON off a Prisma `Json` column into the conditions shape.
 *  Anything malformed degrades to a catch-all `{}` rather than throwing —
 *  a corrupt row must not break routing for the whole team. */
export function parseConditions(raw: unknown): AssignmentRuleConditions {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const strList = (v: unknown): string[] | undefined =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && x.length > 0)
      : undefined;
  const out: AssignmentRuleConditions = {};
  const channels = strList(r.channels);
  if (channels?.length) out.channels = channels as AssignmentRuleConditions["channels"];
  const channelAccountIds = strList(r.channelAccountIds);
  if (channelAccountIds?.length) out.channelAccountIds = channelAccountIds;
  const tagIds = strList(r.tagIds);
  if (tagIds?.length) out.tagIds = tagIds;
  const stageIds = strList(r.stageIds);
  if (stageIds?.length) out.stageIds = stageIds;
  const sources = strList(r.sources);
  if (sources?.length) out.sources = sources as AssignmentRuleConditions["sources"];
  const keywords = strList(r.keywords);
  if (keywords?.length) out.keywords = keywords;
  const languages = strList(r.languages);
  if (languages?.length) out.languages = languages;
  if (typeof r.isNewContact === "boolean") out.isNewContact = r.isNewContact;
  return out;
}

export function matchesConditions(
  conditions: AssignmentRuleConditions,
  ctx: AssignmentContext,
): boolean {
  if (conditions.sources?.length && !conditions.sources.includes(ctx.source)) {
    return false;
  }

  if (conditions.channels?.length) {
    if (!ctx.channel) return false; // fail closed
    if (!conditions.channels.includes(ctx.channel)) return false;
  }

  if (conditions.channelAccountIds?.length) {
    // Fail closed, like `channels`: a rule keyed to the Sales number must never
    // fire on a thread whose account we couldn't see.
    if (!ctx.channelAccountId) return false;
    if (!conditions.channelAccountIds.includes(ctx.channelAccountId)) return false;
  }

  if (conditions.tagIds?.length) {
    const tags = ctx.tagIds;
    if (!tags) return false;
    if (!conditions.tagIds.some((id) => tags.includes(id))) return false;
  }

  if (conditions.stageIds?.length) {
    if (!ctx.stageId) return false;
    if (!conditions.stageIds.includes(ctx.stageId)) return false;
  }

  if (conditions.languages?.length) {
    const lang = (ctx.language ?? "").toLowerCase();
    if (!lang) return false;
    // Prefix match so a rule on "en" catches "en-US"/"en_GB" without the admin
    // having to enumerate locale variants.
    if (!conditions.languages.some((l) => lang.startsWith(l.toLowerCase()))) {
      return false;
    }
  }

  if (conditions.keywords?.length) {
    const text = (ctx.messageText ?? "").toLowerCase();
    if (!text) return false;
    if (!conditions.keywords.some((k) => text.includes(k.toLowerCase()))) {
      return false;
    }
  }

  if (typeof conditions.isNewContact === "boolean") {
    if (typeof ctx.isNewContact !== "boolean") return false;
    if (ctx.isNewContact !== conditions.isNewContact) return false;
  }

  return true;
}

export interface MatchableRule {
  id: string;
  name: string;
  policyId: string;
  enabled: boolean;
  position: number;
  conditions: unknown;
}

/**
 * First enabled matching rule, or null. Rules are sorted here rather than
 * relying on the caller's query order so the settings preview (which passes an
 * unsaved draft list) behaves identically to the live path. `id` is the
 * tiebreak so two rules at the same position are still deterministic.
 */
export function pickRule<T extends MatchableRule>(
  rules: readonly T[],
  ctx: AssignmentContext,
): T | null {
  const ordered = [...rules]
    .filter((r) => r.enabled)
    .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const rule of ordered) {
    if (matchesConditions(parseConditions(rule.conditions), ctx)) return rule;
  }
  return null;
}
