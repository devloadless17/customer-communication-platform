import type { TemplateDto } from "@ccp/shared/types";

/**
 * Label helpers shared by every surface that picks templates (templates page,
 * inbox picker, broadcast composer). Labels are the workspace's OWN taxonomy —
 * deduped case-insensitively server-side with first-seen casing preserved — so
 * every comparison here is lowercase, and the vocabulary is DERIVED from the
 * loaded list rather than fetched (no extra endpoint; the list is already in
 * hand everywhere labels are shown).
 */

/** Unique labels across the catalog: case-insensitive identity, first-seen
 *  casing, alphabetical. */
export function templateLabelVocabulary(templates: TemplateDto[]): string[] {
  const seen = new Map<string, string>();
  for (const t of templates) {
    for (const label of t.labels) {
      const key = label.toLowerCase();
      if (!seen.has(key)) seen.set(key, label);
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** Case-insensitive exact membership — the filter-chip predicate. */
export function templateHasLabel(t: TemplateDto, label: string): boolean {
  const key = label.toLowerCase();
  return t.labels.some((l) => l.toLowerCase() === key);
}

/** Case-insensitive substring over the labels — the search-box predicate
 *  (`q` must already be lowercased, matching the callers' search code). */
export function templateLabelsMatchQuery(t: TemplateDto, q: string): boolean {
  return t.labels.some((l) => l.toLowerCase().includes(q));
}

/**
 * The "Recently used" quick row: up to `max` templates actually SENT
 * (`lastUsedAt` non-null), newest first. Shown only when no search/filter is
 * active — a filtered list already says what the operator wants.
 */
export function recentlyUsedTemplates(
  templates: TemplateDto[],
  max = 6,
): TemplateDto[] {
  return templates
    .filter((t) => t.lastUsedAt !== null)
    .sort((a, b) => (a.lastUsedAt! < b.lastUsedAt! ? 1 : -1))
    .slice(0, max);
}
