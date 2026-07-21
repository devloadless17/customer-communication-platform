# Event Model

Deep-dive companion to [CLAUDE.md](../CLAUDE.md).

**Events are notifications, not business logic.** A domain event announces that a state change already committed. Subscribers *react* — they never own the mutation, never mutate the same row that triggered them in a way that re-triggers themselves, and never assume ordering beyond the priority tiers below. Every event has one owner (the publisher) and one purpose.

---

## 1. The bus (`apps/api/src/lib/events/bus.ts`)

Framework-agnostic engine in `lib/events/bus.ts`; the NestJS seam is `EventBus` in `apps/api/src/events/event-bus.service.ts` (a thin `@Injectable()` wrapper — split from the module file to break a TDZ/circular import with `OutboxDrainerService`).

`publish<K>(event)` is a **two-tier dispatch**:

- **CRITICAL tier — `SubscriberPriority.REALTIME = 0`**: the single socket-fanout subscriber fires *fire-and-forget* at the head, so the realtime frame is on the wire before any downstream subscriber runs. `publish()` awaits that realtime promise **just-in-time** (right before writing the outbox row) so a realtime throw still lands in `lastError`.
- **BACKGROUND tier — detached from the HTTP response**: `runBackgroundTier` iterates the rest sequentially in priority order. The HTTP handler that called `await publish(...)` returns as soon as the outbox row is written; analytics/dispatch/webhooks add no response latency.

### Priorities are explicit and load-bearing (NOT registration order)
```
REALTIME:           0
AUDIT:             10
ANALYTICS:         20
  (auto-assign:    25)   ← AutoAssignSubscriber, on message.received only
WORKFLOW_DISPATCH: 30
OUTBOUND_WEBHOOKS: 50
DEFAULT:          100
```
Order matters because `workflow-dispatch` and `outbound-webhooks` re-read state that `analytics` writes (e.g. `closedCategory`, `firstResponseAt`, counters).

`AutoAssignSubscriber` (assignment routing, [docs/assignment.md](assignment.md)) sits at **25** — between analytics and workflow dispatch — for two reasons: the counters it may read are already written, and a `message_received` workflow (plus any `conversation_assigned` workflow) observes the routing decision instead of racing it. It publishes `conversation.assigned` through the shared mutation, so its own fanout follows the normal tier order. `subscribe()` keeps each event's handler list sorted ascending; per-subscriber try/catch isolates failures.

> Historical note: tier `40` (`WEB_CACHE_REVALIDATE`) was removed 2026-06-01 — cross-process cache revalidation now goes through the HTTP `/api/internal/revalidate` bridge, not a bus tier.

---

## 2. `DomainEvent` taxonomy (`packages/shared/src/events/types.ts`)

- `DomainEventMap` — a keyed interface mapping each event-type string to its payload interface.
- `DomainEventType = keyof DomainEventMap`; `DomainEventOf<K> = { type: K } & DomainEventMap[K]`; `DomainEvent` = the discriminated union.

Every payload carries `teamId` and **enough data for subscribers to react without a DB re-read** (except where post-mutation state is genuinely needed). Ingest also computes `SessionKind = "first_ever" | "returning_session" | "continued"`.

### Event names (current)
- **messages**: `message.received`, `message.sent`, `message.send_failed`, `message.status_changed`, `message.reaction_changed`, `message.media_ready`
- **conversations**: `conversation.assigned`, `conversation.status_changed`, `conversation.ai_changed`, `conversation.deleted`, `conversation.read`
- **contacts**: `contact.created`, `contact.updated`, `contact.tag_changed`, `contact.lifecycle_changed`, `contact.bulk_updated`, `contact.deleted`
- **notes**: `note.created`, `note.deleted`
- **broadcasts**: `broadcast.status_changed`, `broadcast.progress`, `broadcast.recipient_message_sent`, `broadcast.conversation_reopened`
- **team channels**: `team_channel.message_created` / `.message_edited` / `.message_deleted` / `.reaction_changed` / `.pin_changed` / `.read` / `.members_changed` / `.thread_reply_count_changed`
- **users/team**: `user.profile_updated`, `user.availability_changed`, `team.catalog_changed`, `team.renamed`
  - `user.availability_changed` carries the **effective** status/message plus `source` (`manual` · `admin` · `schedule`), `until` (when a manual pick expires back to the schedule) and `manual` (the user's own pick — read only by their own availability picker, so an off-shift agent's note box doesn't fill with the schedule's text). Three publishers, one writer: `lib/availability/apply.ts` (self route, admin route, work-hours sweeper).
- **webhooks**: `webhook.subscription_disabled`, `webhook.subscription_recovered`
- **calling**: `call.incoming`, `call.ringing_out`, `call.answered_by_agent`, `call.ended`, `call.missed`, `call.rejected`, `call.failed`, `call.sdp_offer`

### Naming standard
`<entity>.<past_tense_change>`, snake_case segments, dotted. New events are additive; a name is a contract — don't repurpose one. Add the payload interface to `DomainEventMap` and the compiler forces you to handle it in the fanout rule table.

---

## 3. Subscribers

Four of the five register centrally in `apps/api/src/workflows/workflow-subscribers.service.ts` (`onModuleInit`), each declaring its own priority tier; unsubscribes captured for clean multi-lifecycle re-init. The fifth (outbound-webhooks) self-registers from its own module (it lives next to its BullMQ worker).

1. **socket-fanout** — `apps/api/src/realtime/realtime-fanout.service.ts` (`REALTIME`) iterates `FANOUT_RULES` (see [realtime.md](realtime.md)).
2. **audit** — `apps/api/src/lib/events/subscribers/audit.ts` (`AUDIT`) writes `ConversationEvent` rows via `recordConversationEvent`. DB-only — the timeline is fetched on demand, never socket-fanned.
3. **analytics** — `apps/api/src/lib/events/subscribers/analytics.ts` (`ANALYTICS`) updates conversation analytics columns.
4. **workflow-dispatch** — `apps/api/src/lib/events/subscribers/workflow-dispatch.ts` (`WORKFLOW_DISPATCH`) translates domain events → workflow triggers via `dispatch()`.
5. **outbound-webhooks** — `apps/api/src/outbound-webhooks/outbound-webhooks.subscriber.ts` (`OUTBOUND_WEBHOOKS`) self-registers from its own module.

### Opt-out flags
- **`suppressSocketFanout`** (on `ContactUpdatedEvent` / `ContactCreatedEvent`) — honored ONLY inside the fanout rule; bulk/import paths set it so one coalesced `contact.bulk_updated` frame replaces N per-row frames. Audit/workflow/webhook subscribers still see the per-row event.
- **`null` fanout rule** — no socket subscription for that event; the narrow event still drives webhook routing.
- **`silent` / `skipOutboundWebhook`** — `workflow-dispatch` skips chain-dispatch when `e.silent` (workflow-step-driven, loop safety); `outbound-webhooks` gates delivery on `skipOutboundWebhook ?? silent ?? false`. The split lets a workflow-step event be loop-safe yet still partner-visible.

### The broadcast-exclusion INVARIANT
**Never subscribe audit or workflow-dispatch to `broadcast.*`.** `broadcast.recipient_message_sent` / `broadcast.conversation_reopened` exist precisely so a 1k-recipient broadcast doesn't write 1k audit rows or fire 1k workflow runs. Only socket-fanout listens (conversation-scoped, per [realtime.md](realtime.md)). This invariant is restated in the header of both `audit.ts` and `workflow-dispatch.ts`.

---

## 4. Durable transactional outbox

For events that must survive a crash between the DB write and the fanout:

- `publishInTx(tx, event)` writes an `OutboundEvent` row atomically with the entity write.
- `OutboxDrainerService` (`apps/api/src/events/outbox-drainer.service.ts`) polls, claims batches via `SELECT … FOR UPDATE SKIP LOCKED` (partial index `OutboundEvent_drainer_pending_idx`), dispatches through `EventBus.dispatchOutboxRow` (which awaits ALL tiers with a per-row `DISPATCH_TIMEOUT_MS = 30s` and returns an aggregated error string so the drainer can stamp `lastError`), loops up to `MAX_DRAINS_PER_TICK`, and self-heals a wedged tick via a no-progress watchdog (`WATCHDOG_MS = 180s`, checked on a 30s interval).
- `kickOutbox()` / `setOutboxKickHandler` give an immediate-drain hook after a tx-context publish.

Idempotency & ordering expectations: consumers must tolerate at-least-once redelivery (the drainer can re-dispatch a claimed-but-uncommitted row). Ordering is guaranteed only within the priority tiers of a single `publish`, not across events — never assume event A's subscribers ran before event B's.


### `message.flag_changed`

Published by `lib/message-flags/mutations.ts` — the ONLY publisher — whenever a
triage flag is added, updated, reopened, resolved or removed. Carries the flag,
the conversation id and the post-write `openFlagCount` so subscribers need no
re-read. Audit keys on the TRANSITION (`action`), not the post-state. A
re-raise that carries no new context publishes nothing at all, so an
at-least-once replay can't fan a frame or an outbound webhook for a no-op.
