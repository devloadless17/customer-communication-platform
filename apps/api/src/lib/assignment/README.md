# Assignment engine

Who takes a conversation, and why.

Before this existed, "who" was one hardcoded algorithm (least-busy with
online-first tiering) in `lib/conversations/round-robin.ts`, shared by the AI
handoff and the workflow `assign_to` step. Everything else — new conversations,
reopened threads, campaigns, agents going offline — had no answer at all.

## Layers

| File | Responsibility | Pure? |
|---|---|---|
| `select.ts` | The pick: strategy, eligibility, capacity, overflow | ✅ no IO |
| `rules.ts` | Which policy handles this conversation (first match wins) | ✅ no IO |
| `broadcast-plan.ts` | Apportion a campaign audience across members | ✅ except the pool read |
| `pool.ts` | A policy's durable member set, without presence/capacity | DB read |
| `resolve.ts` | Load inputs → `selectAssignee` → commit cursor/counters | DB |
| `apply.ts` | Resolve **and write**, with the race rules | DB + events |

Everything that decides anything is pure and unit-tested
(`tests/e2e/workflows-events/assignment-select.spec.ts`, 46 scenarios). The DB
layers only fetch, call, and persist.

**`apply.assignByPolicy` is the entry point for every automated assignment in
the product.** It always writes through `lib/conversations/mutations.assignConversation`,
so an automated assignment is indistinguishable downstream from a manual one:
same CAS, same status side-effects, same `conversation.assigned` event, same
realtime frame / audit row / analytics / outbound webhook.

## The three race rules (solved once, in `apply.ts`)

1. **Never steal from a human.** `onlyIfUnassigned` (default true for every
   automated caller) means automation only ever fills an EMPTY slot. This is
   also what makes the whole surface idempotent under at-least-once event
   delivery — a redelivered webhook can't reassign anything.
2. **Degrade, don't drop.** A member deactivated between the pick and the write
   is excluded and the pick retried, bounded to 3 attempts.
3. **Lose races gracefully.** On a CAS conflict we re-read: if a human took it,
   stop; if it's still free, try again with a fresh decision.

The two deliberate exceptions to rule 1, both admin-configured: the AI handoff
(an escalation is a re-route by definition) and the offline/deactivation
rebalance (moving work off someone who isn't there is the entire point).

## Callers

| Trigger | Caller | Source | Default |
|---|---|---|---|
| First inbound on a new conversation | `assignment/auto-assign.subscriber.ts` | `inbound` | off |
| Inbound on an unassigned/reopened thread | same | `reopen` | off |
| Built-in AI escalates | `lib/ai/orchestrator.ts` | `ai_handoff` | on |
| Legacy n8n autopilot handoff | `lib/conversations/handoff.ts` | `ai_handoff` | per `Team.aiHandoffAction` |
| Workflow `assign_to` (auto-route / policy) | `lib/workflows/steps/assign-to.ts` | `workflow` | — |
| `/v1` assign with `autoAssign: true` | `external/v1/…messaging.service.ts` | `api` | — |
| Campaign replies | `lib/broadcast-runner.ts` (drawn in `broadcast-plan.ts`) | `broadcast` | off |
| Agent goes offline | `lib/sweepers/assignment-rebalance.ts` | `rebalance` | off |
| Teammate deactivated | `users.service.ts` → `rebalanceDeactivatedUser` | `rebalance` | **on** |

Everything ships OFF except deactivation rebalance, and every team's seeded
default policy reproduces the old hardcoded behavior exactly — so enabling this
feature changed nothing until an admin opted in.

## Strategies

- `least_busy` (default) — fewest open conversations, rotation as the tie-break.
  This *is* the historical algorithm.
- `round_robin` — strict turn-taking, load ignored.
- `weighted` — deficit round-robin on `served / weight`. Deterministic and
  **exact**: 50/20 over 70 assignments is 50 and 20, not "roughly".
- `fixed` — one person.
- `manual` — never auto-assigns (the supported way to say "escalate but leave it
  in the queue").

## Things that look like bugs but aren't

- **Presence-based eligibility fails OPEN when `getOnlineUserIds` returns null.**
  A process with no socket visibility must not conclude the whole team is
  offline and stop routing. The offline rebalance sweeper does the opposite —
  it does *nothing* when presence is unknown, because there the null reading
  would cause reassignments rather than prevent them.
- **Working hours aren't referenced anywhere here.** They already fold into
  `User.availabilityStatus`, which the availability tiers read. One source of
  truth, no second schedule evaluation.
- **Campaign planning ignores presence and capacity** (`pool.ts`). A campaign's
  replies arrive over hours; who has a socket open at planning time says nothing
  about who should own a reply that lands tomorrow.
- **Weighted `served` is never renormalized.** Ratios are scale-free and the
  column is an Int4 — the only real hazard is a member added later at
  `served = 0` vacuuming up traffic, and that's handled at write time
  (`AssignmentService.syncMembers` seeds them at the pool's current ratio).
- **In-flight reservations** in `resolve.ts` add a short-lived local +1 per pick
  so a burst of simultaneous inbounds doesn't all read the same `openCount` and
  stampede one agent. Single-process by design; moving it to Redis is the named
  cliff at a second app instance (CLAUDE.md §16).

## Scaling cliffs

- **Second app instance** → the reservation map and the 15s config cache must
  move to Redis, and presence already needs the Socket.io Redis adapter.
- **50–200 tenants** → the config cache is grow-only (one small entry per team);
  add eviction along with the other grow-only caches.
- **Campaigns beyond 100k** → `buildBroadcastAssignmentPlan` materializes one
  array entry per recipient. At the current ceiling that's a few MB inside a
  worker that already stages the full recipient list; beyond it, stream the plan
  per chunk instead.
