# Architecture Re-Audit (Pass 3) — Layering & Isolation Lens — 2026-05-25

**Scope:** Third full-system audit today, run from scratch through a **layering &
isolation lens** (the focus of this request): does each layer stay in its lane,
are side effects owned + bounded, can any flow recurse / storm / starve another?

**Method:** Four parallel deep-dives (layering/coupling, hot-path performance,
workflow/trigger isolation, queue/cache/frontend-sync), each anchored to real
`file:line`, plus direct hand-verification of every flagged finding before
write-up. Reconciled against pass 1 ([…2026-05-25.md]) and pass 2
([…2026-05-25-pass2.md]).

**No code changed.** Read-only audit + a real per-layer ownership map.

---

## TL;DR

The layered architecture is **clean and genuinely isolated** — this pass
confirms the chat hot path is decoupled from all slow work, no layer contains
logic that belongs elsewhere, and automations cannot recurse or storm.

This lens (queue fairness + layer coupling, which passes 1–2 didn't center on)
surfaced **two genuine NEW findings** — both *per-team fairness* gaps where one
queue lacks the isolation the workflow worker already has. Neither touches chat
speed; both are the same small fix (replicate an existing pattern).

| # | Severity | Finding | Chat impact? |
|---|---|---|---|
| P1 | **MEDIUM** | Broadcast runner has no per-team concurrency cap — a 10k-recipient broadcast pins all 5 in-process lanes; a second team's broadcast waits | **No** (broadcasts run in-process, separate from interactive sends) |
| P2 | **MEDIUM** | Outbound webhook delivery worker has no per-team cap — one team's slow/broken partner endpoint can tie up all delivery workers | **No** (delivery is post-emit, off the chat path) |

Everything else: **CLEAN / exemplary.** The layering question the request asked —
"is each layer isolated so a change in one doesn't break the whole app?" — answers
**yes**, with evidence below.

---

## Part 1 — The layered flow holds (verified)

Requested target flow: `External → Webhook/API → Use-case → Domain → Persistence
→ Event → Realtime`. Verified intact at every boundary:

**Websocket layer = zero business logic.** Every `@SubscribeMessage` handler in
[realtime.gateway.ts] is join/leave-room + typing/presence (read-only). Every
fanout-rules handler is a pure `emitter.emitToTeam(...)` — **none call
`bus.publish()` or touch the DB** (verified by grep). The socket layer translates
domain events → wire frames and nothing more. The only direct `emitToTeam`
bypassing the bus is the dev-emit controller, guarded by `NODE_ENV !== production`
+ `ENABLE_DEV_TOOLS=1`.

**Domain logic is centralized, not duplicated.** The assign/status rules
(CAS, status-flip, gated publish) live in ONE framework-agnostic place,
[lib/conversations/mutations.ts] (`assignConversation` / `setConversationStatus`,
with `db` + `publish` injected). **All four callers go through it** — the UI
service, the /v1 API service, and both workflow steps (`assign-to`, `set-status`).
No caller re-implements the rule. This is the layering improvement that landed
since pass 2, and it's exemplary: a partner POST, an agent click, and a workflow
step now produce the *identical* end state, by construction.

**Use-case vs domain boundary is clean.** Controllers are thin
(parse → call service → return); no business logic, no DB, no publish in
controllers. Services **do not call each other** — they publish events and let
subscribers react. The one `forwardRef` (SendWorkerService ↔ MessagesService) is a
documented DI-lifecycle break, not a logic chain.

**Integrations are isolated behind the provider interface.** App code only ever
touches `getProviderBinding(channel)` + the `MessagingProvider` interface; Meta's
API shape is confined to `lib/providers/meta.ts`. The only Meta import outside the
provider is `normalizeMetaSendError` (error classification), which is acceptable.
Adding a channel = register a binding, zero app-code change.

**Events published at the correct layer.** Domain events originate in the
domain/use-case layer (mutations.ts, the services, ingest), never leaked into
controllers or the socket layer. One central in-process bus; subscriber order
enforced by `SubscriberPriority` (sorted insertion, not import order).

**No circular dependencies.** `lib/` never imports up from `apps/api/src`; no
feature-module import cycle. Module graph is acyclic.

**Verdict:** the architecture follows the requested layered flow. A change in one
layer is contained — exactly the property the request prioritized.

---

## Part 2 — Chat hot path is decoupled from slow work (verified)

The owner's #1 concern: send/receive (text/image/video/file/audio) must never be
slowed by workflows, integrations, queues, or event chains. **Verified SAFE.**

- **Realtime fires first, fire-and-forget.** `SubscriberPriority.REALTIME = 0` is
  dispatched *before* the awaited slow chain ([bus.ts] `runSubscribers`) — the
  socket frame is queued before audit/analytics/workflow/webhook subscribers run.
  A slow workflow or a slow partner webhook **cannot** delay message display.
- **Outbound send is off the HTTP path.** The send POST does synchronous preflight
  (~5-10ms) then enqueues to the `message-sends` BullMQ queue and returns
  `{ queued, clientTempId }`. The Meta call runs in the worker; the optimistic
  bubble paints instantly; the server frame swaps by `clientTempId`. Workflow
  dispatch + webhook delivery happen *after* the socket emit.
- **Media is 2-phase inbound** — bubble paints `<100ms` with a shimmer, the binary
  fetch+upload runs in the background, `message:media_ready` swaps it in. Outbound
  media uploads Meta + blob **in parallel** (max, not sum). ffmpeg poster gen is
  best-effort background, bounded, failure = no-op.
- **No event-loop hazards on the path.** `rawPayload` (5-20KB Meta JSON) is
  stripped before the wire ([fanout-rules.ts] `stripForWire`); frames are
  ~400-800 bytes; ingest + media download are bounded-concurrency (8 / 4 lanes);
  the webhook-enrichment lookups are batched `findMany({ id: { in } })` (no N+1).
- **Broadcast storm guard** — `broadcast.recipient_message_sent` is scoped to the
  conversation room, not team-wide, so a 10k broadcast doesn't fan ~625 frames/sec
  to every agent's tab.

The only inherent latency is the **100ms outbox drainer poll** for tx-context
events (inbound display, contact.created) — intentional (DB-load tradeoff),
well under the ~500ms human-perceptible threshold, and it does **not** gate the
synchronous bubble emit. Acceptable.

**Verdict:** "instant / smooth / flicker-free" holds, including under concurrency.

---

## Part 3 — Automations are isolated & cannot recurse (verified)

- **Self-trigger prevention:** every mutating step publishes `silent: true`, and
  workflow-dispatch returns early on `silent` ([workflow-dispatch.ts] — verified
  both sides). No mutating step is missing the flag.
- **Workflow→workflow:** `TRIGGER_DEPTH_MAX = 8`, depth stamped on child runs —
  bounds A→B→A and longer cycles.
- **Runaway:** per-run ceiling 100 (counted by distinct stepId so retries don't
  burn it), jump counter, per-pickup ceiling — all bounded.
- **Side-effect ownership:** assign/status steps go through the shared
  `mutations.ts`; send steps go through `sendTextInternal` / `sendTemplateInternal`
  (centralized). Tag/field/lifecycle steps hand-roll DB+publish but follow the
  *identical* CAS+publish+silent pattern — minor future-DRY opportunity, **not** an
  isolation hazard (noted, not a finding).
- **Retry isolation:** the orphan-detect / `in_progress` journal in [runner.ts]
  presumes a crashed side effect *fired* and advances with `skipped_after_crash`
  rather than re-running — so a BullMQ retry can't double-send to Meta. Bounded 3
  attempts.
- **Wait/ask isolation:** waiting runs hold no locks, expire via sweepers,
  stale-resume guard prevents a dangling timeout job from double-waking a run.
- **Per-team fairness (the model):** the workflow worker caps concurrency per team
  (`WORKFLOW_PER_TEAM_CONCURRENCY=2`, `moveToDelayed` defer) so one team's
  1k-contact bulk-enroll can't starve another team. **This is the exemplary
  pattern P1/P2 below should copy.**

**Verdict:** workflows are isolated, bounded, predictable — no recursion, no storm.

---

## Part 4 — Frontend sync & cache are stable (verified)

- **No backend feedback loop:** no socket handler fires a request that re-emits the
  same event. `dispatchLocalSocketEvent` is purely local. Optimistic dispatch never
  round-trips to double-apply.
- **Optimistic swap is idempotent:** server frame matched by `clientTempId`, swap
  is one-to-one, a second frame (webhook retry) is a no-op (row no longer pending).
  `blob:` URLs preserved across swap → no flicker. 30s stuck-watchdog present.
- **List/cache = partial patch, not refetch:** reducers `findIndex` + identity-bail
  on no-change; the LRU thread cache no-ops when the reducer returns prev. Unread is
  **absolute overwrite** (not additive) gated on a strict `>` recency guard — replayed
  frames (Socket.io recovery) are no-ops, zero drift.
- **Reconnect converges cleanly:** jitter (0-1500ms) breaks the post-deploy
  thundering herd, tab-hidden defers the refetch, reconcile is idempotent
  (dedup by externalId/clientTempId).

**Verdict:** frontend realtime state is predictable, flicker-free, no storms.

---

## Part 5 — Genuine NEW findings (hand-verified)

### P1 — MEDIUM: Broadcast runner has no per-team concurrency fairness

**Verified:** [lib/broadcast-runner.ts] runs **in-process** (`setImmediate`,
`SEND_CONCURRENCY = 5` lanes, `MAX_RECIPIENTS_IN_PROCESS = 10_000`) with **no
per-team cap**. A 10k-recipient broadcast at ~25 msg/sec pins those 5 lanes for
~6+ minutes; a second team launching a broadcast in that window waits behind it.

**Severity is MEDIUM, not HIGH — and NOT a chat risk.** I verified the broadcast
path is **fully separate** from interactive sends: broadcasts call
`provider.sendTemplate` directly in-process, while agent sends go through the
independent `message-sends` BullMQ queue. So a running broadcast does **not** slow
an agent typing a reply. The real exposure is (a) broadcast-vs-broadcast across
teams, and (b) memory — N concurrent 10k broadcasts each hold recipient state on
the event loop.

**Fix (replicate the workflow worker's proven pattern):** add a per-team active
counter + cap to the broadcast lane loop, or move broadcasts onto a BullMQ tier
with the same `moveToDelayed` per-team defer the workflow worker uses
([worker.ts] `perTeamConcurrency`). The pattern already exists and is exemplary —
this is copying it, not inventing. The 10k in-process ceiling already exists as a
hard backstop, so this is a fairness improvement, not a stability fix.

> Worth doing before you onboard multiple active teams that both broadcast. At one
> pilot customer it's latent — flagging so it's a conscious "later," not a surprise.

### P2 — MEDIUM: Outbound webhook delivery has no per-team fairness

**Verified:** [lib/outbound-webhooks/worker.ts] runs at a **global** concurrency
with no per-team cap. A single team's slow or broken partner endpoint (DNS
timeout, 10s hangs) can occupy all delivery workers, delaying *other* teams'
webhook deliveries behind it.

**Severity MEDIUM, NOT a chat risk:** delivery runs at `SubscriberPriority`
OUTBOUND_WEBHOOKS (last), entirely after the socket emit — a backed-up delivery
queue never touches message display or send. The circuit breaker (auto-disable
after 20 consecutive failures) eventually quarantines a dead endpoint, but the
window before it trips can still starve cross-team deliveries. Bounded 4 attempts
with 30s→30m backoff already prevents a single endpoint from spinning hot.

**Fix:** same per-team concurrency clamp as P1/the workflow worker. For multi-
*process* fairness this needs a Redis-backed counter (the workflow worker's
in-process Map is single-process); at current single-process scale an in-process
Map matches the existing pattern exactly.

---

## Part 6 — What's exemplary (keep, don't touch)

- **`mutations.ts` shared domain layer** — one rule, four callers, no drift.
- **Workflow per-team concurrency** ([worker.ts]) — the fairness model to copy.
- **`silent` two-layer guard** — step sets it + dispatcher checks it; forgetting
  one breaks both, so it can't silently rot.
- **Orphan-detect retry** — "presume the side effect fired, advance" beats
  double-sending to Meta.
- **Conversation-room-scoped broadcast fanout** + **coalesced bulk_updated** —
  the storm guards.
- **Thread reducers + identity-bail**, wired to both the live hook and the LRU
  cache — single reconciliation source, no duplicate-patch bugs.
- **Optimistic `blob:` URL preservation** — cheap, high-impact flicker fix.

---

## Part 7 — Locked decisions (NOT findings)

In-process event bus (no Redis pub/sub) · no Redis Socket.io adapter yet · BullMQ
in-process (`RUN_WORKER_INLINE`) · no React Query / Zustand · channel-not-provider ·
contacts siloed per channel · message-sends global concurrency (jobs are short, ~200ms
Meta call — low starvation risk, unlike the long-running broadcast/webhook paths). All
intentional; all correct at pilot scale; all have documented scaling triggers.

---

## Part 8 — Suggested action order

Both findings are *fairness under multi-team load*, not pilot blockers, and both
are the **same fix** (replicate the workflow worker's per-team cap):

1. **P1 (broadcast per-team cap)** — slightly higher value (10k broadcasts are the
   bigger resource hog). Do when a 2nd broadcasting team onboards.
2. **P2 (webhook delivery per-team cap)** — pairs naturally; same pattern.

Both can wait until you have multiple actively-broadcasting / integration-heavy
teams. At one pilot customer, neither fires.

---

*Pass 3 verdict: layering is clean and genuinely isolated; the chat hot path is
decoupled from all slow work; automations can't recurse or storm; frontend sync is
stable. Two real per-team-fairness gaps (P1 broadcast, P2 webhook delivery) — both
MEDIUM, neither affects chat, both solved by copying the workflow worker's existing
pattern. Over-tinkering remains the dominant risk: the SAFE list is large and
should stay untouched.*
