import type { Filter } from "@/features/inbox/components/inbox-controls";

/**
 * THE identity of "what list am I looking at".
 *
 * Anything keyed on this resets when the visible set of conversations changes:
 * the bulk-selection set, and the keyboard cursor. Both are dangerous when they
 * survive a change they should not have.
 *
 * WHY THIS IS ITS OWN FUNCTION. The key used to be built inline from `filter`
 * alone, and the account narrow is a SECOND, independent dimension that lives
 * in the filter context rather than in `filter`. Switching Sales → Support
 * therefore produced a byte-identical key, so neither reset fired: the
 * checkboxes kept ids for rows no longer on screen while the header still read
 * "5 selected", and `bulkDelete()` posts exactly those ids to
 * `/api/conversations/bulk` — which removes every message and note on them and
 * says so in the confirm dialog ("This can't be undone"). An agent narrowing to
 * Support and clicking delete would irreversibly destroy Sales threads they
 * could not see.
 *
 * `docs/channel-accounts.md` §6 already stated the rule — *"the account narrow
 * is ANDed, never merged, and must be part of `filterKey` or it silently does
 * nothing"* — so this exists to make the rule executable rather than
 * remembered. Every future filter dimension belongs HERE, not inline at a call
 * site, for exactly the reason the account one was missed.
 */
export function conversationFilterKey(filter: Filter, accountId?: string | null): string {
  const base =
    filter.kind === "preset"
      ? `p:${filter.id}`
      : filter.kind === "stage"
        ? `s:${filter.stageId}`
        : "calls";
  // Always append the account segment, even when absent — a key that changes
  // SHAPE between "no account" and "an account" is harder to reason about than
  // one that always has the slot.
  return `${base}|a:${accountId ?? ""}`;
}
