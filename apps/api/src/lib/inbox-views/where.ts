import type { Prisma } from "@prisma/client";

import type {
  InboxViewFilters,
} from "@ccp/shared/inbox-views/types";

/**
 * Translate a saved view's filter document into a Prisma WHERE fragment.
 *
 * This is the ONLY place a view becomes SQL. The conversation list, the view
 * counts endpoint and the /v1 read all call it, so a view can never mean one
 * thing in the sidebar badge and another in the list — the exact drift that
 * made stage counts disagree with the stage list before they were unified.
 *
 * WHAT THIS RETURNS, AND WHY IT MATTERS: an array of independent predicates,
 * never a single merged object. The caller ANDs them into `where.AND`
 * alongside the keyset clause, the search clause and — critically — the
 * agent's visibility restriction.
 *
 * Merging by spread here would reintroduce a bug this codebase has now shipped
 * twice: object spread is last-wins, so a view filtering `assignedUserId: null`
 * (Unassigned) spread next to a restriction of `assignedUserId: <agent>` SILENTLY
 * DELETES the restriction and shows a scoped agent every unassigned thread in
 * the workspace. As separate AND entries the two are independent predicates
 * that can only ever narrow. See the note in lib/queries/conversations.ts and
 * the `assignment-visibility` memory.
 *
 * `viewerUserId` resolves the `me` assignee. When a view uses `me` and no
 * viewer is supplied (server-to-server: broadcasts, automations, /v1 key
 * without a user), the view matches NOTHING rather than everything — the same
 * loud-failure choice the `mine` preset makes. Silently widening a personal
 * view for a machine caller is the dangerous direction.
 */
export function inboxViewWhereClauses(
  filters: InboxViewFilters,
  viewerUserId?: string,
): Prisma.ConversationWhereInput[] {
  const clauses: Prisma.ConversationWhereInput[] = [];

  // --- Status -------------------------------------------------------------
  // Absent or empty = no opinion. An empty array must NOT become `in: []`,
  // which matches nothing — a view saved with every status box unticked would
  // render an empty inbox rather than everything.
  if (filters.statuses?.length) {
    clauses.push({ status: { in: filters.statuses } });
  }

  // --- Assignee -----------------------------------------------------------
  const assignee = filters.assignee;
  if (assignee && assignee.kind !== "anyone") {
    if (assignee.kind === "unassigned") {
      clauses.push({ assignedUserId: null });
    } else if (assignee.kind === "me") {
      clauses.push(
        viewerUserId
          ? { assignedUserId: viewerUserId }
          : // Deliberately unsatisfiable. See the doc-comment above.
            { id: "__no_match__" },
      );
    } else if (assignee.userIds.length) {
      clauses.push({ assignedUserId: { in: assignee.userIds } });
    }
    // `users` with an empty list falls through as "no opinion" — matching the
    // builder, which treats an empty selection as "anyone".
  }

  // --- Channel ------------------------------------------------------------
  if (filters.channels?.length) {
    clauses.push({ channel: { in: filters.channels } });
  }

  // --- Channel ACCOUNT (which number / Page / handle) ----------------------
  // A separate clause, never merged with the channel one: a view may legitimately
  // name both ("WhatsApp, but only the Sales number"), and ANDing independent
  // predicates is the whole reason this function returns an array.
  if (filters.channelAccountIds?.length) {
    clauses.push({ channelConnectionId: { in: filters.channelAccountIds } });
  }

  // --- Contact stage ------------------------------------------------------
  // `deletedAt: null` for the same reason the stage preset carries it: a
  // tombstoned contact must not be counted by the badge and then be absent
  // from the list.
  if (filters.stageIds?.length) {
    clauses.push({
      contact: { stageId: { in: filters.stageIds }, deletedAt: null },
    });
  }

  // --- Contact tags -------------------------------------------------------
  // Tags live on Contact in this app (one contact = one conversation), so this
  // is a relation filter either way.
  //
  //   any → one nested `some` with an `in` list      (1 predicate)
  //   all → one nested `some` PER TAG                (N predicates)
  //
  // "all" cannot be expressed as a single `some`: `{ some: { id: { in: [a,b] } } }`
  // is satisfied by a contact carrying only `a`. That reads as an AND and
  // behaves as an OR — the classic silent-wrong-results shape.
  if (filters.tagIds?.length) {
    if (filters.tagMatch === "all") {
      for (const tagId of filters.tagIds) {
        clauses.push({ contact: { tags: { some: { id: tagId } } } });
      }
    } else {
      clauses.push({ contact: { tags: { some: { id: { in: filters.tagIds } } } } });
    }
  }

  // --- Triage flags -------------------------------------------------------
  // Reads the denormalized counter, served by the partial index
  // Conversation_workspaceId_openFlag_idx — not a correlated EXISTS over Message ->
  // MessageFlag, which would be the wrong shape against the largest table.
  if (filters.hasOpenFlags) {
    clauses.push({ openFlagCount: { gt: 0 } });
  }

  // --- Unread -------------------------------------------------------------
  if (filters.unreadOnly) {
    clauses.push({ unreadCount: { gt: 0 } });
  }

  return clauses;
}

/**
 * Fold the clauses into one `WhereInput` for callers that just want a
 * predicate (the counts endpoint). Always an `AND` array, never a spread —
 * see above.
 */
export function inboxViewWhere(
  filters: InboxViewFilters,
  viewerUserId?: string,
): Prisma.ConversationWhereInput {
  const clauses = inboxViewWhereClauses(filters, viewerUserId);
  return clauses.length ? { AND: clauses } : {};
}
