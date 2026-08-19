import type { Prisma } from "@prisma/client";

/**
 * Strip deleted ids out of every saved view in a workspace.
 *
 * WHY THIS EXISTS. A view's criteria are a JSON document, so the database
 * cannot enforce that a referenced tag / stage / account / field / user still
 * exists. When one is deleted the FK cascade takes the real rows and leaves a
 * DANGLING id inside `InboxView.filters`, which `inboxViewWhereClauses` turns
 * into a predicate that can never match — a SHARED view renders an empty inbox
 * for the whole workspace with nothing on screen explaining why. The tag delete
 * has scrubbed since the feature shipped; every other catalog delete did not
 * (audit 2026-08-19), so the scrub lives here and each deleting path calls it.
 *
 * The rule is `INBOX_VIEW_DANGLING_POLICY` ("drop", stated once in
 * @ccp/shared/inbox-views/types): remove the id from its field, and if that
 * empties the field DELETE THE KEY rather than leaving `[]` behind. An absent
 * key is what "no opinion" means everywhere else in the document, while an
 * empty list is one careless `?.length` away from meaning "match nothing".
 *
 * Call it in the SAME transaction as the delete wherever one exists — a scrub
 * that commits separately can be lost while the delete stands.
 */

/** Narrow enough to accept an interactive tx client or the Prisma singleton. */
export type ScrubViewsDb = Pick<Prisma.TransactionClient, "inboxView">;

export interface ViewReferenceScrub {
  tagIds?: string[];
  stageIds?: string[];
  /** `ChannelConnection.id`s — a disconnected number / Page / handle. */
  channelAccountIds?: string[];
  /** `ContactFieldDefinition.key`s — a `fields[]` entry naming one is dropped whole. */
  fieldKeys?: string[];
  /**
   * `ContactFieldOption.id`s — removing ONE option of a surviving select field.
   * The entry stays (its field still exists); only the dead option leaves its
   * `optionIds`, and the entry drops when that empties, because an entry with
   * no options selected is a predicate that matches nothing.
   */
  fieldOptionIds?: string[];
  /** Removed from `assignee.userIds`; the assignee is dropped when it empties. */
  userIds?: string[];
}

export async function scrubViewReferences(
  db: ScrubViewsDb,
  workspaceId: string,
  refs: ViewReferenceScrub,
): Promise<void> {
  const tagIds = new Set(refs.tagIds ?? []);
  const stageIds = new Set(refs.stageIds ?? []);
  const accountIds = new Set(refs.channelAccountIds ?? []);
  const fieldKeys = new Set(refs.fieldKeys ?? []);
  const fieldOptionIds = new Set(refs.fieldOptionIds ?? []);
  const userIds = new Set(refs.userIds ?? []);
  if (
    tagIds.size === 0 &&
    stageIds.size === 0 &&
    accountIds.size === 0 &&
    fieldKeys.size === 0 &&
    fieldOptionIds.size === 0 &&
    userIds.size === 0
  ) {
    return;
  }

  const views = await db.inboxView.findMany({
    where: { workspaceId },
    select: { id: true, filters: true },
  });
  for (const view of views) {
    const filters = view.filters as Record<string, unknown> | null;
    if (!filters) continue;
    const next: Record<string, unknown> = { ...filters };
    let changed = false;

    // `tagMatch` goes with `tagIds` — a lone "all" would otherwise linger and
    // read as a filter in the summary line.
    changed = scrubIdList(next, "tagIds", tagIds, ["tagMatch"]) || changed;
    changed = scrubIdList(next, "stageIds", stageIds) || changed;
    changed = scrubIdList(next, "channelAccountIds", accountIds) || changed;
    changed = scrubFields(next, fieldKeys, fieldOptionIds) || changed;
    changed = scrubAssignee(next, userIds) || changed;

    if (!changed) continue;
    await db.inboxView.update({
      where: { id: view.id },
      data: { filters: next as Prisma.InputJsonValue },
    });
  }
}

/** Non-string entries are left alone — the schema owns validation, not this. */
function scrubIdList(
  doc: Record<string, unknown>,
  key: string,
  removed: Set<string>,
  alsoDropWhenEmpty: string[] = [],
): boolean {
  if (removed.size === 0) return false;
  const current = doc[key];
  if (!Array.isArray(current)) return false;
  const remaining = current.filter((v) => typeof v !== "string" || !removed.has(v));
  if (remaining.length === current.length) return false;
  if (remaining.length > 0) {
    doc[key] = remaining;
  } else {
    delete doc[key];
    for (const k of alsoDropWhenEmpty) delete doc[k];
  }
  return true;
}

/**
 * A `fields[]` entry is keyed by field, so a deleted DEFINITION drops it whole.
 * A deleted OPTION is narrower: the field survives, so the entry survives with
 * that option removed — and drops only if it was the last one, since an entry
 * whose `optionIds` is empty is a predicate that can never match.
 */
function scrubFields(
  doc: Record<string, unknown>,
  keys: Set<string>,
  optionIds: Set<string>,
): boolean {
  if (keys.size === 0 && optionIds.size === 0) return false;
  const current = doc.fields;
  if (!Array.isArray(current)) return false;
  let touched = false;
  const remaining: unknown[] = [];
  for (const entry of current) {
    const f = entry as { key?: unknown; optionIds?: unknown } | null;
    const k = f?.key;
    if (typeof k === "string" && keys.has(k)) {
      touched = true;
      continue;
    }
    if (optionIds.size > 0 && Array.isArray(f?.optionIds)) {
      const keptOptions = f.optionIds.filter(
        (o) => typeof o !== "string" || !optionIds.has(o),
      );
      if (keptOptions.length !== f.optionIds.length) {
        touched = true;
        // Last option gone ⇒ the entry can no longer match anything; drop it.
        if (keptOptions.length === 0) continue;
        remaining.push({ ...f, optionIds: keptOptions });
        continue;
      }
    }
    remaining.push(entry);
  }
  if (!touched) return false;
  if (remaining.length > 0) doc.fields = remaining;
  else delete doc.fields;
  return true;
}

/**
 * Only the `users` variant names people. Dropping the whole assignee when it
 * empties is the same "absent = no opinion" call as the id lists: the builder
 * already treats `users` with an empty list as "anyone", so this just makes the
 * document say what it means.
 */
function scrubAssignee(doc: Record<string, unknown>, userIds: Set<string>): boolean {
  if (userIds.size === 0) return false;
  const assignee = doc.assignee as { kind?: unknown; userIds?: unknown } | null;
  if (!assignee || assignee.kind !== "users" || !Array.isArray(assignee.userIds)) return false;
  const remaining = assignee.userIds.filter(
    (u) => typeof u !== "string" || !userIds.has(u),
  );
  if (remaining.length === assignee.userIds.length) return false;
  if (remaining.length > 0) doc.assignee = { ...assignee, userIds: remaining };
  else delete doc.assignee;
  return true;
}
