# Ticketing

> A **conversation** is the long-lived thread with one contact on one channel — it never fragments.
> A **ticket** is one piece of *work* on that thread, and there are many over time.

The refund raised in March and the delivery question in June are two tickets on one unbroken thread,
each with its own assignee, priority, SLA clock and outcome. That is the entire reason the entity
exists: folding work state onto the conversation would have forced either a fragmented inbox or a
single ever-open thread with no reportable outcomes.

**The inbox is untouched by this.** Its reducers, rooms and fanout keep operating on conversations.
The ticket board is a parallel lens over the same messages, joined by `Message.ticketId`.

---

## 1. The model

```
Contact ──1:1── Conversation ──1:N── Ticket
                     │                  │
                     └──── Message ─────┘   (Message.ticketId)
```

| Column | Why it exists |
|---|---|
| `Ticket.number` | The human-facing id people quote (`#1042`), unique per workspace. Allocated from `TicketNumberCounter` inside the create transaction — the row lock serializes concurrent allocations, `@@unique([workspaceId, number])` is the backstop, and the create path retries on P2002. Gaps are fine; collisions are not. |
| `Conversation.activeTicketId` | The ticket new messages attach to. A single column read on the ingest hot path instead of an ordered scan of the thread's ticket history per message. |
| `Conversation.openTicketCount` | Denormalized non-terminal count, so the inbox badge and filter are a plain column predicate — same rationale as `openFlagCount`, and bumped only on ticket writes (rare), never per message. |
| `Message.ticketId` | **Explicit**, never derived from timestamps against a ticket's open/close range: ticket boundaries move (reopen, merge) and a derived answer would silently rewrite which work a past message belonged to. |

### Lifecycle

```
new ──▶ open ──▶ pending / on_hold ──▶ solved ──▶ closed
 │                                        │
 └── untriaged backlog                    └── reopen window: a follow-up comes back HERE
```

`new` is deliberately distinct from `open`: "nobody has picked this up" is a different problem from
"someone is working it", and only the split makes an untriaged backlog reportable.

---

## 2. Message → ticket routing

At ingest, in the same transaction as the message write:

1. An **active** (non-terminal) ticket on the thread → attach to it.
2. Otherwise a ticket **solved inside `Workspace.ticketReopenWindowHours`** (default **72h**) → reopen it.
3. Otherwise **auto-open** a new ticket — unless `Workspace.ticketAutoOpen` is off, in which case the
   message simply carries no `ticketId`.

**The reopen window is the single most-debatable rule in ticketing.** Too short and one issue becomes
three tickets; too long and a genuinely new question gets buried in resolved work. That is exactly why
it is a per-workspace setting rather than a constant, and why it should be validated against a pilot.

Two deliberate asymmetries:

- **Outbound never reopens.** An agent's follow-up on closed work is not new work.
- **Broadcasts open zero tickets.** The runner writes through `createOutboundMessageIdempotent` alone
  and never reaches `commitOutboundSend`, so a 1k-recipient campaign creates no tickets — the same
  reasoning as the §18 rule keeping audit and workflows off `broadcast.*`. A customer who *replies*
  does open one, via ingest, which is exactly right: the reply is the work, the blast isn't.

Routing is **not** wrapped in a try/catch inside the ingest transaction. A caught error there is false
safety — a failed statement has already poisoned the surrounding Postgres transaction, so every write
after the catch fails anyway. Routing returns `null` (never throws) for every logical miss; it only
throws on infrastructure failure, in which case the message write is failing too and letting it roll
back means Meta redelivers.

---

## 3. Assignment

A ticket's assignee is **independent** of the thread's: a conversation can belong to one agent while a
specific escalation on it belongs to a specialist. Two rules connect them, both fill-empty-only:

- A new ticket **inherits** the conversation's current assignee when the caller names none. Passing
  `assignedUserId: null` explicitly still means unassigned.
- When a conversation is assigned and its active ticket has **no** owner, the ticket gets the same one
  (`fillActiveTicketAssignee`). This exists because of an ordering fact, not a preference:
  auto-assignment runs **detached** in the background tier, after ingest has already opened the ticket.
  Without it, every auto-opened ticket on an auto-assigned thread would sit unassigned forever and the
  board's "Mine" filter would be empty for everyone.

Neither ever **moves** a ticket that already has an owner — §18's "automated assignment never overrides
a human", applied to the ticket.

---

## 4. SLA

`TicketSlaPolicy` holds one commitment per priority. `null` minutes means **no commitment on that leg**
— not zero: nothing is due, so nothing can breach.

- **Due dates are computed at create and STORED**, never derived on read. A workspace can edit its
  policy at any time, and a ticket must keep the commitment it was created under; recomputing on read
  would retroactively breach every open ticket the moment an admin tightened a promise.
- **Pausing shifts, it does not restart.** `on_hold` (and `pending`, per policy) parks the clock;
  leaving pushes both deadlines out by exactly the parked time. Recomputing from scratch on resume
  would hand back a fresh full commitment every time someone bounced a ticket through `on_hold`.
- **A priority change is a new commitment measured from now** — that is what escalating means, and it
  matches what an agent gets in the UI.
- `businessHoursOnly` consumes minutes only inside `Workspace.workHours`, walking forward day by day.
  Off by default, so an org that hasn't configured hours never gets a clock that silently never advances.

The **breach sweeper** (`lib/sweepers/ticket-sla-breach.ts`, 60s) is the only thing that can notice a
deadline passing — a breach is time-based with no request behind it. It runs under the shared sweeper
mutex, is bounded per tick, and writes through a CAS on the not-yet-breached flag, so overlapping ticks
produce **exactly one** breach event per leg. A partner's "SLA missed" webhook firing every 60 seconds
until someone answers would be worse than not firing at all.

Its scan is served by two **partial indexes** Prisma cannot express, created in raw SQL by migration
`20260722190000_ticketing` — they cover only rows that can still breach (non-terminal, not already
flagged, with a due date), which is a tiny fraction of the table.

---

## 5. Events & realtime

**One** `ticket.changed` domain event with an `action` discriminator, not ten near-identical events —
the same call as `message.flag_changed`, for the same reason: every subscriber needs the same payload
and branches on the transition, so ten names would be ten fanout rules and ten webhook subscriptions
describing one thing.

`action` is always the **TRANSITION**, never merely the post-state (`created` · `assigned` ·
`status_changed` · `priority_changed` · `reopened` · `solved` · `closed` · `sla_breached` · `updated`).
This is the lesson message flags learned the hard way: deriving the action from the final status both
duplicated audit rows and lost every reopen.

The socket frame `ticket:changed` is **workspace-room scoped**, unlike `message:flag`. The board is a
workspace-wide view of work across threads whose `conv:` rooms nobody has joined, so a
conversation-room frame would leave every card stale until a refetch. Ticket writes are agent- or
lifecycle-driven (never per-message), so the team-room cost is right — same call as `message:updated`.

Four ticket boundaries cross over into the **conversation** timeline as inline pills (`ticket_opened`,
`ticket_solved`, `ticket_reopened`, `ticket_closed`). The full history lives on `TicketEvent`; putting
all of it in the thread would drown it. The pills are written inside the ticket transaction rather than
by the audit subscriber, because a thread showing "solved" for a ticket that rolled back is worse than
no pill at all.

---

## 6. Surfaces

| Surface | Where |
|---|---|
| Board / list / detail | `apps/web/src/app/(app)/tickets/` |
| Admin configuration | `apps/web/src/app/(app)/settings/tickets/` |
| Internal REST | `apps/api/src/tickets/` (agent-level) + `/api/team/tickets/*` (admin) |
| External API | `/v1/tickets`, `/v1/tickets-settings`, `/v1/ticket-sla`, `/v1/ticket-fields` — scopes `read:tickets` / `write:tickets`; documented in [organization-api.md](organization-api.md) **and** `/docs/api` |
| Outbound webhook | `ticket.changed` |
| Workflow steps | `create_ticket`, `set_ticket_status`, `set_ticket_priority`, `assign_ticket` |
| Domain | `apps/api/src/lib/tickets/` — the ONLY place a `Ticket` row is written |

Every surface goes through `lib/tickets/mutations.ts`, so a workflow-driven change is indistinguishable
downstream from an agent's: same CAS, same counters, same events.

**Concurrency**: `Ticket.version` is an optimistic-concurrency token. Two agents dragging the same card
is the normal case here, not the exotic one. UI and `/v1` callers send `expectedVersion` and get a
`409 version_conflict` instead of clobbering; automation omits it deliberately — it has no stale view
to protect, and failing a workflow step over a race it can't see helps nobody.

---

## 7. Custom fields and tags

- **Tags are reused** from the contact taxonomy (`Tag`, `_TicketTags`). An org that already colour-codes
  "VIP" and "billing" should not maintain a second parallel list.
- **Fields are not.** `TicketFieldDefinition` mirrors `ContactFieldDefinition` rather than sharing it:
  a contact field describes a *person* and lives forever, a ticket field describes one piece of work,
  and the vocabularies diverge immediately ("company size" vs "root cause"). Sharing would put every
  contact field on every ticket form.

A field's `key` is derived from its label once and is then **immutable** — `Ticket.customFields` is
keyed by it. Deleting a definition leaves stored values in place (history on closed work); they just
stop rendering.

---

## 8. Not built yet

- **Ticket workflow *triggers*** (`ticket_created` / `ticket_status_changed` / `ticket_sla_breached`).
  The steps exist; firing a workflow *from* a ticket change does not.
- **Ticket-aware assignment *routing*** — a `buildTicketAssignmentContext` that counts non-terminal
  tickets per agent rather than open conversations. Today tickets inherit the thread's routing decision.
- **An inbox contact-panel ticket rail** (the reverse link; the denormalized `openTicketCount` is
  already there for it).
- **Merge** — `TicketEventKind.merged` is reserved, nothing writes it.
