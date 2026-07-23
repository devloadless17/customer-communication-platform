# Assignment routing

How a conversation gets an owner. Engine internals live in
[apps/api/src/lib/assignment/README.md](../apps/api/src/lib/assignment/README.md);
this file is the product-level picture.

---

## The shape of it

```
Trigger (new chat · AI escalation · workflow · campaign · rebalance)
    ↓
Routing rules   — first match wins  →  a POLICY
    ↓
Policy          — strategy · eligibility · shares · limits · overflow
    ↓
assignConversation()  — the same mutation the inbox uses
    ↓
conversation.assigned → realtime · audit · analytics · workflows · webhooks
```

Three separate questions, deliberately kept apart because admins change them at
different times and for different reasons:

| Question | Answered by | Configured in |
|---|---|---|
| **How** do we pick someone? | `AssignmentPolicy` | Settings → Assignment → Policies |
| **Which** policy applies here? | `AssignmentRule` | → Routing rules |
| **When** does routing run at all? | `AssignmentSettings` | → When it runs |

---

## Policies

A policy is a named strategy: *"Support — weighted"*, *"Escalations — senior
pool"*. Every team has exactly one **default** (the fallback when no rule
matches) and may have up to 50.

**Strategy** — how to pick among eligible, under-limit candidates:

| | Behavior |
|---|---|
| `least_busy` *(default)* | Fewest open conversations wins; ties rotate. Self-balances when chats run different lengths. **This is the historical algorithm** — every team's seeded default policy reproduces it exactly. |
| `round_robin` | Strict turn-taking; load ignored. Predictable, but an agent stuck on long chats keeps receiving new ones. |
| `weighted` | Proportional share. Ali 50 / Sara 20 means Ali takes 5 for every 2 Sara takes — **exactly**, over time. Deficit round-robin on `served / weight`, so it's deterministic and verifiable, not a random draw. |
| `fixed` | One person. |
| `manual` | Never auto-assigns. The supported way to say *"escalate, but leave it in the queue"*. |

**Eligibility** — who's a candidate:

| | Behavior |
|---|---|
| `online_first` *(default)* | online+available → available → anyone active. Never lands nowhere. |
| `online_only` | Strict. Nobody connected → the triage queue, not an agent who went home. |
| `available_only` | Trusts the availability status, ignores sockets. |
| `any_active` | Ignores presence and availability entirely. |

> **Working hours are already covered.** `User.availabilityStatus` is the
> *effective* status — the working-hours sweeper drives it — so an off-shift
> agent is excluded by the availability tiers without a second schedule
> evaluation.

**Membership** — `includeAllMembers: true` (default) means everyone is in and a
member row is per-person *tuning* (share, limit, opt-out). Set it false and only
members with an enabled row take part — an explicit squad. `eligibleRoles`
narrows further (e.g. agents only, no managers).

**Capacity** — `defaultMaxOpen` caps concurrent open conversations per person,
overridable per member. When everyone eligible is full, `overflow` decides:
leave it in the triage queue (default), ignore the caps, or hand it to a
fallback person.

---

## Routing rules

Checked top to bottom; the **first enabled rule whose conditions all match**
picks the policy. No scoring, no "most specific" heuristic — an admin reading the
list in order can predict the outcome exactly.

Within a rule every filled-in clause must match (AND); within a clause any value
matches (OR). Clauses: `channels`, `tagIds`, `stageIds`, `languages` (prefix
match), `keywords` (case-insensitive substring), `isNewContact`, `sources`.

**A clause whose context is missing fails closed.** A `keywords` rule can't fire
on a campaign assignment, which carries no message text — otherwise a rule for
"refund" would silently capture every broadcast.

---

## When routing runs

Everything ships **OFF** except deactivation rebalance, so the feature changed
nothing on deploy.

| Setting | Default | What it does |
|---|---|---|
| `autoAssignOnNewConversation` | off | Route a brand-new conversation on its first inbound. |
| `skipWhenAiHandling` | **on** | The AI-first switch: while the assistant is answering, don't spend an agent's capacity. A human arrives when the AI escalates. Turn it off to give every conversation a named owner from message one. |
| `autoAssignOnReopen` | off | Route an existing **unassigned** thread when a new message arrives (reopened, or deliberately unassigned). |
| `reassignOnOffline` | off | Move work off agents who disconnect, after a grace window. |
| `reassignOfflineOnlyPending` | on | Only threads no agent has replied to yet — never yank someone out of a live exchange. |
| `reassignOnDeactivate` | **on** | A deactivated teammate's open conversations are re-routed immediately. |
| `aiHandoffPolicyId` | null | Pin AI escalations to a policy; null = follow the routing rules. |

---

## The invariants

**Automation never takes a conversation from a human.** Every automated caller
passes `onlyIfUnassigned`, so automation only fills an EMPTY assignee slot. This
is also what makes the whole surface idempotent under at-least-once event
delivery — a redelivered webhook can't reassign anything.

Two admin-configured exceptions, both deliberate:
- **AI handoff** — an escalation is a re-route by definition; a thread carrying a
  stale owner from an earlier session must land on someone available now.
- **Offline / deactivation rebalance** — moving work off someone who isn't there
  is the entire point. The departing agent is excluded from the candidate pool
  so it can't bounce straight back.

**Every automated assignment goes through `assignConversation`.** Same CAS, same
status side-effects (assign-to-closed reopens to `pending`; assignment never
sets `open`), same `conversation.assigned` event. Downstream — the inbox frame,
the audit timeline, analytics, workflow triggers, outbound webhooks — cannot
tell an automated assignment from a manual one, and that's the point.

**Nothing throws.** Every degenerate case resolves to a decision with a reason:
no eligible members, everyone at capacity, a policy pointing at someone who left,
corrupt rule JSON. The worst outcome is the conversation sitting in the visible
Unassigned queue.

**The offline sweep does nothing when presence is unknown.** `getOnlineUserIds`
returns null in a process with no socket visibility; treating that as "everyone
is offline" would reassign the entire inbox after a restart. (Note the engine's
*eligibility* tiers do the opposite and fail open — there the null reading would
stop routing entirely, which is the worse error.)

---

## Campaign assignment

A broadcast asks a different question: not "who's free right now" but "divide
these 10,000 replies the way I said". So the draw happens **once**, when the
`BroadcastRecipient` rows are built, and is stored on the row.

**The draw is applied on FIRST REPLY, not on send** (`assignmentTrigger`,
default `on_reply`). This is the part that's easy to get wrong: a campaign is
overwhelmingly one-way — send 10,000 templates and a few hundred people answer.
Assigning every recipient at send time would drop ~9,700 conversations nobody
will ever respond to onto agents' plates, and those conversations are *exactly*
what capacity limits and least-busy routing are measured against. Ali would look
"full" because of a campaign he has nothing to do. The split is still decided up
front, so "50 to Ali" stays exact — it just lands on the 50 who engage.

`assignmentTrigger: "on_send"` restores immediate assignment, for outreach where
someone is expected to follow up on the message itself rather than answer a
reply.

The reply hook rides the existing attribution path
(`lib/broadcast-attribution.ts` → `lib/assignment/campaign-reply.ts`), so it
inherits the same "first reply wins" CAS and the same direct-quote-then-window
credit rule. **And it survives the AI**: if the assistant answers the reply, no
human is assigned yet — but the drawn owner is remembered, and
`assignByPolicy` consults it on the escalation path, so when the AI does hand
off, the thread lands on the person the admin drew it for rather than being
re-routed generically.

| Mode | Behavior |
|---|---|
| `none` *(default)* | Don't touch assignment. |
| `fixed` | Everything to one person. |
| `split_counts` | Literal: "first 50 to Ali, next 10 to Sara". Leftovers follow `assignmentLeftover`. |
| `split_percent` | Proportional across the whole audience, apportioned by largest remainder so the parts sum **exactly**. |
| `policy` | Spread across a policy's members using its shares. |

| Trigger | Behavior |
|---|---|
| `on_reply` *(default)* | Applied when the customer first replies. |
| `on_send` | Applied immediately after a successful send. |

Three properties fall out of drawing up front, and all three are why it isn't
done per-send:

- **Exact** — "50 and 10" means 50 and 10. A live draw could never promise that.
- **Idempotent** — a resumed or retried campaign reuses the draw instead of
  redistributing.
- **Cheap** — one policy read per campaign instead of 100,000.

Shares are **interleaved**, not blocked, so any prefix of the audience is already
proportional — a campaign paused halfway hasn't given everything to the first
agent.

In `on_send` mode the assignee is applied **after a successful send**, for the
same reason the closed→pending reopen is deferred: a campaign that failed to
deliver must not put work on someone's plate. Either way, campaign assignment
respects `assignmentOverwrite` (default false), so a blast never takes a live
support thread from the agent handling it.

Presence and capacity are deliberately **not** applied to campaign planning —
these replies arrive over hours, so who has a socket open at planning time says
nothing about who should own a reply that lands tomorrow morning.

---

## Who can see what, and who can assign

Two access rules ship alongside the routing engine.

**Conversation visibility** (`Team.agentConversationVisibility`, default `team`).
Set it to `assigned` and role `agent` sees only the conversations assigned to
them — in the list, in counts, in search, in the AI panel, in call history, in
media, and over the socket. admin / manager / superAdmin are never restricted.

The rules live in ONE module, `apps/api/src/lib/conversations/visibility.ts`,
and everything composes them:

| Surface | Mechanism |
|---|---|
| Conversation list / counts / unread | `visibilityWhere()` ANDed into the outer `where` |
| Any `:id` route on `ConversationsController` | `@ScopedByConversation()` guard, class-level — covers routes added later |
| Media, calls, flags | `conversationRelationWhere()` on the message/call/flag query |
| Global search (messages, notes, contacts) | `visibility` option on each search |
| Realtime | ROOM MEMBERSHIP: a restricted agent never joins `team:<id>`; conversation frames target the team room **plus** the assignee's `user:` room in one emit (socket.io de-dupes) |
| `subscribe:conversation` | ownership query includes the visibility clause |
| `/v1` external API | **Not applicable** — an API key is a team-level credential with no user identity |

**Scoping keys on the CURRENT assignee, never on message authorship.** That is
the whole reason a handover works: move a thread from Ali to Sara and Sara
immediately sees its ENTIRE history — every message, internal note, call and
activity event, including Ali's — and simply continues. Ali loses access at the
same moment. Filtering by authorship would have handed Sara a thread full of
holes.

Turning the setting off is instant for new requests; anyone already signed in
picks it up within ~15s (session cache), and sockets re-evaluate room
membership on their next connect.

**Assigning to others** (`conversations:assignOthers`, admin/manager by
default). Anyone can always claim a conversation for themselves or release
their own. Handing work to a TEAMMATE is a supervisor action. The check is
inline rather than a route decorator because it depends on the body — "assign
to me" and "assign to Sara" hit the same endpoint — and the UI hides what the
viewer can't do rather than offering it and rejecting the click.

---

## Where it's wired

| Surface | Entry point |
|---|---|
| Settings UI | `apps/web/src/features/settings/assignment/` → `/settings/assignment` |
| Internal API | `apps/api/src/assignment/` (`/api/workspace/assignment`) |
| External API | `/v1/assignment/*` + `POST /v1/conversations/:id/assign` with `autoAssign` — see [organization-api.md](organization-api.md) |
| Inbound routing | `apps/api/src/assignment/auto-assign.subscriber.ts` |
| AI escalation | `apps/api/src/lib/ai/orchestrator.ts` |
| Legacy n8n handoff | `apps/api/src/lib/conversations/handoff.ts` |
| Workflow step | `apps/api/src/lib/workflows/steps/assign-to.ts` (`round_robin` / `policy` modes) |
| Campaigns | `apps/api/src/lib/assignment/broadcast-plan.ts` → `lib/broadcast-runner.ts` |
| Rebalance | `apps/api/src/lib/sweepers/assignment-rebalance.ts` |

Coverage: `tests/e2e/workflows-events/assignment-select.spec.ts` (46 pure
scenarios) plus the pre-existing `round-robin.spec.ts`, which now runs through
the new engine and doubles as the proof that the default policy reproduces the
old behavior exactly.
