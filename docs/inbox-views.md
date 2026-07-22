# Saved inbox views

> A **view** is a named, reusable filter over the conversation list.
> The six built-in presets answer *"what state is this thread in"*.
> A view answers *"which slice of work is mine to look at"*.

"Support · unassigned · WhatsApp". "VIP escalations". "Arabic leads in
Qualified". Respond.io calls these Team Inbox / Custom Inbox.

```
InboxView ── name · icon · colour · visibility · position
   └─ filters (JSON)  →  lib/inbox-views/where.ts  →  Prisma WHERE
```

---

## 1. Why the criteria are one JSON document

Every criterion is optional and orthogonal, and the set will grow (ticket
status, SLA breach, custom fields). As columns that is a migration per
criterion and a wide sparse table. As one validated document it is a single Zod
schema and a single WHERE builder — **and both are shared with `/v1`**, which is
what makes the parity rule real rather than a second implementation that
drifts.

The cost accepted: the database cannot enforce that a referenced tag, stage or
user still exists. That is handled at read time — see §4.

`{}` is a legal document meaning "every conversation". An **absent** field is
"no opinion"; an **empty array** is normalised away at save time, because
`in: []` matches nothing and a view saved with every box unticked must show
everything, not an empty inbox.

## 2. Visibility is a read boundary

| | Who sees it | Who may edit it |
|---|---|---|
| `personal` | only its creator | only its creator |
| `shared` | everyone in the workspace | holders of `inboxViews:manageShared` |

Every read is `shared OR (personal AND mine)` expressed as one OR inside the
workspace-scoped `where` — never "fetch all, filter in JS". A personal view
names the teammates and tags one agent watches; that is not another agent's
business. An id that isn't visible returns **404, not 403** — a 403 confirms it
exists.

`isEditable` is computed server-side and sent on the wire. The rule depends on
capabilities the client would otherwise re-derive, and a wrong guess renders an
edit button that 403s. Every mutation re-checks regardless; the flag only
decides what to draw.

**Saving a personal view is never gated.** It is an agent organising their own
work, like a bookmark. Only the team-visible kind needs a capability, and it
defaults to `false` for agents — a shared view appears in every teammate's
sidebar, so the conservative default is the one an admin can loosen rather than
one they discover after the rail fills up.

An **API key is not a person**: it sees shared views only, cannot own a
personal one (`inbox_view_requires_user`), and a view whose assignee is `me`
matches *nothing* for it rather than silently widening to everyone.

Name uniqueness is enforced by two **partial** unique indexes (raw SQL —
Prisma can't express a conditional unique): shared names are unique per
workspace, personal names per person, both on `lower(name)`.

## 3. Composing with the agent-visibility restriction

`inboxViewWhereClauses` returns an **array of independent predicates**, never a
merged object, and callers AND them into `where.AND`.

This is not stylistic. Object spread is last-wins, so a view filtering
`assignedUserId: null` (Unassigned) spread next to a restriction of
`assignedUserId: <agent>` **silently deletes the restriction** and shows a
scoped agent every unassigned thread in the workspace. That bug has shipped
twice in this codebase (see the `assignment-visibility` memory and the note in
`lib/queries/conversations.ts`). Inside `AND` the two are independent
predicates that can only ever narrow: the pair is unsatisfiable, which is the
correct answer.

Pinned by `apps/api/test/inbox-views.spec.ts` → *"CANNOT escape the
agent-visibility restriction"*.

One more shape worth knowing: `tagMatch: "all"` expands to **one clause per
tag**. A single `some: { id: { in: [a, b] } }` is satisfied by a contact
carrying only `a` — it reads as AND and behaves as OR.

## 4. Dangling references widen, they don't empty

A filter referencing a deleted tag / stage / user has the dead id **dropped**,
and if that empties the field the field becomes absent.

The alternative — matching nothing — silently empties a view when an admin
deletes one tag of five, and reads as "the inbox is broken" with no clue why.
Dropping widens the view instead, which is visible and recoverable by editing
it. Resolution runs in `InboxViewsService.resolveFilters`, on both the list and
the counts path, so a badge can never disagree with the list it labels.

## 5. Counts are a separate endpoint, on a slower cadence

`GET /api/inbox-views/counts` is deliberately **not** folded into
`/conversations/counts`, which serves the six presets.

- **Cost.** Presets are a fixed 11 queries. Views are capped at 30 per scope ×
  2. Folding them in would make the preset badges — the ones that must move the
  instant *you* close a thread — pay for whatever filters the team saved.
- **Cadence.** Preset counts are feedback on your own action. View counts are
  ambient. The client coalesces them on a ~2.5s window and the server cache TTL
  matches, so a busy workspace pays one round every few seconds regardless of
  message volume, instead of one per inbound message per agent.

The sharing trick from `ConversationsService.teamCounts` is applied **per
view**: a view that never says `me` produces the same number for every agent,
so one query serves the whole team. Only `me` views are counted per viewer, and
the cache key includes the visibility scope — keyed by workspace alone, a
restricted agent would read an unrestricted teammate's cached total, a leak no
WHERE clause can catch because the query never runs.

Unlike the preset cache (keyed by workspace, so bounded by tenant count), this
one is keyed by the filter **document**, so every edit mints a key never looked
up again. It prunes expired entries above 2,000.

## 6. The client mirror

`matchesInboxViewFilters` (in `@ccp/shared`) lets the inbox decide, without a
refetch, whether a row that just changed still belongs in the active view. It
**must mirror** `inboxViewWhereClauses`; if they disagree, a row appears
optimistically and vanishes on the next page — the flickering-row class of bug.

When the client can't decide — a row from a route that skips the tag JOIN, so
`tagIds` is `undefined` — it **excludes**. A wrongly-admitted row is visible
wrongness that survives until the next page load; a wrongly-excluded one is
corrected by the very next refetch.

The active view's id lives in the same `inbox-filter` cookie as the presets
(`v:<id>`), and the layout re-validates it against the views it actually
loaded — a view deleted, or un-shared, by someone else would otherwise make
every list request 404 with no way to recover but clearing cookies. Deleting
the *active* view falls back to the default preset for the same reason.

## 7. Not built yet

- Drag-to-reorder in the rail (the API — `POST /inbox-views/reorder` — and the
  `position` column exist; the sidebar renders saved order but has no drag
  handle).
- Filtering on ticket status / SLA breach, and on contact custom fields.
- A per-view default sort (the list is always recency-keyset today).
